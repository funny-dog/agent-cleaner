use super::{push_desktop_cache_dirs, push_dir_item, AgentTarget};
use crate::fs_safe::{
    extract_external_mountpoint, get_dir_size, get_file_size, is_mountpoint_accessible,
    safe_mtime_ms,
};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::cmp::Ordering;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const BLOATED_JSONL_THRESHOLD: u64 = 10 * 1024 * 1024; // 10 MB

pub struct ClaudeTarget;

fn parse_semver_parts(name: &str) -> Option<Vec<u64>> {
    let trimmed = name.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for seg in trimmed.split('.') {
        if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts.push(seg.parse::<u64>().ok()?);
    }
    Some(parts)
}

fn scan_old_claude_code_versions(
    variant_dir: &Path,
    variant_name: &str,
    items: &mut Vec<ScanItem>,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    let cc_dir = variant_dir.join("claude-code");
    let Ok(entries) = fs::read_dir(&cc_dir) else {
        return;
    };
    let mut versions: Vec<(PathBuf, String, Option<Vec<u64>>, u64)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let semver = parse_semver_parts(&name);
        let mtime = safe_mtime_ms(&path, now_ms);
        versions.push((path, name, semver, mtime));
    }
    if versions.len() <= 1 {
        return;
    }

    versions.sort_by(|a, b| match (&a.2, &b.2) {
        (Some(va), Some(vb)) => match va.cmp(vb) {
            Ordering::Equal => a.3.cmp(&b.3),
            ord => ord,
        },
        _ => a.3.cmp(&b.3),
    });

    // Keep the newest version (last element); mark all older versions as redundant updater artifacts.
    for (old_path, ver_name, _, mtime) in &versions[..versions.len() - 1] {
        let size = get_dir_size(old_path);
        if size == 0 {
            continue;
        }
        let desc = match lang {
            Language::Zh => format!("{variant_name} 旧版本 Claude Code 二进制冗余 ({ver_name})"),
            Language::En => format!("{variant_name} stale Claude Code binary version ({ver_name})"),
        };
        items.push(make_item(
            "claude",
            ScanCategory::Updater,
            old_path.to_string_lossy().to_string(),
            size,
            *mtime,
            desc,
            ItemStatus::Orphan,
            exempt_hours,
            now_ms,
            lang,
        ));
    }
}

fn extract_cwd_from_jsonl(file_path: &Path, max_lines: usize) -> Option<String> {
    let file = File::open(file_path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(max_lines).flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(cwd) = val.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

fn resolve_cwd_status(cwd: &Path) -> ItemStatus {
    if let Some(mountpoint) = extract_external_mountpoint(cwd) {
        if !is_mountpoint_accessible(&mountpoint) {
            return ItemStatus::Unmounted;
        }
    }
    match fs::metadata(cwd) {
        Ok(_) => ItemStatus::Active,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => ItemStatus::Orphan,
        Err(_) => ItemStatus::Active,
    }
}

impl AgentTarget for ClaudeTarget {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        let app_support = ctx.home_dir.join("Library/Application Support");
        let caches = ctx.home_dir.join("Library/Caches");
        let logs = ctx.home_dir.join("Library/Logs");
        vec![
            ctx.home_dir.join(".claude"),
            ctx.home_dir.join(".claude-cage"),
            ctx.home_dir.join(".claude-cage-downloads"),
            app_support.join("Claude"),
            app_support.join("Claude-3p"),
            app_support.join("Claude-kiro"),
            app_support.join("Claude-qoder-cn-3p"),
            app_support.join("Claude-wb-cn"),
            app_support.join("Claude-wb-cn-3p"),
            app_support.join("MultiClaude"),
            caches.join("claude-cli-nodejs"),
            caches.join("com.anthropic.claudefordesktop"),
            caches.join("com.anthropic.claudefordesktop.ShipIt"),
            caches.join("io.github.lee-xeo.claude-cage"),
            logs.join("Claude"),
            logs.join("Claude-3p"),
        ]
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let claude_dir = ctx.home_dir.join(".claude");
        let projects_dir = claude_dir.join("projects");
        let mut items: Vec<ScanItem> = Vec::new();

        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let session_dir = entry.path();
                if !session_dir.is_dir() {
                    continue;
                }

                let mut latest_jsonl: Option<(std::path::PathBuf, u64)> = None;
                if let Ok(files) = fs::read_dir(&session_dir) {
                    for f in files.flatten() {
                        let p = f.path();
                        if !p.is_file() || p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                            continue;
                        }
                        let size = get_file_size(&p);
                        let mtime = safe_mtime_ms(&p, now_ms);

                        if size > BLOATED_JSONL_THRESHOLD {
                            let mb = size as f64 / (1024.0 * 1024.0);
                            let desc = match lang {
                                Language::Zh => format!("Claude 膨胀 JSONL 会话文件 ({mb:.1} MB)"),
                                Language::En => format!("Bloated JSONL session file ({mb:.1} MB)"),
                            };
                            items.push(make_item(
                                "claude",
                                ScanCategory::BloatedJsonl,
                                p.to_string_lossy().to_string(),
                                size,
                                mtime,
                                desc,
                                ItemStatus::Active,
                                exempt_hours,
                                now_ms,
                                lang,
                            ));
                        }

                        if latest_jsonl.as_ref().is_none_or(|(_, lm)| mtime > *lm) {
                            latest_jsonl = Some((p, mtime));
                        }
                    }
                }

                if let Some((latest_path, _)) = latest_jsonl {
                    if let Some(cwd) = extract_cwd_from_jsonl(&latest_path, 30) {
                        if resolve_cwd_status(Path::new(&cwd)) == ItemStatus::Orphan {
                            let dir_size = get_dir_size(&session_dir);
                            let dir_mtime = safe_mtime_ms(&session_dir, now_ms);
                            let desc = match lang {
                                Language::Zh => {
                                    format!("Claude 孤儿会话 — 原项目目录已不存在: {cwd}")
                                }
                                Language::En => {
                                    format!("Orphan Claude session — project dir missing: {cwd}")
                                }
                            };
                            items.push(make_item(
                                "claude",
                                ScanCategory::OrphanSession,
                                session_dir.to_string_lossy().to_string(),
                                dir_size,
                                dir_mtime,
                                desc,
                                ItemStatus::Orphan,
                                exempt_hours,
                                now_ms,
                                lang,
                            ));
                        }
                    }
                }
            }
        }

        for (subdir, category, zh, en) in [
            ("file-history", ScanCategory::Cache, "Claude 文件修改历史缓存", "Claude file-history cache"),
            ("shell-snapshots", ScanCategory::Cache, "Claude 终端快照缓存", "Claude shell snapshots cache"),
            ("debug", ScanCategory::Log, "Claude 调试日志", "Claude debug logs"),
            ("paste-cache", ScanCategory::Cache, "Claude 剪贴板粘贴缓存", "Claude paste cache"),
        ] {
            push_dir_item(
                &mut items,
                "claude",
                &claude_dir.join(subdir),
                category,
                lang.tr(zh, en),
                ItemStatus::Active,
                false,
                exempt_hours,
                now_ms,
                lang,
            );
        }

        let app_support = ctx.home_dir.join("Library/Application Support");
        let claude_wb_3p = app_support.join("Claude-wb-cn-3p");
        let extra_claude_dirs = [
            "Claude",
            "Claude-3p",
            "Claude-kiro",
            "Claude-qoder-cn-3p",
            "Claude-wb-cn",
            "Claude-wb-cn-3p",
            "MultiClaude",
        ];

        for variant in extra_claude_dirs {
            let variant_dir = app_support.join(variant);
            push_desktop_cache_dirs(
                &mut items,
                "claude",
                &variant_dir,
                variant,
                variant,
                exempt_hours,
                now_ms,
                lang,
            );
            scan_old_claude_code_versions(
                &variant_dir,
                variant,
                &mut items,
                exempt_hours,
                now_ms,
                lang,
            );
        }

        // Scan Claude Cage Lima VM disk images (except _config) as Optional Snapshot items
        let lima_dir = ctx.home_dir.join(".claude-cage/state/lima");
        if let Ok(entries) = fs::read_dir(&lima_dir) {
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if !ft.is_dir() || ft.is_symlink() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "_config" {
                    continue;
                }
                let desc = match lang {
                    Language::Zh => format!("Claude Cage Lima 虚拟机磁盘镜像 ({name})"),
                    Language::En => format!("Claude Cage Lima VM disk image ({name})"),
                };
                push_dir_item(
                    &mut items,
                    "claude",
                    &entry.path(),
                    ScanCategory::Snapshot,
                    &desc,
                    ItemStatus::Cold,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );
            }
        }

        let claude_json_bak = ctx.home_dir.join(".claude.json.backup");
        if claude_json_bak.is_file() {
            let size = get_file_size(&claude_json_bak);
            if size > 0 {
                let mtime = safe_mtime_ms(&claude_json_bak, now_ms);
                items.push(make_item(
                    "claude",
                    ScanCategory::Backup,
                    claude_json_bak.to_string_lossy().to_string(),
                    size,
                    mtime,
                    lang.tr("Claude 全局配置历史备份 (.claude.json.backup)", "Claude global config backup (.claude.json.backup)"),
                    ItemStatus::Cold,
                    exempt_hours,
                    now_ms,
                    lang,
                ));
            }
        }

        let cage_downloads = ctx.home_dir.join(".claude-cage-downloads");
        let logs_claude = ctx.home_dir.join("Library/Logs/Claude");
        let logs_claude_3p = ctx.home_dir.join("Library/Logs/Claude-3p");

        for (dir, category, zh, en, status) in [
            (
                ctx.home_dir.join("Library/Caches/claude-cli-nodejs"),
                ScanCategory::Cache,
                "Claude CLI Node.js 运行时缓存",
                "Claude CLI Node.js runtime cache",
                ItemStatus::Active,
            ),
            (
                ctx.home_dir.join("Library/Caches/com.anthropic.claudefordesktop"),
                ScanCategory::Cache,
                "Claude Desktop 桌面端应用缓存",
                "Claude for Desktop application cache",
                ItemStatus::Active,
            ),
            (
                ctx.home_dir.join("Library/Caches/com.anthropic.claudefordesktop.ShipIt"),
                ScanCategory::Updater,
                "Claude Desktop 自动更新安装包残留",
                "Claude for Desktop ShipIt updater cache",
                ItemStatus::Cold,
            ),
            (
                claude_wb_3p.join("vm_bundles"),
                ScanCategory::Snapshot,
                "Claude 第三方虚拟机沙盒镜像包 (vm_bundles)",
                "Claude 3rd-party VM sandbox bundles",
                ItemStatus::Cold,
            ),
            (
                claude_wb_3p.join("claude-code-vm"),
                ScanCategory::Cache,
                "Claude 第三方沙盒 VM 运行时缓存",
                "Claude 3rd-party sandbox VM runtime cache",
                ItemStatus::Cold,
            ),
            (
                ctx.home_dir.join(".claude-cage/logs"),
                ScanCategory::Log,
                "Claude Cage 沙盒运行日志",
                "Claude Cage sandbox environment logs",
                ItemStatus::Active,
            ),
            (
                ctx.home_dir.join(".claude-cage/state/cache"),
                ScanCategory::Cache,
                "Claude Cage 沙盒状态缓存",
                "Claude Cage sandbox state cache",
                ItemStatus::Cold,
            ),
            (
                cage_downloads.clone(),
                ScanCategory::Cache,
                "Claude Cage 沙盒下载缓存目录",
                "Claude Cage sandbox downloads cache",
                ItemStatus::Cold,
            ),
            (
                ctx.home_dir.join("Library/Caches/io.github.lee-xeo.claude-cage"),
                ScanCategory::Cache,
                "Claude Cage macOS 应用缓存",
                "Claude Cage macOS application cache",
                ItemStatus::Active,
            ),
            (
                logs_claude.clone(),
                ScanCategory::Log,
                "Claude Desktop macOS 系统运行日志",
                "Claude Desktop macOS Library logs",
                ItemStatus::Active,
            ),
            (
                logs_claude_3p.clone(),
                ScanCategory::Log,
                "Claude 3rd-party macOS 系统运行日志",
                "Claude 3rd-party macOS Library logs",
                ItemStatus::Active,
            ),
        ] {
            push_dir_item(
                &mut items,
                "claude",
                &dir,
                category,
                lang.tr(zh, en),
                status,
                true,
                exempt_hours,
                now_ms,
                lang,
            );
        }

        let support_size: u64 = extra_claude_dirs
            .iter()
            .map(|name| get_dir_size(&app_support.join(name)))
            .sum();

        let disk_usage_bytes = get_dir_size(&claude_dir)
            + support_size
            + get_dir_size(&ctx.home_dir.join(".claude-cage"))
            + get_dir_size(&cage_downloads)
            + get_dir_size(&ctx.home_dir.join("Library/Caches/io.github.lee-xeo.claude-cage"))
            + get_dir_size(&logs_claude)
            + get_dir_size(&logs_claude_3p);

        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "claude".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
