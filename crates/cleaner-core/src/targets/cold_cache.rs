use super::AgentTarget;
use crate::fs_safe::{get_dir_size, get_file_size, safe_atime_ms};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::fs;
use std::path::{Path, PathBuf};

pub const COLD_THRESHOLD_DAYS: u64 = 14;
const MS_PER_DAY: u64 = 86_400_000;

pub struct ColdCacheTarget;

fn scan_cold_dir(
    dir: &Path,
    source: &str,
    items: &mut Vec<ScanItem>,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let full_path = entry.path();
        let atime_ms = safe_atime_ms(&full_path, now_ms);
        let age_days = now_ms.saturating_sub(atime_ms) / MS_PER_DAY;
        if age_days > COLD_THRESHOLD_DAYS {
            let size = if full_path.is_dir() {
                get_dir_size(&full_path)
            } else {
                get_file_size(&full_path)
            };
            if size == 0 {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let desc = match lang {
                Language::Zh => format!("{source} 冷缓存 ({age_days} 天未访问): {name}"),
                Language::En => format!("Cold {source} cache ({age_days}d unused): {name}"),
            };
            items.push(make_item(
                "pkg-cache",
                ScanCategory::ColdCache,
                full_path.to_string_lossy().to_string(),
                size,
                atime_ms,
                desc,
                ItemStatus::Cold,
                exempt_hours,
                now_ms,
                lang,
            ));
        }
    }
}

impl AgentTarget for ColdCacheTarget {
    fn id(&self) -> &'static str {
        "pkg-cache"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        vec![
            ctx.home_dir.join(".npm/_npx"),
            ctx.home_dir.join(".cache/uv"),
        ]
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let mut items: Vec<ScanItem> = Vec::new();
        let npx_dir = ctx.home_dir.join(".npm/_npx");
        let uv_dir = ctx.home_dir.join(".cache/uv");

        scan_cold_dir(&npx_dir, "npm/_npx", &mut items, exempt_hours, now_ms, lang);
        scan_cold_dir(&uv_dir, "uv", &mut items, exempt_hours, now_ms, lang);

        let disk_usage_bytes = get_dir_size(&npx_dir) + get_dir_size(&uv_dir);
        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "pkg-cache".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
