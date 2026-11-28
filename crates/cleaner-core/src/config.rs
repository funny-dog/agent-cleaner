use crate::types::{CleanerContext, Language};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_TRASH_MAX_AGE_DAYS: u64 = 30;
pub const DEFAULT_TRASH_MAX_SIZE_MB: u64 = 5120; // 5 GB
pub const DEFAULT_BACKUP_MAX_COUNT: u32 = 30;
pub const DEFAULT_COLD_THRESHOLD_DAYS: u64 = 14;
pub const DEFAULT_EXEMPT_HOURS: u64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Type)]
pub struct CleanerConfig {
    #[serde(default = "default_exempt_hours", alias = "exemptHours")]
    #[specta(type = u32)]
    pub exempt_hours: u64,
    #[serde(default = "default_cold_threshold_days", alias = "coldThresholdDays")]
    #[specta(type = u32)]
    pub cold_threshold_days: u64,
    #[serde(default)]
    pub lang: Language,
    #[serde(default, alias = "ignoredAgents")]
    pub ignored_agents: Vec<String>,
    #[serde(default, alias = "ignoredPaths")]
    pub ignored_paths: Vec<String>,
    #[serde(default = "default_trash_max_age_days", alias = "trashMaxAgeDays")]
    #[specta(type = u32)]
    pub trash_max_age_days: u64,
    #[serde(default = "default_trash_max_size_mb", alias = "trashMaxSizeMb")]
    #[specta(type = f64)]
    pub trash_max_size_mb: u64,
    #[serde(default = "default_true", alias = "autoPruneTrash")]
    pub auto_prune_trash: bool,
    #[serde(default = "default_backup_max_count", alias = "backupMaxCount")]
    pub backup_max_count: u32,
}

fn default_exempt_hours() -> u64 {
    DEFAULT_EXEMPT_HOURS
}

fn default_cold_threshold_days() -> u64 {
    DEFAULT_COLD_THRESHOLD_DAYS
}

fn default_trash_max_age_days() -> u64 {
    DEFAULT_TRASH_MAX_AGE_DAYS
}

fn default_trash_max_size_mb() -> u64 {
    DEFAULT_TRASH_MAX_SIZE_MB
}

fn default_true() -> bool {
    true
}

fn default_backup_max_count() -> u32 {
    DEFAULT_BACKUP_MAX_COUNT
}

impl Default for CleanerConfig {
    fn default() -> Self {
        Self {
            exempt_hours: DEFAULT_EXEMPT_HOURS,
            cold_threshold_days: DEFAULT_COLD_THRESHOLD_DAYS,
            lang: Language::default(),
            ignored_agents: Vec::new(),
            ignored_paths: Vec::new(),
            trash_max_age_days: DEFAULT_TRASH_MAX_AGE_DAYS,
            trash_max_size_mb: DEFAULT_TRASH_MAX_SIZE_MB,
            auto_prune_trash: true,
            backup_max_count: DEFAULT_BACKUP_MAX_COUNT,
        }
    }
}

pub fn config_path(ctx: &CleanerContext) -> PathBuf {
    ctx.home_dir.join(".agent-cleaner").join("config.toml")
}

pub fn load_config(ctx: &CleanerContext) -> CleanerConfig {
    let path = config_path(ctx);
    let Ok(raw) = fs::read_to_string(path) else {
        return CleanerConfig::default();
    };
    toml::from_str::<CleanerConfig>(&raw).unwrap_or_default()
}

pub fn save_config(ctx: &CleanerContext, cfg: &CleanerConfig) -> Result<()> {
    let path = config_path(ctx);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = format_config_toml(cfg)?;
    fs::write(path, raw)?;
    Ok(())
}

pub fn format_config_toml(cfg: &CleanerConfig) -> Result<String> {
    let mut normalized = cfg.clone();
    normalized.ignored_agents = normalize_agent_list(&normalized.ignored_agents);
    normalized.ignored_paths = normalize_pattern_list(&normalized.ignored_paths);
    Ok(toml::to_string_pretty(&normalized)?)
}

fn normalize_agent_list(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn normalize_pattern_list(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    out.dedup();
    out
}

fn normalize_slashes(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    let trimmed = replaced.trim_end_matches('/');
    if trimmed.is_empty() && replaced.starts_with('/') {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn expand_pattern(ctx: &CleanerContext, raw: &str) -> String {
    let trimmed = raw.trim();
    let expanded = if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        ctx.home_dir.join(rest).to_string_lossy().to_string()
    } else if trimmed == "~" {
        ctx.home_dir.to_string_lossy().to_string()
    } else {
        trimmed.to_string()
    };
    normalize_slashes(&expanded)
}

fn has_windows_drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Simple wildcard matcher supporting `*` (single segment) and `**` (any depth).
fn glob_match(pattern: &str, text: &str) -> bool {
    let pat_segs: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let txt_segs: Vec<&str> = text.split('/').filter(|s| !s.is_empty()).collect();
    glob_match_segments(&pat_segs, &txt_segs)
}

fn glob_match_segments(pat: &[&str], txt: &[&str]) -> bool {
    if pat.is_empty() {
        return txt.is_empty();
    }
    if pat[0] == "**" {
        if glob_match_segments(&pat[1..], txt) {
            return true;
        }
        if !txt.is_empty() && glob_match_segments(pat, &txt[1..]) {
            return true;
        }
        return false;
    }
    if txt.is_empty() {
        return false;
    }
    wildcard_segment_match(pat[0], txt[0]) && glob_match_segments(&pat[1..], &txt[1..])
}

fn wildcard_segment_match(pat: &str, txt: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = txt.chars().collect();
    let mut dp = vec![vec![false; t.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=p.len() {
        for j in 1..=t.len() {
            if p[i - 1] == '*' {
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else if p[i - 1] == '?' || p[i - 1] == t[j - 1] {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }
    dp[p.len()][t.len()]
}

pub fn is_path_ignored(ctx: &CleanerContext, target_path: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let norm_target = normalize_slashes(target_path);
    if norm_target.is_empty() {
        return false;
    }
    let target_is_win = cfg!(windows) || has_windows_drive_prefix(&norm_target);
    for raw in patterns {
        let pat = expand_pattern(ctx, raw);
        if pat.is_empty() {
            continue;
        }
        let case_insensitive = target_is_win || has_windows_drive_prefix(&pat);
        let (cmp_pat, cmp_target) = if case_insensitive {
            (pat.to_ascii_lowercase(), norm_target.to_ascii_lowercase())
        } else {
            (pat, norm_target.clone())
        };
        if cmp_pat.contains('*') || cmp_pat.contains('?') {
            if glob_match(&cmp_pat, &cmp_target) {
                return true;
            }
        } else if cmp_target == cmp_pat
            || Path::new(&cmp_target).starts_with(Path::new(&cmp_pat))
            || cmp_target.starts_with(&format!("{cmp_pat}/"))
        {
            return true;
        }
    }
    false
}

pub fn is_agent_ignored(agent: &str, ignored_agents: &[String]) -> bool {
    let lower = agent.trim().to_ascii_lowercase();
    ignored_agents
        .iter()
        .any(|a| a.trim().to_ascii_lowercase() == lower)
}

pub fn add_ignored_path(ctx: &CleanerContext, pattern: &str) -> Result<CleanerConfig> {
    let mut cfg = load_config(ctx);
    let trimmed = pattern.trim();
    if !trimmed.is_empty() && !cfg.ignored_paths.iter().any(|p| p == trimmed) {
        cfg.ignored_paths.push(trimmed.to_string());
    }
    save_config(ctx, &cfg)?;
    Ok(cfg)
}

pub fn remove_ignored_path(ctx: &CleanerContext, pattern: &str) -> Result<CleanerConfig> {
    let mut cfg = load_config(ctx);
    let trimmed = pattern.trim();
    cfg.ignored_paths.retain(|p| p != trimmed);
    save_config(ctx, &cfg)?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_config_roundtrip_and_partial_defaults() {
        let tmp = TempDir::new().unwrap();
        let ctx = CleanerContext::with_home(tmp.path().to_path_buf());
        assert_eq!(load_config(&ctx), CleanerConfig::default());

        fs::create_dir_all(tmp.path().join(".agent-cleaner")).unwrap();
        fs::write(
            config_path(&ctx),
            "exempt_hours = 48\nignored_agents = [\"Claude\", \"codex\"]\n",
        )
        .unwrap();
        let loaded = load_config(&ctx);
        assert_eq!(loaded.exempt_hours, 48);
        assert_eq!(loaded.cold_threshold_days, DEFAULT_COLD_THRESHOLD_DAYS);
        assert_eq!(loaded.trash_max_age_days, DEFAULT_TRASH_MAX_AGE_DAYS);
        assert!(loaded.auto_prune_trash);

        save_config(&ctx, &loaded).unwrap();
        let reloaded = load_config(&ctx);
        assert_eq!(reloaded.ignored_agents, vec!["claude", "codex"]);
    }

    #[test]
    fn test_is_path_ignored_prefix_tilde_and_glob() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let ctx = CleanerContext::with_home(home.to_path_buf());
        let patterns = vec![
            "~/.claude/projects/vip-repo".to_string(),
            "~/.dsh/**/important-*".to_string(),
            "/opt/shared/*.log".to_string(),
        ];

        assert!(is_path_ignored(
            &ctx,
            &home
                .join(".claude/projects/vip-repo/session.jsonl")
                .to_string_lossy(),
            &patterns
        ));
        assert!(is_path_ignored(
            &ctx,
            &home
                .join(".dsh/profiles/web/important-cache")
                .to_string_lossy(),
            &patterns
        ));
        assert!(is_path_ignored(&ctx, "/opt/shared/run.log", &patterns));
        assert!(!is_path_ignored(
            &ctx,
            &home.join(".claude/projects/other-repo").to_string_lossy(),
            &patterns
        ));

        let win_patterns = vec![
            r"~\.claude\projects\vip".to_string(),
            r"C:\Users\Alice\AppData\Local\Cache\*".to_string(),
        ];
        assert!(is_path_ignored(
            &ctx,
            &home.join(".claude/projects/vip/s.jsonl").to_string_lossy(),
            &win_patterns
        ));
        assert!(is_path_ignored(
            &ctx,
            "c:/users/alice/appdata/local/cache/data.bin",
            &win_patterns
        ));
    }
}
