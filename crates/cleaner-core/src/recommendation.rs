use crate::types::{CleanRecommendation, ItemStatus, Language, ScanCategory, ScanItem};

pub const DEFAULT_EXEMPT_HOURS: u64 = 24;

pub fn evaluate_recommendation(
    category: &ScanCategory,
    status: &ItemStatus,
    mtime_ms: u64,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) -> (CleanRecommendation, String) {
    let age_ms = now_ms.saturating_sub(mtime_ms);
    let exempt_window_ms = exempt_hours.saturating_mul(3_600_000);
    let is_recent = age_ms < exempt_window_ms;

    match category {
        ScanCategory::Updater => (
            CleanRecommendation::Recommended,
            lang.tr(
                "桌面端更新安装包残留，安装完成后可安全清除以释放空间",
                "Desktop updater package residue; safe to remove after installation",
            )
            .to_string(),
        ),
        ScanCategory::Tmp => (
            CleanRecommendation::Recommended,
            lang.tr(
                "崩溃或运行遗留的临时碎片文件，可安全清理",
                "Temporary or crash artifact; safe to clean",
            )
            .to_string(),
        ),
        _ if is_recent && *status != ItemStatus::Orphan => (
            CleanRecommendation::Exempt,
            match lang {
                Language::Zh => {
                    format!("{exempt_hours} 小时内有活跃修改，默认受保护免于误清理")
                }
                Language::En => {
                    format!("Modified within {exempt_hours}h; protected by active session guard")
                }
            },
        ),
        ScanCategory::OrphanSession => (
            CleanRecommendation::Recommended,
            lang.tr(
                "关联工作目录或项目已不存在的孤儿会话，可安全清理",
                "Orphan session whose associated project directory no longer exists",
            )
            .to_string(),
        ),
        _ if *status == ItemStatus::Orphan => (
            CleanRecommendation::Recommended,
            lang.tr(
                "未在配置中声明的孤儿依赖或残留文件，可安全清理",
                "Orphan artifact whose declaration or parent target no longer exists",
            )
            .to_string(),
        ),
        ScanCategory::Cache
        | ScanCategory::ColdCache
        | ScanCategory::Log
        | ScanCategory::BloatedJsonl => (
            CleanRecommendation::Recommended,
            lang.tr(
                "过期缓存、历史日志或膨胀会话记录，清理不影响核心配置",
                "Stale cache, historical log, or bloated session file; safe to remove",
            )
            .to_string(),
        ),
        ScanCategory::Archive => (
            CleanRecommendation::Optional,
            lang.tr(
                "历史对话归档记录，确认不再需要回溯后再清理",
                "Archived conversation history; review before deleting",
            )
            .to_string(),
        ),
        ScanCategory::Backup => (
            CleanRecommendation::Optional,
            lang.tr(
                "历史配置或状态备份，清理前建议确认是否仍需保留",
                "Historical config backup; verify it is no longer needed",
            )
            .to_string(),
        ),
        ScanCategory::NodeModules => (
            CleanRecommendation::Optional,
            lang.tr(
                "未在 package.json 中声明的冗余模块，建议确认后清理",
                "Undeclared node_modules package; verify before deleting",
            )
            .to_string(),
        ),
        ScanCategory::Snapshot => (
            CleanRecommendation::Optional,
            lang.tr(
                "Shadow Git 快照存储（体积较大），确认无需回退版本后再清理",
                "Shadow snapshot storage; review before clearing",
            )
            .to_string(),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn make_item(
    agent: &str,
    category: ScanCategory,
    path: impl Into<String>,
    size_bytes: u64,
    mtime_ms: u64,
    description: impl Into<String>,
    status: ItemStatus,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) -> ScanItem {
    let path_str = path.into();
    let (recommendation, recommendation_reason) =
        evaluate_recommendation(&category, &status, mtime_ms, exempt_hours, now_ms, lang);
    // Deterministic stable ID from agent + path so selection works across scans and languages
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("{agent}:{path_str}").as_bytes(),
    )
    .to_string();

    ScanItem {
        id,
        agent: agent.to_string(),
        category,
        path: path_str,
        size_bytes,
        mtime_ms,
        description: description.into(),
        status,
        recommendation,
        recommendation_reason,
    }
}
