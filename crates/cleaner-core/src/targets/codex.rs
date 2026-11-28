use super::{
    platform_cache_dirs, platform_log_dirs, platform_support_dirs, push_desktop_cache_dirs,
    push_dir_item, AgentTarget,
};
use crate::fs_safe::{get_dir_size, get_file_size, safe_mtime_ms};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct CodexTarget;

fn is_digits(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit())
}

fn scan_sessions(
    sessions_dir: &Path,
    items: &mut Vec<ScanItem>,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    let Ok(years) = fs::read_dir(sessions_dir) else {
        return;
    };
    for y in years.flatten() {
        let y_name = y.file_name();
        let y_str = y_name.to_string_lossy();
        if !y.path().is_dir() || !is_digits(&y_str, 4) {
            continue;
        }
        let Ok(months) = fs::read_dir(y.path()) else {
            continue;
        };
        for m in months.flatten() {
            let m_name = m.file_name();
            let m_str = m_name.to_string_lossy();
            if !m.path().is_dir() || !is_digits(&m_str, 2) {
                continue;
            }
            let Ok(days) = fs::read_dir(m.path()) else {
                continue;
            };
            for d in days.flatten() {
                let d_name = d.file_name();
                let d_str = d_name.to_string_lossy();
                if !d.path().is_dir() || !is_digits(&d_str, 2) {
                    continue;
                }
                let Ok(files) = fs::read_dir(d.path()) else {
                    continue;
                };
                for f in files.flatten() {
                    let p = f.path();
                    let fname = f.file_name();
                    let fstr = fname.to_string_lossy();
                    if p.is_file() && fstr.starts_with("rollout-") && fstr.ends_with(".jsonl") {
                        let size = get_file_size(&p);
                        let mtime = safe_mtime_ms(&p, now_ms);
                        let desc = match lang {
                            Language::Zh => {
                                format!("Codex 会话滚动日志: {y_str}/{m_str}/{d_str}/{fstr}")
                            }
                            Language::En => {
                                format!("Codex session log: {y_str}/{m_str}/{d_str}/{fstr}")
                            }
                        };
                        items.push(make_item(
                            "codex",
                            ScanCategory::Log,
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
                }
            }
        }
    }
}

impl AgentTarget for CodexTarget {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        let mut dirs = vec![
            ctx.home_dir.join(".codex"),
            ctx.home_dir.join("Library/Application Support/Codex"),
            ctx.home_dir
                .join("Library/Application Support/com.openai.codex"),
            ctx.home_dir.join("Library/Caches/Codex"),
            ctx.home_dir.join("Library/Caches/com.openai.codex"),
            ctx.home_dir.join("Library/Logs/com.openai.codex"),
            ctx.home_dir.join(".cache/codex-runtimes"),
        ];
        for d in platform_support_dirs(ctx, "Codex")
            .into_iter()
            .chain(platform_cache_dirs(ctx, "Codex"))
            .chain(platform_log_dirs(ctx, "Codex"))
        {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        dirs
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let codex_dir = ctx.home_dir.join(".codex");
        let mut items: Vec<ScanItem> = Vec::new();

        scan_sessions(
            &codex_dir.join("sessions"),
            &mut items,
            exempt_hours,
            now_ms,
            lang,
        );

        if let Ok(entries) = fs::read_dir(&codex_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let size = get_file_size(&p);
                let mtime = safe_mtime_ms(&p, now_ms);

                if name.ends_with(".log")
                    || (name.starts_with("logs_")
                        && (name.ends_with(".sqlite")
                            || name.ends_with(".sqlite-wal")
                            || name.ends_with(".sqlite-shm")))
                {
                    let desc = match lang {
                        Language::Zh => format!("Codex 根目录日志文件: {name}"),
                        Language::En => format!("Codex root log file: {name}"),
                    };
                    items.push(make_item(
                        "codex",
                        ScanCategory::Log,
                        p.to_string_lossy().to_string(),
                        size,
                        mtime,
                        desc,
                        ItemStatus::Active,
                        exempt_hours,
                        now_ms,
                        lang,
                    ));
                } else if name.contains(".tmp-") || name.contains(".bak-") || name.ends_with(".bak")
                {
                    let category = if name.contains(".tmp-") {
                        ScanCategory::Tmp
                    } else {
                        ScanCategory::Backup
                    };
                    let desc = match lang {
                        Language::Zh => format!("Codex 残留备份/临时文件: {name}"),
                        Language::En => format!("Codex stale backup/temp file: {name}"),
                    };
                    items.push(make_item(
                        "codex",
                        category,
                        p.to_string_lossy().to_string(),
                        size,
                        mtime,
                        desc,
                        ItemStatus::Cold,
                        exempt_hours,
                        now_ms,
                        lang,
                    ));
                }
            }
        }

        let codex_support = ctx.home_dir.join("Library/Application Support/Codex");
        let codex_bundle_support = ctx
            .home_dir
            .join("Library/Application Support/com.openai.codex");
        let codex_app_cache = ctx.home_dir.join("Library/Caches/com.openai.codex");
        let codex_dir_cache = ctx.home_dir.join("Library/Caches/Codex");
        let codex_logs = ctx.home_dir.join("Library/Logs/com.openai.codex");
        let codex_runtimes = ctx.home_dir.join(".cache/codex-runtimes");

        push_desktop_cache_dirs(
            &mut items,
            "codex",
            &codex_support,
            "Codex",
            "Codex",
            exempt_hours,
            now_ms,
            lang,
        );
        push_desktop_cache_dirs(
            &mut items,
            "codex",
            &codex_bundle_support,
            "Codex Desktop",
            "Codex Desktop",
            exempt_hours,
            now_ms,
            lang,
        );

        for (dir, category, zh, en, status) in [
            (
                codex_dir.join("tmp"),
                ScanCategory::Tmp,
                "Codex 临时文件目录 (tmp)",
                "Codex temporary files directory (tmp)",
                ItemStatus::Active,
            ),
            (
                codex_dir.join(".tmp"),
                ScanCategory::Tmp,
                "Codex 临时文件目录 (.tmp)",
                "Codex temporary files directory (.tmp)",
                ItemStatus::Active,
            ),
            (
                codex_dir.join("archived_sessions"),
                ScanCategory::Archive,
                "Codex 历史归档会话",
                "Codex archived sessions",
                ItemStatus::Cold,
            ),
            (
                codex_dir.join("backups"),
                ScanCategory::Backup,
                "Codex 历史配置与状态备份",
                "Codex historical configuration & state backups",
                ItemStatus::Cold,
            ),
            (
                codex_dir.join("cache"),
                ScanCategory::Cache,
                "Codex 模型与响应缓存",
                "Codex model & response cache",
                ItemStatus::Active,
            ),
            (
                codex_dir.join("visualizations"),
                ScanCategory::Cache,
                "Codex 生成的可视化产物缓存",
                "Codex generated visualization artifacts",
                ItemStatus::Active,
            ),
            (
                codex_app_cache.clone(),
                ScanCategory::Cache,
                "Codex macOS 系统应用缓存",
                "Codex macOS Caches",
                ItemStatus::Active,
            ),
            (
                codex_dir_cache.clone(),
                ScanCategory::Cache,
                "Codex macOS 桌面缓存",
                "Codex macOS desktop Caches",
                ItemStatus::Active,
            ),
            (
                codex_logs.clone(),
                ScanCategory::Log,
                "Codex macOS 系统运行日志",
                "Codex macOS Library logs",
                ItemStatus::Active,
            ),
            (
                codex_runtimes.clone(),
                ScanCategory::Snapshot,
                "Codex 运行时容器镜像缓存 (~/.cache/codex-runtimes)",
                "Codex runtime bundle cache",
                ItemStatus::Cold,
            ),
        ] {
            push_dir_item(
                &mut items,
                "codex",
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

        let mut extra_dirs = Vec::new();
        for dir in platform_support_dirs(ctx, "Codex") {
            if dir != codex_support {
                push_desktop_cache_dirs(
                    &mut items,
                    "codex",
                    &dir,
                    "Codex",
                    "Codex",
                    exempt_hours,
                    now_ms,
                    lang,
                );
                extra_dirs.push(dir);
            }
        }
        for dir in platform_cache_dirs(ctx, "Codex") {
            if dir != codex_dir_cache {
                push_dir_item(
                    &mut items,
                    "codex",
                    &dir,
                    ScanCategory::Cache,
                    lang.tr("Codex 桌面缓存", "Codex desktop cache"),
                    ItemStatus::Active,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );
                extra_dirs.push(dir);
            }
        }
        for dir in platform_log_dirs(ctx, "Codex") {
            if dir != codex_logs {
                push_dir_item(
                    &mut items,
                    "codex",
                    &dir,
                    ScanCategory::Log,
                    lang.tr("Codex 系统运行日志", "Codex system logs"),
                    ItemStatus::Active,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );
                extra_dirs.push(dir);
            }
        }

        let mut seen = HashSet::new();
        let extra_usage: u64 = extra_dirs
            .iter()
            .filter(|d| seen.insert((*d).clone()))
            .map(|d| get_dir_size(d))
            .sum();

        let disk_usage_bytes = get_dir_size(&codex_dir)
            + get_dir_size(&codex_support)
            + get_dir_size(&codex_bundle_support)
            + get_dir_size(&codex_app_cache)
            + get_dir_size(&codex_dir_cache)
            + get_dir_size(&codex_logs)
            + get_dir_size(&codex_runtimes)
            + extra_usage;
        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "codex".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
