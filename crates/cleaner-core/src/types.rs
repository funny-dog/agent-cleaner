use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Runtime context allowing deterministic sandbox testing via custom `home_dir` and `now_ms`.
#[derive(Debug, Clone)]
pub struct CleanerContext {
    pub home_dir: PathBuf,
    pub now_ms: Option<u64>,
    /// Optional override for checking whether a command exists on PATH (used in tests).
    pub skip_system_processes: bool,
}

impl Default for CleanerContext {
    fn default() -> Self {
        let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        Self {
            home_dir,
            now_ms: None,
            skip_system_processes: false,
        }
    }
}

impl CleanerContext {
    pub fn with_home(home_dir: PathBuf) -> Self {
        Self {
            home_dir,
            now_ms: None,
            skip_system_processes: false,
        }
    }

    pub fn now(&self) -> u64 {
        self.now_ms.unwrap_or_else(current_time_ms)
    }

    pub fn trash_root(&self) -> PathBuf {
        self.home_dir.join(".agent-cleaner").join("trash")
    }

    pub fn backups_root(&self) -> PathBuf {
        self.home_dir.join(".agent-cleaner").join("backups")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, Type)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    #[default]
    Zh,
    En,
}

impl Language {
    pub fn tr<'a>(self, zh: &'a str, en: &'a str) -> &'a str {
        match self {
            Language::Zh => zh,
            Language::En => en,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ScanCategory {
    OrphanSession,
    Snapshot,
    Log,
    Cache,
    Tmp,
    NodeModules,
    BloatedJsonl,
    ColdCache,
    Backup,
    Updater,
    Archive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Active,
    Orphan,
    Unmounted,
    Cold,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum CleanRecommendation {
    Recommended,
    Optional,
    Exempt,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub id: String,
    pub agent: String,
    pub category: ScanCategory,
    pub path: String,
    #[specta(type = f64)]
    pub size_bytes: u64,
    #[specta(type = f64)]
    pub mtime_ms: u64,
    pub description: String,
    pub status: ItemStatus,
    pub recommendation: CleanRecommendation,
    pub recommendation_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub agent: String,
    pub items: Vec<ScanItem>,
    #[specta(type = f64)]
    pub total_bytes: u64,
    #[specta(type = f64)]
    pub disk_usage_bytes: u64,
    #[specta(type = f64)]
    pub scanned_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    #[specta(type = Option<u32>)]
    pub exempt_hours: Option<u64>,
    pub agent_filter: Option<Vec<String>>,
    #[serde(default)]
    pub lang: Option<Language>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanOptions {
    #[specta(type = Option<u32>)]
    pub exempt_hours: Option<u64>,
    pub dry_run: bool,
    pub agent_filter: Option<Vec<String>>,
    pub selected_ids: Option<Vec<String>>,
    pub only_recommended: bool,
    #[serde(default)]
    pub lang: Option<Language>,
    #[serde(default)]
    pub permanent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub original_path: String,
    pub trash_relative_path: String,
    #[specta(type = f64)]
    pub size_bytes: u64,
    pub agent: String,
    #[specta(type = f64)]
    pub moved_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashManifest {
    pub id: String,
    pub batch_id: String,
    #[specta(type = f64)]
    pub timestamp: u64,
    pub items: Vec<TrashItem>,
    #[specta(type = f64)]
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub batch_id: Option<String>,
    pub dry_run: bool,
    #[specta(type = u32)]
    pub cleaned_count: usize,
    #[specta(type = f64)]
    pub freed_bytes: u64,
    pub items: Vec<ScanItem>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub batch_id: String,
    #[specta(type = u32)]
    pub restored: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Sse,
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub config_path: String,
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    #[specta(type = f64)]
    pub rss_kb: u64,
    pub state: String,
    pub command: String,
    pub matched_name: Option<String>,
    pub matched_agent: Option<String>,
    pub is_orphan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColdCacheEntry {
    pub source: String,
    pub path: String,
    #[specta(type = f64)]
    pub size_bytes: u64,
    #[specta(type = f64)]
    pub last_access_days: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditReport {
    pub entries: Vec<McpEntry>,
    pub dead_links: Vec<McpEntry>,
    pub duplicates: Vec<Vec<McpEntry>>,
    pub orphan_processes: Vec<McpProcessInfo>,
    pub cold_caches: Vec<ColdCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KillProcessResult {
    pub pid: u32,
    pub success: bool,
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DoctorIssue {
    pub id: String,
    pub path: String,
    pub severity: IssueSeverity,
    pub message: String,
    pub auto_fixable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_target_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub path: String,
    pub agent: String,
    pub issues: Vec<DoctorIssue>,
    pub healthy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFixReport {
    #[specta(type = u32)]
    pub fixed_count: usize,
    pub backup_paths: Vec<String>,
    pub reports: Vec<DoctorReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSummary {
    #[specta(type = f64)]
    pub total_disk_usage_bytes: u64,
    #[specta(type = f64)]
    pub total_reclaimable_bytes: u64,
    #[specta(type = f64)]
    pub recommended_bytes: u64,
    #[specta(type = u32)]
    pub orphan_mcp_count: usize,
    #[specta(type = u32)]
    pub doctor_issue_count: usize,
    #[specta(type = u32)]
    pub trash_batch_count: usize,
    #[specta(type = f64)]
    pub scanned_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverviewReport {
    pub summary: OverviewSummary,
    pub agents: Vec<ScanResult>,
    pub mcp: McpAuditReport,
    pub doctors: Vec<DoctorReport>,
}
