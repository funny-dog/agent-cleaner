use crate::fs_safe::{assert_safe_child, remove_path, safe_move};
use crate::types::{CleanerContext, RestoreReport, ScanItem, TrashItem, TrashManifest};
use anyhow::{bail, Context, Result};
use std::fs;
use std::path::Path;
use uuid::Uuid;

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
        let rel_original = item.path.trim_start_matches('/');
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
    manifests.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
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

/// Backup a single config file to `~/.agent-cleaner/backups/<uuid>/...` before modifying it.
pub fn backup_file(ctx: &CleanerContext, src_path: &Path) -> Result<String> {
    if !src_path.exists() {
        bail!("Cannot backup missing file: {:?}", src_path);
    }
    let backup_id = Uuid::new_v4().to_string();
    let rel = src_path
        .to_string_lossy()
        .trim_start_matches('/')
        .to_string();
    let dest = ctx.backups_root().join(backup_id).join(rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src_path, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}
