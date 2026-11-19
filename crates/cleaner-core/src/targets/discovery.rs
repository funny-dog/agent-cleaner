use crate::fs_safe::{get_dir_size, safe_mtime_ms};
use crate::recommendation::make_item;
use crate::types::{
    CleanRecommendation, CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult,
};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Default)]
pub struct CustomTargetsFile {
    #[serde(default)]
    pub targets: Vec<CustomTargetSpec>,
}

#[derive(Debug, Deserialize)]
pub struct CustomTargetSpec {
    pub id: String,
    #[serde(default)]
    pub usage_dirs: Vec<String>,
    #[serde(default)]
    pub mcp_configs: Vec<String>,
    #[serde(default)]
    pub cleanable: Vec<CustomCleanableSpec>,
}

#[derive(Debug, Deserialize)]
pub struct CustomCleanableSpec {
    pub path: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_category() -> String {
    "cache".to_string()
}

pub fn expand_tilde(ctx: &CleanerContext, raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        ctx.home_dir.join(rest)
    } else if raw == "~" {
        ctx.home_dir.clone()
    } else {
        PathBuf::from(raw)
    }
}

fn parse_category(raw: &str) -> ScanCategory {
    match raw.trim().to_ascii_lowercase().as_str() {
        "log" | "logs" => ScanCategory::Log,
        "tmp" | "temp" => ScanCategory::Tmp,
        "updater" => ScanCategory::Updater,
        "archive" => ScanCategory::Archive,
        "backup" => ScanCategory::Backup,
        "snapshot" => ScanCategory::Snapshot,
        _ => ScanCategory::Cache,
    }
}

/// Load user-defined agent targets from `~/.agent-cleaner/targets.toml` if present.
pub fn load_custom_targets(ctx: &CleanerContext) -> Vec<CustomTargetSpec> {
    let path = ctx.home_dir.join(".agent-cleaner/targets.toml");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    toml::from_str::<CustomTargetsFile>(&raw)
        .map(|f| f.targets)
        .unwrap_or_default()
}

pub fn custom_target_claimed_dirs(ctx: &CleanerContext) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for spec in load_custom_targets(ctx) {
        for raw in spec.usage_dirs {
            dirs.push(expand_tilde(ctx, &raw));
        }
        for c in spec.cleanable {
            dirs.push(expand_tilde(ctx, &c.path));
        }
    }
    dirs
}

pub fn custom_target_mcp_configs(ctx: &CleanerContext) -> Vec<PathBuf> {
    load_custom_targets(ctx)
        .into_iter()
        .flat_map(|t| t.mcp_configs.into_iter().map(|p| expand_tilde(ctx, &p)))
        .collect()
}

pub fn scan_custom_targets(
    ctx: &CleanerContext,
    exempt_hours: u64,
    lang: Language,
    agent_filter: Option<&[String]>,
) -> Vec<ScanResult> {
    let now_ms = ctx.now();
    let mut results = Vec::new();

    for spec in load_custom_targets(ctx) {
        let id = spec.id.trim().to_ascii_lowercase();
        if id.is_empty() {
            continue;
        }
        if let Some(filter) = agent_filter {
            if !filter.is_empty() && !filter.iter().any(|a| a == &id) {
                continue;
            }
        }

        let usage_dirs: Vec<PathBuf> = spec
            .usage_dirs
            .iter()
            .map(|p| expand_tilde(ctx, p))
            .collect();
        let cleanable_paths: Vec<(PathBuf, ScanCategory, String)> = spec
            .cleanable
            .iter()
            .map(|c| {
                let path = expand_tilde(ctx, &c.path);
                let desc = c.description.clone().unwrap_or_else(|| {
                    match lang {
                        Language::Zh => format!("{id} 自定义规则目录"),
                        Language::En => format!("{id} custom rule directory"),
                    }
                });
                (path, parse_category(&c.category), desc)
            })
            .collect();

        let any_exists = usage_dirs.iter().any(|d| d.exists())
            || cleanable_paths.iter().any(|(p, _, _)| p.exists());
        if !any_exists {
            continue;
        }

        let mut items = Vec::new();
        for (dir, cat, desc) in &cleanable_paths {
            if !dir.exists() {
                continue;
            }
            let size = get_dir_size(dir);
            if size == 0 {
                continue;
            }
            let mtime = safe_mtime_ms(dir, now_ms);
            items.push(make_item(
                &id,
                cat.clone(),
                dir.to_string_lossy().to_string(),
                size,
                mtime,
                desc.clone(),
                ItemStatus::Active,
                exempt_hours,
                now_ms,
                lang,
            ));
        }

        let disk_usage_bytes: u64 = if usage_dirs.is_empty() {
            items.iter().map(|i| i.size_bytes).sum()
        } else {
            usage_dirs.iter().map(|d| get_dir_size(d)).sum()
        };
        let total_bytes: u64 = items.iter().map(|i| i.size_bytes).sum();

        if disk_usage_bytes > 0 || !items.is_empty() {
            results.push(ScanResult {
                agent: id,
                items,
                total_bytes,
                disk_usage_bytes,
                scanned_at: now_ms,
            });
        }
    }

    results
}

const NON_AGENT_DOTDIRS: &[&str] = &[
    ".agent-cleaner",
    ".agents",
    ".aws",
    ".bash_sessions",
    ".bun",
    ".cache",
    ".cargo",
    ".conda",
    ".config",
    ".cups",
    ".docker",
    ".dotnet",
    ".gem",
    ".git",
    ".github",
    ".gnupg",
    ".gradle",
    ".homebrew",
    ".ipython",
    ".jupyter",
    ".kube",
    ".local",
    ".m2",
    ".matplotlib",
    ".node-gyp",
    ".npm",
    ".nuget",
    ".nvm",
    ".oh-my-zsh",
    ".orbstack",
    ".pnpm-store",
    ".pyenv",
    ".rustup",
    ".ssh",
    ".swiftpm",
    ".trash",
    ".venv",
    ".vim",
    ".vscode",
    ".vscode-shared",
    ".wrangler",
    ".yarn",
    ".zsh_sessions",
];

const NON_AGENT_XDG_DIRS: &[&str] = &[
    "gh",
    "git",
    "fish",
    "zsh",
    "nvim",
    "vim",
    "htop",
    "pip",
    "uv",
    "fontconfig",
    "yarn",
    "pnpm",
    "npm",
    "go",
    "cargo",
    "rustup",
    "homebrew",
    "raycast",
    "iterm2",
    "alacritty",
    "kitty",
    "wezterm",
    "tmux",
    "1password",
    "puppeteer",
    "ms-playwright",
    "zig",
    "pkg",
    "node",
    "tree-sitter",
];

const AGENT_MARKER_FILES: &[&str] = &[
    "mcp.json",
    "mcp_config.json",
    "mcp-config.json",
    "agents.md",
    "claude.md",
    "gemini.md",
    ".skill-lock.json",
];

const AGENT_MARKER_DIRS: &[&str] = &[
    "skills",
    "sessions",
    "file-history",
    "shell-snapshots",
    "ai-tracking",
    "prompts",
    "memories",
    "brain",
    "traces",
    "checkpoints",
    "conversations",
    "agent",
];

const AGENT_NAME_KEYWORDS: &[&str] = &[
    "agent",
    "aider",
    "amp",
    "antigravity",
    "augment",
    "claude",
    "cline",
    "codebuddy",
    "codeium",
    "codewhale",
    "codex",
    "cody",
    "continue",
    "copilot",
    "cursor",
    "devin",
    "dsh",
    "factory",
    "gemini",
    "goose",
    "jan",
    "kilo",
    "kimi",
    "kiro",
    "lmstudio",
    "mcp",
    "ollama",
    "openclaw",
    "opencode",
    "pearai",
    "qmind",
    "qoder",
    "roo",
    "supermaven",
    "tabnine",
    "trae",
    "void",
    "windsurf",
    "workbuddy",
    "zcode",
];

fn normalize_agent_id(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    let trimmed = trimmed
        .strip_suffix("-shared")
        .or_else(|| trimmed.strip_suffix(".shipit"))
        .or_else(|| trimmed.strip_suffix("-updater"))
        .unwrap_or(&trimmed);
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn is_apple_system_bundle(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("com.apple.")
        || lower.starts_with("group.com.apple.")
        || lower.starts_with("io.apple.")
        || lower == "apple"
}

fn name_matches_agent_keyword(name: &str) -> bool {
    if is_apple_system_bundle(name) {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(['.', '-', '_', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.iter().any(|t| AGENT_NAME_KEYWORDS.contains(t)) {
        return true;
    }
    const UNEQUIVOCAL_SUBSTRS: &[&str] = &[
        "antigravity",
        "augment",
        "claude",
        "cline",
        "codebuddy",
        "codeium",
        "codewhale",
        "codex",
        "copilot",
        "cursor",
        "kilocode",
        "lmstudio",
        "openclaw",
        "opencode",
        "pearai",
        "qmind",
        "qoder",
        "supermaven",
        "tabnine",
        "windsurf",
        "workbuddy",
        "zcode",
    ];
    if UNEQUIVOCAL_SUBSTRS.iter().any(|kw| lower.contains(kw)) {
        return true;
    }
    // Match *agent (e.g. sheetagent, myagent) only on non-Apple bundles.
    tokens.iter().any(|t| t.ends_with("agent") || t.starts_with("agent"))
}

fn is_path_claimed(candidate: &Path, claimed: &HashSet<PathBuf>) -> bool {
    if claimed.contains(candidate) {
        return true;
    }
    if let Ok(canon) = fs::canonicalize(candidate) {
        if claimed.contains(&canon) {
            return true;
        }
    }
    claimed.iter().any(|c| candidate.starts_with(c))
}

fn has_agent_markers(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let path = entry.path();
        if path.is_file() && AGENT_MARKER_FILES.contains(&name.as_str()) {
            return true;
        }
        if path.is_dir() && AGENT_MARKER_DIRS.contains(&name.as_str()) {
            return true;
        }
    }
    false
}

fn classify_cleanable_subdir(name: &str) -> Option<(ScanCategory, &'static str, &'static str)> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "logs" | "log" | "diagnostics" => {
            Some((ScanCategory::Log, "自动发现运行日志", "auto-discovered runtime logs"))
        }
        "tmp" | "temp" | ".tmp" | "crash" | "crashes" | "crashpad" => Some((
            ScanCategory::Tmp,
            "自动发现临时/崩溃缓存",
            "auto-discovered temp/crash artifacts",
        )),
        "cache" | "caches" | "code cache" | "gpucache" | "cacheddata" | "graphitedawncache"
        | "dawngraphitecache" | "dawnwebgpucache" => {
            Some((ScanCategory::Cache, "自动发现缓存目录", "auto-discovered cache directory"))
        }
        "backup" | "backups" | "config-backups" => {
            Some((ScanCategory::Backup, "自动发现历史备份", "auto-discovered historical backups"))
        }
        "updates" => Some((
            ScanCategory::Updater,
            "自动发现更新器缓存",
            "auto-discovered updater cache",
        )),
        _ if lower.contains("updater") || lower == "shipit" => Some((
            ScanCategory::Updater,
            "自动发现更新器缓存",
            "auto-discovered updater cache",
        )),
        _ => None,
    }
}

fn collect_safe_cleanable_subdirs(
    root: &Path,
    depth: u8,
    out: &mut Vec<(PathBuf, ScanCategory, &'static str, &'static str)>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_file() {
            if depth == 0 && name.to_ascii_lowercase().ends_with(".log") {
                out.push((
                    path,
                    ScanCategory::Log,
                    "自动发现运行日志文件",
                    "auto-discovered runtime log file",
                ));
            }
            continue;
        }
        if !ft.is_dir() {
            continue;
        }
        if let Some((cat, zh, en)) = classify_cleanable_subdir(&name) {
            out.push((path, cat, zh, en));
        } else if depth == 0
            && (name.eq_ignore_ascii_case("v1")
                || name.eq_ignore_ascii_case("v2")
                || name.eq_ignore_ascii_case("default"))
        {
            collect_safe_cleanable_subdirs(&path, 1, out);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_heuristic_item(
    agent: &str,
    category: ScanCategory,
    path: &Path,
    zh_kind: &str,
    en_kind: &str,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) -> Option<ScanItem> {
    let size_bytes = get_dir_size(path);
    if size_bytes == 0 {
        return None;
    }
    let mtime_ms = safe_mtime_ms(path, now_ms);
    let desc = match lang {
        Language::Zh => format!("{agent} {zh_kind}"),
        Language::En => format!("{agent} {en_kind}"),
    };
    let mut item = make_item(
        agent,
        category,
        path.to_string_lossy().to_string(),
        size_bytes,
        mtime_ms,
        desc,
        ItemStatus::Active,
        exempt_hours,
        now_ms,
        lang,
    );
    // Safety guard: never auto-recommend cleaning on heuristically discovered unknown agents.
    if item.recommendation == CleanRecommendation::Recommended {
        item.recommendation = CleanRecommendation::Optional;
        item.recommendation_reason = lang
            .tr(
                "启发式自动发现的未知 Agent 目录，建议人工复核后再清理",
                "Auto-discovered unknown agent directory; review before cleaning",
            )
            .to_string();
    }
    Some(item)
}

#[derive(Clone, Copy)]
enum DiscoveryRootKind {
    Standard,
    CacheRoot,
    LogRoot,
}

/// Safely discover AI agent directories not covered by built-in or custom targets.
pub fn discover_unknown_agent_results(
    ctx: &CleanerContext,
    claimed_dirs: &[PathBuf],
    exempt_hours: u64,
    lang: Language,
    agent_filter: Option<&[String]>,
) -> Vec<ScanResult> {
    let now_ms = ctx.now();
    let mut claimed: HashSet<PathBuf> = HashSet::new();
    for d in claimed_dirs {
        claimed.insert(d.clone());
        if let Ok(canon) = fs::canonicalize(d) {
            claimed.insert(canon);
        }
    }

    // Gather candidate (agent_id, dir, root_kind)
    let mut candidates: Vec<(String, PathBuf, DiscoveryRootKind)> = Vec::new();

    if let Ok(entries) = fs::read_dir(&ctx.home_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            if NON_AGENT_DOTDIRS.contains(&lower.as_str()) || is_path_claimed(&path, &claimed) {
                continue;
            }
            if has_agent_markers(&path) || name_matches_agent_keyword(&name) {
                let id = normalize_agent_id(&name);
                if !id.is_empty() {
                    candidates.push((id, path, DiscoveryRootKind::Standard));
                }
            }
        }
    }

    for (parent, kind) in [
        (ctx.home_dir.join(".config"), DiscoveryRootKind::Standard),
        (ctx.home_dir.join(".local/share"), DiscoveryRootKind::Standard),
        (ctx.home_dir.join(".cache"), DiscoveryRootKind::CacheRoot),
    ] {
        if let Ok(entries) = fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if !ft.is_dir() || ft.is_symlink() || is_path_claimed(&path, &claimed) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_ascii_lowercase();
                if NON_AGENT_XDG_DIRS.contains(&lower.as_str()) {
                    continue;
                }
                if has_agent_markers(&path) || name_matches_agent_keyword(&name) {
                    let id = normalize_agent_id(&name);
                    if !id.is_empty() {
                        candidates.push((id, path, kind));
                    }
                }
            }
        }
    }

    for (parent, kind) in [
        (ctx.home_dir.join("Library/Application Support"), DiscoveryRootKind::Standard),
        (ctx.home_dir.join("Library/Caches"), DiscoveryRootKind::CacheRoot),
        (ctx.home_dir.join("Library/Logs"), DiscoveryRootKind::LogRoot),
    ] {
        if let Ok(entries) = fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if !ft.is_dir() || ft.is_symlink() || is_path_claimed(&path, &claimed) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name_matches_agent_keyword(&name) || has_agent_markers(&path) {
                    let id = normalize_agent_id(&name);
                    if !id.is_empty() {
                        candidates.push((id, path, kind));
                    }
                }
            }
        }
    }

    let mut grouped: BTreeMap<String, (Vec<PathBuf>, Vec<ScanItem>)> = BTreeMap::new();

    for (agent_id, root_dir, root_kind) in candidates {
        if let Some(filter) = agent_filter {
            if !filter.is_empty() && !filter.iter().any(|a| a == &agent_id) {
                continue;
            }
        }

        let entry = grouped.entry(agent_id.clone()).or_default();
        entry.0.push(root_dir.clone());

        match root_kind {
            DiscoveryRootKind::CacheRoot => {
                let dir_name = root_dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let (cat, zh, en) = if dir_name.to_ascii_lowercase().contains("updater")
                    || dir_name.to_ascii_lowercase().contains("shipit")
                {
                    (ScanCategory::Updater, "自动发现更新器缓存", "auto-discovered updater cache")
                } else {
                    (ScanCategory::Cache, "自动发现系统应用缓存", "auto-discovered application cache")
                };
                if let Some(item) = make_heuristic_item(
                    &agent_id,
                    cat,
                    &root_dir,
                    zh,
                    en,
                    exempt_hours,
                    now_ms,
                    lang,
                ) {
                    entry.1.push(item);
                }
            }
            DiscoveryRootKind::LogRoot => {
                if let Some(item) = make_heuristic_item(
                    &agent_id,
                    ScanCategory::Log,
                    &root_dir,
                    "自动发现系统运行日志",
                    "auto-discovered macOS Library logs",
                    exempt_hours,
                    now_ms,
                    lang,
                ) {
                    entry.1.push(item);
                }
            }
            DiscoveryRootKind::Standard => {
                let mut subdirs = Vec::new();
                collect_safe_cleanable_subdirs(&root_dir, 0, &mut subdirs);
                for (sub, cat, zh, en) in subdirs {
                    if let Some(item) = make_heuristic_item(
                        &agent_id,
                        cat,
                        &sub,
                        zh,
                        en,
                        exempt_hours,
                        now_ms,
                        lang,
                    ) {
                        entry.1.push(item);
                    }
                }
            }
        }
    }

    grouped
        .into_iter()
        .filter_map(|(agent, (roots, items))| {
            // Only surface unknown agents when there is actually something cleanable.
            if items.is_empty() {
                return None;
            }
            let disk_usage_bytes = roots.iter().map(|d| get_dir_size(d)).sum();
            let total_bytes = items.iter().map(|i| i.size_bytes).sum();
            Some(ScanResult {
                agent,
                items,
                total_bytes,
                disk_usage_bytes,
                scanned_at: now_ms,
            })
        })
        .collect()
}

/// Discover MCP config files dynamically across `~/.<agent>/` and `~/.config/<agent>/`.
pub fn discover_dynamic_mcp_configs(ctx: &CleanerContext) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let candidate_names = [
        "mcp.json",
        "mcp_config.json",
        "mcp-config.json",
        "settings.json",
    ];

    if let Ok(entries) = fs::read_dir(&ctx.home_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') || NON_AGENT_DOTDIRS.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            for fname in candidate_names {
                let p = path.join(fname);
                if p.is_file() {
                    found.push(p);
                }
            }
            let nested = path.join("settings/mcp.json");
            if nested.is_file() {
                found.push(nested);
            }
        }
    }

    if let Ok(entries) = fs::read_dir(ctx.home_dir.join(".config")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if NON_AGENT_XDG_DIRS.contains(&name.as_str()) {
                continue;
            }
            for fname in ["mcp.json", "mcp_config.json", "mcp-config.json"] {
                let p = path.join(fname);
                if p.is_file() {
                    found.push(p);
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(ctx.home_dir.join("Library/Application Support")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            for rel in ["claude_desktop_config.json", "User/mcp.json"] {
                let p = path.join(rel);
                if p.is_file() {
                    found.push(p);
                }
            }
            let global_storage = path.join("User/globalStorage");
            for ext_id in [
                "saoudrizwan.claude-dev",
                "rooveterinaryinc.roo-cline",
                "kilocode.kilo-code",
            ] {
                for settings_file in ["cline_mcp_settings.json", "mcp_settings.json"] {
                    let p = global_storage.join(ext_id).join("settings").join(settings_file);
                    if p.is_file() {
                        found.push(p);
                    }
                }
            }
        }
    }

    found
}
