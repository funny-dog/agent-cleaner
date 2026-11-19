pub mod claude;
pub mod codex;
pub mod cold_cache;
pub mod discovery;
pub mod dsh;
pub mod ecosystem;
pub mod opencode;

use crate::fs_safe::{get_dir_size, safe_mtime_ms};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::path::{Path, PathBuf};

pub trait AgentTarget: Send + Sync {
    fn id(&self) -> &'static str;
    fn claimed_dirs(&self, _ctx: &CleanerContext) -> Vec<PathBuf> {
        Vec::new()
    }
    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult;
}

/// Shared helper: add a directory as a `ScanItem` if it exists (optionally requiring non-zero size).
#[allow(clippy::too_many_arguments)]
pub(crate) fn push_dir_item(
    items: &mut Vec<ScanItem>,
    agent: &str,
    dir: &Path,
    category: ScanCategory,
    description: &str,
    status: ItemStatus,
    require_non_empty: bool,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    if !dir.exists() {
        return;
    }
    let size_bytes = get_dir_size(dir);
    if require_non_empty && size_bytes == 0 {
        return;
    }
    let mtime_ms = safe_mtime_ms(dir, now_ms);
    items.push(make_item(
        agent,
        category,
        dir.to_string_lossy().to_string(),
        size_bytes,
        mtime_ms,
        description,
        status,
        exempt_hours,
        now_ms,
        lang,
    ));
}

pub(crate) const DESKTOP_CACHE_SUBDIRS: &[(&str, ScanCategory, &str, &str)] = &[
    ("Cache", ScanCategory::Cache, "桌面端 HTTP 缓存", "desktop HTTP cache"),
    ("Code Cache", ScanCategory::Cache, "桌面端 JS 字节码缓存", "desktop JS code cache"),
    ("GPUCache", ScanCategory::Cache, "桌面端 GPU 缓存", "desktop GPU cache"),
    ("CachedData", ScanCategory::Cache, "桌面端扩展编译缓存", "desktop CachedData"),
    ("GraphiteDawnCache", ScanCategory::Cache, "桌面端 GraphiteDawn 图形缓存", "desktop GraphiteDawn cache"),
    ("DawnWebGPUCache", ScanCategory::Cache, "桌面端 DawnWebGPU 图形缓存", "desktop DawnWebGPU cache"),
    ("DawnGraphiteCache", ScanCategory::Cache, "桌面端 DawnGraphite 图形缓存", "desktop DawnGraphite cache"),
    ("Crashpad", ScanCategory::Log, "桌面端崩溃转储日志", "desktop crashpad logs"),
    ("logs", ScanCategory::Log, "桌面端运行日志", "desktop runtime logs"),
];

#[allow(clippy::too_many_arguments)]
pub(crate) fn push_desktop_cache_dirs(
    items: &mut Vec<ScanItem>,
    agent: &str,
    support_dir: &Path,
    zh_app: &str,
    en_app: &str,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    for (sub, cat, zh_kind, en_kind) in DESKTOP_CACHE_SUBDIRS {
        let desc = match lang {
            Language::Zh => format!("{zh_app} {zh_kind}"),
            Language::En => format!("{en_app} {en_kind}"),
        };
        push_dir_item(
            items,
            agent,
            &support_dir.join(sub),
            cat.clone(),
            &desc,
            ItemStatus::Active,
            true,
            exempt_hours,
            now_ms,
            lang,
        );
    }
}

pub fn all_targets() -> Vec<Box<dyn AgentTarget>> {
    vec![
        Box::new(claude::ClaudeTarget),
        Box::new(opencode::OpenCodeTarget),
        Box::new(codex::CodexTarget),
        Box::new(dsh::DshTarget),
        Box::new(ecosystem::GeminiTarget),
        Box::new(ecosystem::WorkbuddyTarget),
        Box::new(ecosystem::QoderTarget),
        Box::new(ecosystem::KimiTarget),
        Box::new(ecosystem::KiroTarget),
        Box::new(ecosystem::OllamaTarget),
        Box::new(ecosystem::AiderTarget),
        Box::new(ecosystem::CursorTarget),
        Box::new(ecosystem::WindsurfTarget),
        Box::new(ecosystem::TraeTarget),
        Box::new(ecosystem::CodeBuddyTarget),
        Box::new(ecosystem::ZCodeTarget),
        Box::new(ecosystem::DevinTarget),
        Box::new(ecosystem::ContinueTarget),
        Box::new(ecosystem::CopilotTarget),
        Box::new(ecosystem::ZedTarget),
        Box::new(cold_cache::ColdCacheTarget),
    ]
}
