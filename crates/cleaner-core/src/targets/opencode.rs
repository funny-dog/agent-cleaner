use super::{push_dir_item, AgentTarget};
use crate::fs_safe::get_dir_size;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::path::PathBuf;

pub struct OpenCodeTarget;

impl AgentTarget for OpenCodeTarget {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        vec![
            ctx.home_dir.join(".opencode"),
            ctx.home_dir.join(".local/share/opencode"),
            ctx.home_dir.join(".config/opencode"),
            ctx.home_dir.join(".cache/opencode"),
            ctx.home_dir.join("AppData/Roaming/opencode"),
            ctx.home_dir.join("AppData/Local/opencode"),
        ]
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let dot_dir = ctx.home_dir.join(".opencode");
        let share_dir = ctx.home_dir.join(".local/share/opencode");
        let config_dir = ctx.home_dir.join(".config/opencode");
        let cache_dir = ctx.home_dir.join(".cache/opencode");
        let win_roaming_dir = ctx.home_dir.join("AppData/Roaming/opencode");
        let win_local_dir = ctx.home_dir.join("AppData/Local/opencode");
        let mut items: Vec<ScanItem> = Vec::new();

        for (dir, category, zh, en) in [
            (
                share_dir.join("snapshot"),
                ScanCategory::Snapshot,
                "OpenCode Shadow Git 快照仓库",
                "OpenCode shadow Git snapshots",
            ),
            (
                share_dir.join("storage"),
                ScanCategory::Cache,
                "OpenCode 本地存储缓存",
                "OpenCode local storage cache",
            ),
            (
                share_dir.join("log"),
                ScanCategory::Log,
                "OpenCode 运行日志",
                "OpenCode application logs",
            ),
            (
                share_dir.join("bin"),
                ScanCategory::Cache,
                "OpenCode 语言服务与工具二进制缓存",
                "OpenCode language service & tools binary cache",
            ),
            (
                cache_dir.clone(),
                ScanCategory::Cache,
                "OpenCode XDG 缓存目录",
                "OpenCode XDG cache directory",
            ),
            (
                dot_dir.join("logs"),
                ScanCategory::Log,
                "OpenCode 本地运行日志",
                "OpenCode dotdir runtime logs",
            ),
            (
                dot_dir.join("cache"),
                ScanCategory::Cache,
                "OpenCode 本地缓存目录",
                "OpenCode dotdir cache",
            ),
            (
                dot_dir.join("tmp"),
                ScanCategory::Tmp,
                "OpenCode 临时文件目录",
                "OpenCode dotdir temporary files",
            ),
        ] {
            push_dir_item(
                &mut items,
                "opencode",
                &dir,
                category,
                lang.tr(zh, en),
                ItemStatus::Active,
                false,
                exempt_hours,
                now_ms,
                lang,
            );
        }

        for win_root in [&win_roaming_dir, &win_local_dir] {
            for (sub, category, zh, en) in [
                (
                    "snapshot",
                    ScanCategory::Snapshot,
                    "OpenCode Shadow Git 快照仓库",
                    "OpenCode shadow Git snapshots",
                ),
                (
                    "storage",
                    ScanCategory::Cache,
                    "OpenCode 本地存储缓存",
                    "OpenCode local storage cache",
                ),
                (
                    "cache",
                    ScanCategory::Cache,
                    "OpenCode 本地缓存目录",
                    "OpenCode local cache",
                ),
                (
                    "logs",
                    ScanCategory::Log,
                    "OpenCode 运行日志",
                    "OpenCode runtime logs",
                ),
                (
                    "log",
                    ScanCategory::Log,
                    "OpenCode 运行日志",
                    "OpenCode application logs",
                ),
                (
                    "tmp",
                    ScanCategory::Tmp,
                    "OpenCode 临时文件目录",
                    "OpenCode temporary files",
                ),
            ] {
                push_dir_item(
                    &mut items,
                    "opencode",
                    &win_root.join(sub),
                    category,
                    lang.tr(zh, en),
                    ItemStatus::Active,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );
            }
        }

        let disk_usage_bytes = get_dir_size(&dot_dir)
            + get_dir_size(&share_dir)
            + get_dir_size(&config_dir)
            + get_dir_size(&cache_dir)
            + get_dir_size(&win_roaming_dir)
            + get_dir_size(&win_local_dir);
        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "opencode".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
