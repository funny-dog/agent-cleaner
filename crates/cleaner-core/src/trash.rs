use crate::fs_safe::{assert_safe_child, get_file_size, remove_path, safe_move, safe_mtime_ms};
use crate::types::{
    BackupEntry, BackupRestoreReport, CleanerContext, PruneBackupsReport, PruneTrashReport,
    RestoreReport, ScanItem, TrashItem, TrashManifest,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

/// Convert any absolute or platform-specific path (Unix `/...`, Windows `C:\...`, `\\?\C:\...`,
/// or UNC `\\server\share\...`) into a safe relative `PathBuf` without root/drive prefixes.
pub fn sanitize_relative_path(raw: &str) -> PathBuf {
    let mut normalized = raw.replace('\\', "/");
    if let Some(rest) = normalized
        .strip_prefix("//?/UNC/")
        .or_else(|| normalized.strip_prefix("//?/unc/"))
    {
        normalized = rest.to_string();
    } else if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_string();
    } else if let Some(rest) = normalized.strip_prefix("//") {
        normalized = rest.to_string();
    }

    let mut out = PathBuf::new();
    for (idx, seg) in normalized.split('/').enumerate() {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        let cleaned = if idx == 0
            && seg.len() == 2
            && seg.as_bytes()[0].is_ascii_alphabetic()
            && seg.as_bytes()[1] == b':'
        {
            seg[..1].to_string()
        } else {
            seg.replace(':', "_")
        };
        if !cleaned.is_empty() {
            out.push(cleaned);
        }
    }

    // Double-check via `Path::components` to ensure no prefix/root/parent leaks.
    let mut safe = PathBuf::new();
    for comp in out.components() {
        if let Component::Normal(part) = comp {
            safe.push(part);
        }
    }
    if safe.as_os_str().is_empty() {
        safe.push("item");
    }
    safe
}

const MS_PER_DAY: u64 = 86_400_000;
const BACKUP_META_FILE: &str = ".backup-meta.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMeta {
    id: String,
    original_path: String,
    backup_path: String,
    size_bytes: u64,
    created_at_ms: u64,
}

pub fn begin_batch(ctx: &CleanerContext) -> Result<String> {
    let batch_id = Uuid::new_v4().to_string();
    let batch_dir = ctx.trash_root().join(&batch_id);
    fs::create_dir_all(&batch_dir)?;
    Ok(batch_id)
}

pub fn move_to_trash(
    ctx: &CleanerContext,
    batch_id: &str,
    items: &[ScanItem],
) -> Result<(TrashManifest, Vec<String>)> {
    let batch_dir = ctx.trash_root().join(batch_id);
    fs::create_dir_all(&batch_dir)?;

    let mut trash_items = Vec::new();
    let mut errors = Vec::new();
    let now = ctx.now();

    for item in items {
        let item_id = Uuid::new_v4().to_string();
        let rel_original = sanitize_relative_path(&item.path);
        let trash_relative = Path::new(&item_id).join(rel_original);
        let trash_abs = batch_dir.join(&trash_relative);

        match safe_move(Path::new(&item.path), &trash_abs) {
            Ok(()) => {
                trash_items.push(TrashItem {
                    id: item_id,
                    original_path: item.path.clone(),
                    trash_relative_path: trash_relative.to_string_lossy().to_string(),
                    size_bytes: item.size_bytes,
                    agent: item.agent.clone(),
                    moved_at: now,
                });
            }
            Err(err) => {
                errors.push(format!("{}: {err}", item.path));
            }
        }
    }

    let total_bytes = trash_items.iter().map(|i| i.size_bytes).sum();
    let manifest = TrashManifest {
        id: Uuid::new_v4().to_string(),
        batch_id: batch_id.to_string(),
        timestamp: now,
        items: trash_items,
        total_bytes,
    };

    let manifest_path = batch_dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&manifest_path, json)?;

    Ok((manifest, errors))
}

pub fn list_batches(ctx: &CleanerContext) -> Vec<TrashManifest> {
    let trash_root = ctx.trash_root();
    let Ok(entries) = fs::read_dir(&trash_root) else {
        return Vec::new();
    };
    let mut manifests = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if let Ok(raw) = fs::read_to_string(&manifest_path) {
            if let Ok(parsed) = serde_json::from_str::<TrashManifest>(&raw) {
                manifests.push(parsed);
            }
        }
    }
    manifests.sort_by_key(|m| std::cmp::Reverse(m.timestamp));
    manifests
}

pub fn restore_batch(ctx: &CleanerContext, batch_id: &str) -> Result<RestoreReport> {
    let batch_dir = ctx.trash_root().join(batch_id);
    assert_safe_child(&ctx.trash_root(), &batch_dir)?;

    let manifest_path = batch_dir.join("manifest.json");
    let raw = fs::read_to_string(&manifest_path)
        .with_context(|| format!("Cannot read manifest for batch \"{batch_id}\""))?;
    let manifest: TrashManifest = serde_json::from_str(&raw)?;

    let mut restored = 0usize;
    let mut failed = Vec::new();

    for item in &manifest.items {
        let trash_abs = batch_dir.join(&item.trash_relative_path);
        let original = Path::new(&item.original_path);

        if original.exists() {
            failed.push(format!(
                "{} (already exists; remove manually before restoring)",
                item.original_path
            ));
            continue;
        }

        if !trash_abs.exists() {
            failed.push(format!(
                "{} (missing from trash archive)",
                item.original_path
            ));
            continue;
        }

        match safe_move(&trash_abs, original) {
            Ok(()) => restored += 1,
            Err(err) => failed.push(format!("{} ({err})", item.original_path)),
        }
    }

    Ok(RestoreReport {
        batch_id: batch_id.to_string(),
        restored,
        failed,
    })
}

pub fn purge_batch(ctx: &CleanerContext, batch_id: &str) -> Result<()> {
    let trash_root = ctx.trash_root();
    let batch_dir = trash_root.join(batch_id);
    assert_safe_child(&trash_root, &batch_dir)?;
    if batch_dir.exists() {
        remove_path(&batch_dir)?;
    }
    Ok(())
}

pub fn purge_all(ctx: &CleanerContext) -> Result<usize> {
    let batches = list_batches(ctx);
    let count = batches.len();
    for b in batches {
        purge_batch(ctx, &b.batch_id)?;
    }
    Ok(count)
}

/// Prune trash batches exceeding `max_age_days` or `max_size_mb` (keeping newest batches).
/// Passing `0` for either threshold disables that specific limit.
pub fn prune_trash(
    ctx: &CleanerContext,
    max_age_days: u64,
    max_size_mb: u64,
    exclude_batch_id: Option<&str>,
) -> Result<PruneTrashReport> {
    let batches = list_batches(ctx); // sorted newest-first
    if batches.is_empty() {
        return Ok(PruneTrashReport {
            pruned_batches: 0,
            freed_bytes: 0,
            pruned_batch_ids: Vec::new(),
        });
    }

    let now_ms = ctx.now();
    let max_age_ms = max_age_days.saturating_mul(MS_PER_DAY);
    let max_total_bytes = max_size_mb.saturating_mul(1024 * 1024);

    let mut to_prune: HashSet<String> = HashSet::new();
    let mut cumulative_bytes: u64 = 0;

    for b in &batches {
        if exclude_batch_id.is_some_and(|ex| ex == b.batch_id) {
            cumulative_bytes = cumulative_bytes.saturating_add(b.total_bytes);
            continue;
        }
        let expired = max_age_days > 0 && now_ms.saturating_sub(b.timestamp) >= max_age_ms;
        if expired {
            to_prune.insert(b.batch_id.clone());
            continue;
        }
        cumulative_bytes = cumulative_bytes.saturating_add(b.total_bytes);
        if max_size_mb > 0 && cumulative_bytes > max_total_bytes {
            to_prune.insert(b.batch_id.clone());
        }
    }

    let mut pruned_batch_ids = Vec::new();
    let mut freed_bytes = 0u64;
    for b in batches {
        if to_prune.contains(&b.batch_id) {
            purge_batch(ctx, &b.batch_id)?;
            freed_bytes = freed_bytes.saturating_add(b.total_bytes);
            pruned_batch_ids.push(b.batch_id);
        }
    }

    Ok(PruneTrashReport {
        pruned_batches: pruned_batch_ids.len(),
        freed_bytes,
        pruned_batch_ids,
    })
}

/// Backup a single config file to `~/.agent-cleaner/backups/<uuid>/...` before modifying it.
pub fn backup_file(ctx: &CleanerContext, src_path: &Path) -> Result<String> {
    if !src_path.exists() {
        bail!("Cannot backup missing file: {:?}", src_path);
    }
    let backup_id = Uuid::new_v4().to_string();
    let backup_dir = ctx.backups_root().join(&backup_id);
    let rel = sanitize_relative_path(&src_path.to_string_lossy());
    let dest = backup_dir.join(rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src_path, &dest)?;
    let size_bytes = get_file_size(&dest);
    let meta = BackupMeta {
        id: backup_id,
        original_path: src_path.to_string_lossy().to_string(),
        backup_path: dest.to_string_lossy().to_string(),
        size_bytes,
        created_at_ms: ctx.now(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(backup_dir.join(BACKUP_META_FILE), raw);
    }
    Ok(dest.to_string_lossy().to_string())
}

fn find_first_nested_file(dir: &Path) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.file_name().and_then(|n| n.to_str()) == Some(BACKUP_META_FILE) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn list_backups(ctx: &CleanerContext) -> Vec<BackupEntry> {
    let root = ctx.backups_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let now_ms = ctx.now();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let meta_path = dir.join(BACKUP_META_FILE);
        if let Ok(raw) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<BackupMeta>(&raw) {
                if Path::new(&meta.backup_path).exists() {
                    out.push(BackupEntry {
                        id: meta.id,
                        original_path: meta.original_path,
                        backup_path: meta.backup_path,
                        size_bytes: meta.size_bytes,
                        created_at_ms: meta.created_at_ms,
                    });
                    continue;
                }
            }
        }
        // Fallback for legacy backups created before `.backup-meta.json` existed.
        if let Some(backed_file) = find_first_nested_file(&dir) {
            let rel = backed_file.strip_prefix(&dir).unwrap_or(&backed_file);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let bytes = rel_str.as_bytes();
            let original_path = if cfg!(windows)
                && bytes.len() >= 2
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b'/'
            {
                format!("{}:/{}", bytes[0] as char, &rel_str[2..])
            } else {
                format!("/{rel_str}")
            };
            out.push(BackupEntry {
                id,
                original_path,
                backup_path: backed_file.to_string_lossy().to_string(),
                size_bytes: get_file_size(&backed_file),
                created_at_ms: safe_mtime_ms(&backed_file, now_ms),
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at_ms));
    out
}

pub fn restore_backup(ctx: &CleanerContext, backup_id: &str) -> Result<BackupRestoreReport> {
    let backups_root = ctx.backups_root();
    let backup_dir = backups_root.join(backup_id);
    assert_safe_child(&backups_root, &backup_dir)?;

    let entry = list_backups(ctx)
        .into_iter()
        .find(|b| b.id == backup_id)
        .with_context(|| format!("Backup not found: {backup_id}"))?;

    let src = Path::new(&entry.backup_path);
    let dst = Path::new(&entry.original_path);
    if !src.is_file() {
        bail!("Backup payload missing: {:?}", src);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;

    Ok(BackupRestoreReport {
        id: entry.id,
        original_path: entry.original_path,
        backup_path: entry.backup_path,
        restored: true,
    })
}

pub fn delete_backup(ctx: &CleanerContext, backup_id: &str) -> Result<()> {
    let root = ctx.backups_root();
    let dir = root.join(backup_id);
    assert_safe_child(&root, &dir)?;
    if dir.exists() {
        remove_path(&dir)?;
    }
    Ok(())
}

pub fn prune_backups(ctx: &CleanerContext, keep_count: usize) -> Result<PruneBackupsReport> {
    if keep_count == 0 {
        return Ok(PruneBackupsReport {
            pruned_count: 0,
            freed_bytes: 0,
        });
    }
    let backups = list_backups(ctx); // newest-first
    if backups.len() <= keep_count {
        return Ok(PruneBackupsReport {
            pruned_count: 0,
            freed_bytes: 0,
        });
    }
    let mut pruned_count = 0usize;
    let mut freed_bytes = 0u64;
    for b in backups.into_iter().skip(keep_count) {
        delete_backup(ctx, &b.id)?;
        pruned_count += 1;
        freed_bytes = freed_bytes.saturating_add(b.size_bytes);
    }
    Ok(PruneBackupsReport {
        pruned_count,
        freed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_backup_list_restore_and_prune() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let target = home.join(".claude/settings.json");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, r#"{"ok":1}"#).unwrap();

        let mut ctx = CleanerContext::with_home(home.to_path_buf());
        ctx.now_ms = Some(1_000);
        let _b1 = backup_file(&ctx, &target).unwrap();

        fs::write(&target, r#"{"ok":2}"#).unwrap();
        ctx.now_ms = Some(2_000);
        let _b2 = backup_file(&ctx, &target).unwrap();

        fs::write(&target, r#"{"ok":3}"#).unwrap();

        let listed = list_backups(&ctx);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].created_at_ms, 2_000);

        // Restore older backup (b1 -> {"ok":1})
        let restored = restore_backup(&ctx, &listed[1].id).unwrap();
        assert!(restored.restored);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"ok":1}"#);

        // Prune keeping 1 newest backup
        let pruned = prune_backups(&ctx, 1).unwrap();
        assert_eq!(pruned.pruned_count, 1);
        assert_eq!(list_backups(&ctx).len(), 1);
    }

    #[test]
    fn test_prune_trash_by_age_and_size() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let mut ctx = CleanerContext::with_home(home.to_path_buf());

        // Create two dummy files and move them to trash at different timestamps
        let f1 = home.join("old.bin");
        let f2 = home.join("new.bin");
        fs::write(&f1, vec![b'a'; 1024]).unwrap();
        fs::write(&f2, vec![b'b'; 1024]).unwrap();

        ctx.now_ms = Some(1_000);
        let b1 = begin_batch(&ctx).unwrap();
        move_to_trash(
            &ctx,
            &b1,
            &[ScanItem {
                id: "1".into(),
                agent: "claude".into(),
                category: crate::types::ScanCategory::Cache,
                path: f1.to_string_lossy().to_string(),
                size_bytes: 1024,
                mtime_ms: 1_000,
                description: "old".into(),
                status: crate::types::ItemStatus::Active,
                recommendation: crate::types::CleanRecommendation::Recommended,
                recommendation_reason: "old".into(),
            }],
        )
        .unwrap();

        ctx.now_ms = Some(40 * MS_PER_DAY);
        let b2 = begin_batch(&ctx).unwrap();
        move_to_trash(
            &ctx,
            &b2,
            &[ScanItem {
                id: "2".into(),
                agent: "claude".into(),
                category: crate::types::ScanCategory::Cache,
                path: f2.to_string_lossy().to_string(),
                size_bytes: 1024,
                mtime_ms: 40 * MS_PER_DAY,
                description: "new".into(),
                status: crate::types::ItemStatus::Active,
                recommendation: crate::types::CleanRecommendation::Recommended,
                recommendation_reason: "new".into(),
            }],
        )
        .unwrap();

        let report = prune_trash(&ctx, 30, 5120, None).unwrap();
        assert_eq!(report.pruned_batches, 1);
        assert_eq!(report.pruned_batch_ids, vec![b1]);
        let remaining = list_batches(&ctx);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].batch_id, b2);
    }

    #[test]
    fn test_sanitize_relative_path_cross_platform() {
        let to_parts = |p: PathBuf| -> Vec<String> {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect()
        };
        assert_eq!(
            to_parts(sanitize_relative_path("/Users/a/b")),
            vec!["Users", "a", "b"]
        );
        assert_eq!(
            to_parts(sanitize_relative_path(r"C:\Users\a\b")),
            vec!["C", "Users", "a", "b"]
        );
        assert_eq!(
            to_parts(sanitize_relative_path("D:/proj/file.json")),
            vec!["D", "proj", "file.json"]
        );
        assert_eq!(
            to_parts(sanitize_relative_path(r"\\?\C:\Users\a\b")),
            vec!["C", "Users", "a", "b"]
        );
        assert_eq!(
            to_parts(sanitize_relative_path(r"\\server\share\dir\file")),
            vec!["server", "share", "dir", "file"]
        );
    }
}
