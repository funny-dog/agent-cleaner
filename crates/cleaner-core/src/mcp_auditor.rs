use crate::targets::cold_cache::collect_cold_caches;
use crate::targets::discovery::{custom_target_mcp_configs, discover_dynamic_mcp_configs};
use crate::types::{
    CleanerContext, ColdCacheEntry, KillProcessResult, McpAuditReport, McpEntry, McpProcessInfo,
    McpTransport,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System, UpdateKind};

pub(crate) struct RawMcpServer {
    pub location_path: Vec<String>,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
}

fn path_exists_as_executable(p: &Path) -> bool {
    #[cfg(windows)]
    {
        if p.is_file() {
            return true;
        }
        if p.extension().is_none() {
            let raw = p.to_string_lossy();
            let pathext =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".to_string());
            for ext in pathext.split(';').map(str::trim).filter(|e| !e.is_empty()) {
                let with_ext = if ext.starts_with('.') {
                    format!("{raw}{ext}")
                } else {
                    format!("{raw}.{ext}")
                };
                if Path::new(&with_ext).is_file() {
                    return true;
                }
            }
            for ext in [".exe", ".cmd", ".bat", ".ps1", ".com"] {
                if Path::new(&format!("{raw}{ext}")).is_file() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        p.is_file()
    }
}

fn candidate_exists_in_dir(dir: &Path, bin: &str) -> bool {
    path_exists_as_executable(&dir.join(bin))
}

fn expand_command_vars(raw: &str) -> String {
    let mut out = raw.to_string();
    let lower = out.to_ascii_lowercase();
    for key in [
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        let token_lower = format!("%{}%", key.to_ascii_lowercase());
        if lower.contains(&token_lower) {
            let val = std::env::var(key).ok().or_else(|| {
                if key == "USERPROFILE" {
                    dirs::home_dir().map(|h| h.to_string_lossy().to_string())
                } else {
                    None
                }
            });
            if let Some(replacement) = val {
                while let Some(idx) = out.to_ascii_lowercase().find(&token_lower) {
                    out.replace_range(idx..idx + token_lower.len(), &replacement);
                }
            }
        }
    }
    if let Some(rest) = out.strip_prefix("~/").or_else(|| out.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    out
}

fn extract_first_command_token(trimmed: &str) -> &str {
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return &rest[..end];
        }
        return rest;
    }
    if let Some(rest) = trimmed.strip_prefix('\'') {
        if let Some(end) = rest.find('\'') {
            return &rest[..end];
        }
        return rest;
    }
    trimmed.split_whitespace().next().unwrap_or("")
}

fn push_versioned_bin_dirs(base: &Path, suffix: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = if suffix.is_empty() {
            entry.path()
        } else {
            entry.path().join(suffix)
        };
        if candidate.is_dir() {
            out.push(candidate);
        }
    }
}

pub(crate) fn command_exists(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return false;
    }

    let unquoted_full = trimmed.trim_matches(['"', '\'']);
    let expanded_full = expand_command_vars(unquoted_full);
    let raw_path = Path::new(&expanded_full);
    if raw_path.is_absolute() && path_exists_as_executable(raw_path) {
        return true;
    }

    let first_tok = extract_first_command_token(trimmed);
    if first_tok.is_empty() {
        return false;
    }
    let bin = expand_command_vars(first_tok);
    if bin.is_empty() {
        return false;
    }

    let path = Path::new(&bin);
    if path.is_absolute() {
        return path_exists_as_executable(path);
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if candidate_exists_in_dir(&dir, &bin) {
                return true;
            }
        }
    }

    let mut fallback_dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    for env_key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(env_key) {
            fallback_dirs.push(PathBuf::from(pf).join("nodejs"));
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let lad = PathBuf::from(local_app_data);
        fallback_dirs.push(lad.join("Volta/bin"));
        fallback_dirs.push(lad.join("Programs/Microsoft VS Code/bin"));
        fallback_dirs.push(lad.join("Microsoft/WindowsApps"));
        push_versioned_bin_dirs(&lad.join("Programs/Python"), "", &mut fallback_dirs);
        push_versioned_bin_dirs(&lad.join("Programs/Python"), "Scripts", &mut fallback_dirs);
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        fallback_dirs.push(PathBuf::from(app_data).join("Python/Scripts"));
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".local/share/mise/shims",
            ".local/share/pnpm",
            "Library/pnpm",
            "AppData/Local/pnpm",
            "AppData/Roaming/npm",
            "AppData/Roaming/Python/Scripts",
            "AppData/Local/Microsoft/WinGet/Links",
            "AppData/Local/Volta/bin",
            "AppData/Local/Programs/Microsoft VS Code/bin",
            "AppData/Local/Microsoft/WindowsApps",
            "scoop/shims",
            ".npm-global/bin",
            ".yarn/bin",
            ".config/yarn/global/node_modules/.bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".volta/bin",
            ".asdf/shims",
            ".pyenv/shims",
            ".pixi/bin",
            "go/bin",
        ] {
            fallback_dirs.push(home.join(rel));
        }
        push_versioned_bin_dirs(&home.join(".nvm/versions/node"), "bin", &mut fallback_dirs);
        push_versioned_bin_dirs(
            &home.join(".fnm/node-versions"),
            "installation/bin",
            &mut fallback_dirs,
        );
        push_versioned_bin_dirs(
            &home.join("Library/Application Support/fnm/node-versions"),
            "installation/bin",
            &mut fallback_dirs,
        );
        push_versioned_bin_dirs(
            &home.join("AppData/Roaming/fnm/node-versions"),
            "installation/bin",
            &mut fallback_dirs,
        );
        push_versioned_bin_dirs(
            &home.join("AppData/Local/Programs/Python"),
            "",
            &mut fallback_dirs,
        );
        push_versioned_bin_dirs(
            &home.join("AppData/Local/Programs/Python"),
            "Scripts",
            &mut fallback_dirs,
        );
    }

    fallback_dirs
        .iter()
        .any(|dir| candidate_exists_in_dir(dir, &bin))
}

fn detect_transport(
    transport: Option<&str>,
    typ: Option<&str>,
    url: Option<&str>,
    command: Option<&str>,
) -> McpTransport {
    if let Some(t) = transport.or(typ) {
        let lower = t.trim().to_ascii_lowercase();
        if lower == "sse" {
            return McpTransport::Sse;
        }
        if matches!(
            lower.as_str(),
            "http" | "streamable-http" | "streamable_http" | "remote"
        ) {
            return McpTransport::Http;
        }
        if matches!(lower.as_str(), "stdio" | "local") {
            return McpTransport::Stdio;
        }
    }
    if url.is_some() && command.is_none() {
        return McpTransport::Sse;
    }
    McpTransport::Stdio
}

fn extract_string_array(val: Option<&serde_json::Value>) -> Option<Vec<String>> {
    val.and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(ToString::to_string))
            .collect()
    })
}

pub(crate) fn extract_server_spec(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> (
    McpTransport,
    Option<String>,
    Option<Vec<String>>,
    Option<String>,
) {
    let url = obj
        .get("url")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);

    let (command, args) = match obj.get("command") {
        Some(serde_json::Value::String(s)) => {
            (Some(s.clone()), extract_string_array(obj.get("args")))
        }
        Some(serde_json::Value::Array(arr)) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str().map(ToString::to_string))
                .collect();
            if parts.is_empty() {
                (None, extract_string_array(obj.get("args")))
            } else {
                let cmd = parts[0].clone();
                let tail = if parts.len() > 1 {
                    Some(parts[1..].to_vec())
                } else {
                    extract_string_array(obj.get("args"))
                };
                (Some(cmd), tail)
            }
        }
        Some(serde_json::Value::Object(cmd_obj)) => {
            let cmd = cmd_obj
                .get("path")
                .or_else(|| cmd_obj.get("command"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let args = extract_string_array(cmd_obj.get("args"))
                .or_else(|| extract_string_array(obj.get("args")));
            (cmd, args)
        }
        _ => (None, extract_string_array(obj.get("args"))),
    };

    let transport = detect_transport(
        obj.get("transport").and_then(|v| v.as_str()),
        obj.get("type").and_then(|v| v.as_str()),
        url.as_deref(),
        command.as_deref(),
    );

    (transport, command, args, url)
}

fn collect_server_map(
    servers: &serde_json::Map<String, serde_json::Value>,
    prefix: &[&str],
    out: &mut Vec<RawMcpServer>,
) {
    for (name, cfg) in servers {
        let Some(obj) = cfg.as_object() else {
            continue;
        };
        let (transport, command, args, url) = extract_server_spec(obj);
        let mut location_path: Vec<String> = prefix.iter().map(|s| (*s).to_string()).collect();
        location_path.push(name.clone());
        out.push(RawMcpServer {
            location_path,
            name: name.clone(),
            transport,
            command,
            args,
            url,
        });
    }
}

pub(crate) fn extract_mcp_servers_from_value(val: &serde_json::Value) -> Vec<RawMcpServer> {
    let mut out = Vec::new();

    for top_key in ["mcpServers", "mcp_servers", "context_servers"] {
        if let Some(servers) = val.get(top_key).and_then(|v| v.as_object()) {
            collect_server_map(servers, &[top_key], &mut out);
        }
    }

    if let Some(mcp_obj) = val.get("mcp").and_then(|v| v.as_object()) {
        let mut servers_is_nested_map = false;
        if let Some(servers_obj) = mcp_obj.get("servers").and_then(|v| v.as_object()) {
            let looks_like_single_server =
                servers_obj.contains_key("command") || servers_obj.contains_key("url");
            if !looks_like_single_server {
                servers_is_nested_map = true;
                collect_server_map(servers_obj, &["mcp", "servers"], &mut out);
            }
        }
        for (name, cfg) in mcp_obj {
            if servers_is_nested_map && name == "servers" {
                continue;
            }
            let Some(obj) = cfg.as_object() else {
                continue;
            };
            if !(obj.contains_key("command")
                || obj.contains_key("url")
                || obj.contains_key("type")
                || obj.contains_key("transport"))
            {
                continue;
            }
            let (transport, command, args, url) = extract_server_spec(obj);
            out.push(RawMcpServer {
                location_path: vec!["mcp".to_string(), name.clone()],
                name: name.clone(),
                transport,
                command,
                args,
                url,
            });
        }
    }

    if let Some(projects) = val.get("projects").and_then(|v| v.as_object()) {
        for (proj_path, proj_val) in projects {
            if let Some(servers) = proj_val.get("mcpServers").and_then(|v| v.as_object()) {
                collect_server_map(servers, &["projects", proj_path, "mcpServers"], &mut out);
            }
        }
    }

    if let Some(servers) = val.get("servers").and_then(|v| v.as_object()) {
        let looks_like_mcp_map = servers.values().any(|v| {
            v.as_object()
                .is_some_and(|o| o.contains_key("command") || o.contains_key("url"))
        });
        if looks_like_mcp_map {
            collect_server_map(servers, &["servers"], &mut out);
        }
    }

    out
}

fn extract_entries_from_json_value(
    val: &serde_json::Value,
    config_path: &Path,
    agent: &str,
) -> Vec<McpEntry> {
    let config_str = config_path.to_string_lossy().to_string();
    extract_mcp_servers_from_value(val)
        .into_iter()
        .map(|srv| McpEntry {
            name: srv.name,
            transport: srv.transport,
            command: srv.command,
            args: srv.args,
            url: srv.url,
            config_path: config_str.clone(),
            agent: agent.to_string(),
        })
        .collect()
}

pub(crate) fn infer_agent_from_path(config_path: &Path) -> String {
    let lower = config_path
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/");
    for (needle, agent) in [
        ("roo-cline", "roo"),
        ("claude-dev", "cline"),
        ("kilocode", "kilocode"),
        (".claude", "claude"),
        ("/claude", "claude"),
        ("opencode", "opencode"),
        (".codex", "codex"),
        (".dsh", "dsh"),
        (".cursor", "cursor"),
        ("/cursor/", "cursor"),
        ("windsurf", "windsurf"),
        (".codeium", "windsurf"),
        (".gemini", "gemini"),
        ("antigravity", "gemini"),
        (".workbuddy", "workbuddy"),
        ("/workbuddy", "workbuddy"),
        (".kiro", "kiro"),
        ("/kiro", "kiro"),
        (".kimi", "kimi"),
        ("/kimi", "kimi"),
        (".qoder", "qoder"),
        ("/qoder", "qoder"),
        (".trae", "trae"),
        ("/trae", "trae"),
        (".continue", "continue"),
        (".copilot", "copilot"),
        (".zcode", "zcode"),
        ("/zcode", "zcode"),
        (".codebuddy", "codebuddy"),
        ("/codebuddy", "codebuddy"),
        (".devin", "devin"),
        ("/devin/", "devin"),
        ("/zed/", "zed"),
    ] {
        if lower.contains(needle) {
            return agent.to_string();
        }
    }

    if let Some(parent) = config_path.parent() {
        let mut cur = Some(parent);
        while let Some(dir) = cur {
            if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') && name != ".config" {
                    return name.trim_start_matches('.').to_ascii_lowercase();
                }
                if dir
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    == Some(".config")
                {
                    return name.to_ascii_lowercase();
                }
            }
            cur = dir.parent();
        }
    }
    "unknown".to_string()
}

pub fn parse_mcp_entries(config_path: &Path) -> Vec<McpEntry> {
    let Ok(raw) = fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let lower = config_path.to_string_lossy().to_lowercase();
    let agent = infer_agent_from_path(config_path);

    if lower.ends_with(".toml") {
        if let Ok(val) = toml::from_str::<serde_json::Value>(&raw) {
            return extract_entries_from_json_value(&val, config_path, &agent);
        }
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        if let Ok(val) = serde_yml::from_str::<serde_json::Value>(&raw) {
            return extract_entries_from_json_value(&val, config_path, &agent);
        }
    } else if lower.ends_with(".json") || lower.ends_with(".jsonc") {
        if let Ok(Some(val)) = jsonc_parser::parse_to_serde_value::<Option<serde_json::Value>>(
            &raw,
            &Default::default(),
        ) {
            return extract_entries_from_json_value(&val, config_path, &agent);
        }
    }

    Vec::new()
}

pub fn known_config_paths(ctx: &CleanerContext) -> Vec<PathBuf> {
    let mut paths = vec![
        ctx.home_dir.join(".claude/settings.json"),
        ctx.home_dir.join(".claude/settings.local.json"),
        ctx.home_dir.join(".claude.json"),
        ctx.home_dir.join(".config/opencode/opencode.jsonc"),
        ctx.home_dir.join(".config/opencode/opencode.json"),
        ctx.home_dir.join(".codex/config.toml"),
        ctx.home_dir.join(".dsh/settings.yaml"),
        ctx.home_dir.join(".dsh/settings.yml"),
        ctx.home_dir.join(".cursor/mcp.json"),
        ctx.home_dir.join(".codeium/windsurf/mcp_config.json"),
        ctx.home_dir.join(".windsurf/mcp.json"),
        ctx.home_dir.join(".gemini/antigravity/mcp_config.json"),
        ctx.home_dir.join(".gemini/settings.json"),
        ctx.home_dir.join(".kiro/settings/mcp.json"),
        ctx.home_dir.join(".kimi/mcp.json"),
        ctx.home_dir.join(".kimi-code/mcp.json"),
        ctx.home_dir.join(".kimi-work/mcp.json"),
        ctx.home_dir.join(".qoder/mcp.json"),
        ctx.home_dir.join(".qoder/settings.json"),
        ctx.home_dir.join(".qoder-cn/mcp.json"),
        ctx.home_dir.join(".qoder-cn/settings.json"),
        ctx.home_dir.join(".qoder.json"),
        ctx.home_dir.join(".workbuddy/mcp.json"),
        ctx.home_dir.join(".workbuddy-ai/mcp.json"),
        ctx.home_dir.join(".trae/mcp.json"),
        ctx.home_dir.join(".trae-cn/mcp.json"),
        ctx.home_dir.join(".continue/config.json"),
        ctx.home_dir.join(".copilot/mcp-config.json"),
        ctx.home_dir.join(".zcode/mcp.json"),
        ctx.home_dir.join(".codebuddy/mcp.json"),
        ctx.home_dir
            .join("Library/Application Support/Zed/settings.json"),
        ctx.home_dir.join(".config/zed/settings.json"),
        ctx.home_dir.join("AppData/Roaming/Zed/settings.json"),
    ];
    for variant in [
        "Claude",
        "Claude-3p",
        "Claude-kiro",
        "Claude-qoder-cn-3p",
        "Claude-wb-cn",
        "Claude-wb-cn-3p",
        "MultiClaude",
    ] {
        for dir in crate::targets::platform_support_dirs(ctx, variant) {
            paths.push(dir.join("claude_desktop_config.json"));
        }
    }
    paths.extend(custom_target_mcp_configs(ctx));
    paths.extend(discover_dynamic_mcp_configs(ctx));

    let mut seen = HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

pub fn scan_cold_caches(ctx: &CleanerContext) -> Vec<ColdCacheEntry> {
    collect_cold_caches(ctx)
}

const GENERIC_RUNNERS: &[&str] = &[
    "npx", "npm", "pnpm", "yarn", "bun", "bunx", "deno", "node", "python", "python3", "uv", "uvx",
    "pipx", "sh", "bash", "zsh", "docker",
];

fn strip_pkg_version(arg: &str) -> &str {
    if arg.starts_with("http://")
        || arg.starts_with("https://")
        || (arg.contains('/') && !arg.starts_with('@'))
    {
        return arg;
    }
    if let Some(rest) = arg.strip_prefix('@') {
        if let Some(slash_idx) = rest.find('/') {
            if let Some(at_idx) = rest[slash_idx..].find('@') {
                return &arg[..1 + slash_idx + at_idx];
            }
        }
        return arg;
    }
    arg.split('@').next().unwrap_or(arg)
}

fn extract_effective_arg_needles(args: &[String]) -> Vec<String> {
    let mut needles = Vec::new();
    for raw in args {
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('-')
            || matches!(
                trimmed,
                "exec" | "run" | "dlx" | "x" | "stdio" | "true" | "false"
            )
        {
            continue;
        }
        let stripped = strip_pkg_version(trimmed);
        if stripped.len() >= 3 {
            needles.push(stripped.to_string());
        }
        if stripped != trimmed && trimmed.len() >= 3 {
            needles.push(trimmed.to_string());
        }
    }
    needles
}

fn path_basename_no_win_ext(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(['"', '\'']);
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stripped) = base.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    base
}

fn entry_matches_process_cmd(entry: &McpEntry, proc_cmd: &str) -> bool {
    let Some(cmd_raw) = entry.command.as_deref() else {
        return false;
    };
    let cmd_str = cmd_raw.trim().trim_matches(['"', '\'']);
    if cmd_str.is_empty() {
        return false;
    }
    let basename = path_basename_no_win_ext(cmd_str);
    let is_generic = GENERIC_RUNNERS.contains(&basename.as_str());
    let proc_norm = proc_cmd.replace('\\', "/").to_ascii_lowercase();

    let effective_args = entry
        .args
        .as_deref()
        .map(extract_effective_arg_needles)
        .unwrap_or_default();

    if is_generic && !effective_args.is_empty() {
        return effective_args.iter().any(|needle| {
            let needle_norm = needle.replace('\\', "/").to_ascii_lowercase();
            proc_norm.contains(&needle_norm)
        });
    }

    let cmd_norm = cmd_str.replace('\\', "/").to_ascii_lowercase();
    if proc_norm.contains(&cmd_norm) {
        return true;
    }

    if !is_generic && basename.len() >= 4 {
        let first_tok = extract_first_command_token(proc_cmd.trim());
        if !first_tok.is_empty() && path_basename_no_win_ext(first_tok) == basename {
            return true;
        }
    }

    false
}

#[cfg(windows)]
fn is_windows_orphan_process(sys: &System, proc_info: &sysinfo::Process) -> bool {
    let Some(parent_pid) = proc_info.parent() else {
        return false;
    };
    let ppid = parent_pid.as_u32();
    if ppid <= 4 {
        return false;
    }
    match sys.process(parent_pid) {
        None => true,
        Some(parent_proc) => parent_proc.start_time() > proc_info.start_time(),
    }
}

pub fn scan_orphan_mcp_processes(entries: &[McpEntry]) -> Vec<McpProcessInfo> {
    let stdio_entries: Vec<&McpEntry> = entries
        .iter()
        .filter(|e| {
            e.transport == McpTransport::Stdio
                && e.command.as_deref().is_some_and(|c| !c.is_empty())
        })
        .collect();

    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_memory(),
        ),
    );
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_memory(),
    );

    let mut orphans = Vec::new();
    for (pid, proc_info) in sys.processes() {
        let ppid = proc_info.parent().map(|p| p.as_u32()).unwrap_or(0);
        #[cfg(unix)]
        let is_orphan_parent = ppid == 1;
        #[cfg(windows)]
        let is_orphan_parent = is_windows_orphan_process(&sys, proc_info);
        if !is_orphan_parent {
            continue;
        }
        let cmd_parts: Vec<String> = proc_info
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        let command = if cmd_parts.is_empty() {
            proc_info.name().to_string_lossy().to_string()
        } else {
            cmd_parts.join(" ")
        };

        let matched = stdio_entries
            .iter()
            .find(|e| entry_matches_process_cmd(e, &command));

        let lower_cmd = command.to_ascii_lowercase();
        let is_remote_service = lower_cmd.contains("--port")
            || lower_cmd.contains("sse")
            || lower_cmd.contains("streamable-http");
        let by_marker = !is_remote_service
            && (((lower_cmd.contains("@modelcontextprotocol")
                || lower_cmd.contains("mcp-server"))
                && lower_cmd.contains("stdio"))
                || lower_cmd.contains("fastmcp")
                || lower_cmd.contains("mcp-proxy"));

        if matched.is_some() || by_marker {
            orphans.push(McpProcessInfo {
                pid: pid.as_u32(),
                ppid,
                rss_kb: proc_info.memory() / 1024,
                state: format!("{:?}", proc_info.status()),
                command,
                matched_name: matched.map(|m| m.name.clone()),
                matched_agent: matched.map(|m| m.agent.clone()),
                is_orphan: true,
            });
        }
    }
    orphans
}

pub fn audit_mcp(ctx: &CleanerContext) -> McpAuditReport {
    let mut entries = Vec::new();
    for path in known_config_paths(ctx) {
        entries.extend(parse_mcp_entries(&path));
    }

    let dead_links: Vec<McpEntry> = entries
        .iter()
        .filter(|e| e.transport == McpTransport::Stdio)
        .filter(|e| e.command.as_deref().is_some_and(|c| !command_exists(c)))
        .cloned()
        .collect();

    let mut groups: HashMap<String, Vec<McpEntry>> = HashMap::new();
    let mut by_name: HashMap<String, Vec<McpEntry>> = HashMap::new();
    for entry in &entries {
        let target = entry
            .command
            .as_deref()
            .or(entry.url.as_deref())
            .unwrap_or("");
        let key = format!("{}::{target}", entry.name);
        groups.entry(key).or_default().push(entry.clone());
        by_name
            .entry(entry.name.clone())
            .or_default()
            .push(entry.clone());
    }

    let duplicates: Vec<Vec<McpEntry>> = groups
        .into_values()
        .filter(|group| {
            let agents: HashSet<&str> = group.iter().map(|e| e.agent.as_str()).collect();
            agents.len() > 1
        })
        .collect();

    // Detect cross-agent MCP entries sharing the same server name but differing in command/args/url.
    type McpSig<'a> = (
        &'a str,
        Option<&'a str>,
        Option<&'a [String]>,
        Option<&'a str>,
    );
    let conflicts: Vec<Vec<McpEntry>> = by_name
        .into_values()
        .filter(|group| {
            let agents: HashSet<&str> = group.iter().map(|e| e.agent.as_str()).collect();
            if agents.len() <= 1 {
                return false;
            }
            let sigs: HashSet<McpSig<'_>> = group
                .iter()
                .map(|e| {
                    let t = match e.transport {
                        McpTransport::Stdio => "stdio",
                        McpTransport::Sse => "sse",
                        McpTransport::Http => "http",
                    };
                    (t, e.command.as_deref(), e.args.as_deref(), e.url.as_deref())
                })
                .collect();
            sigs.len() > 1
        })
        .collect();

    let orphan_processes = if ctx.skip_system_processes {
        Vec::new()
    } else {
        scan_orphan_mcp_processes(&entries)
    };

    let cold_caches = scan_cold_caches(ctx);

    McpAuditReport {
        entries,
        dead_links,
        duplicates,
        conflicts,
        orphan_processes,
        cold_caches,
    }
}

fn is_pid_alive(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        false,
    );
    sys.process(Pid::from_u32(pid)).is_some()
}

pub fn kill_orphan_process(pid: u32) -> KillProcessResult {
    if !is_pid_alive(pid) {
        return KillProcessResult {
            pid,
            success: true,
            method: "already_gone".to_string(),
        };
    }

    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        thread::sleep(Duration::from_millis(1500));

        if !is_pid_alive(pid) {
            return KillProcessResult {
                pid,
                success: true,
                method: "SIGTERM".to_string(),
            };
        }

        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
        thread::sleep(Duration::from_millis(200));

        KillProcessResult {
            pid,
            success: !is_pid_alive(pid),
            method: "SIGKILL".to_string(),
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        thread::sleep(Duration::from_millis(500));
        if !is_pid_alive(pid) {
            return KillProcessResult {
                pid,
                success: true,
                method: "SIGTERM".to_string(),
            };
        }
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        thread::sleep(Duration::from_millis(200));
        KillProcessResult {
            pid,
            success: !is_pid_alive(pid),
            method: "SIGKILL".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_entry(command: &str, args: Vec<&str>) -> McpEntry {
        McpEntry {
            name: "test".to_string(),
            transport: McpTransport::Stdio,
            command: Some(command.to_string()),
            args: if args.is_empty() {
                None
            } else {
                Some(args.into_iter().map(ToString::to_string).collect())
            },
            url: None,
            config_path: "/tmp/mcp.json".to_string(),
            agent: "test".to_string(),
        }
    }

    #[test]
    fn test_entry_matches_process_cmd_precision() {
        let npx_entry = mk_entry(
            "npx",
            vec![
                "-y",
                "mcp-proxy-for-aws@latest",
                "https://aws-mcp.us-east-1.api.aws/mcp",
            ],
        );
        assert!(entry_matches_process_cmd(
            &npx_entry,
            "node /Users/erhu/.npm/_npx/abc/node_modules/.bin/mcp-proxy-for-aws"
        ));
        assert!(!entry_matches_process_cmd(&npx_entry, "npx -y other-pkg"));

        let node_entry = mk_entry(
            "node",
            vec!["/Users/erhu/.local/mcp/desktop-commander/dist/index.js"],
        );
        assert!(entry_matches_process_cmd(
            &node_entry,
            "node /Users/erhu/.local/mcp/desktop-commander/dist/index.js"
        ));
        assert!(!entry_matches_process_cmd(
            &node_entry,
            "node /Users/erhu/my-web-app/server.js"
        ));

        let bin_entry = mk_entry("/Users/erhu/.dbx/bin/dbx-mcp", vec![]);
        assert!(entry_matches_process_cmd(
            &bin_entry,
            "/Users/erhu/.dbx/bin/dbx-mcp --stdio"
        ));
        assert!(entry_matches_process_cmd(&bin_entry, "dbx-mcp --stdio"));

        let win_npx_entry = mk_entry("npx.cmd", vec!["-y", "@scope\\pkg-mcp"]);
        assert!(entry_matches_process_cmd(
            &win_npx_entry,
            r"C:\Program Files\nodejs\node.exe C:\Users\Alice\AppData\Local\npm-cache\_npx\123\node_modules\@scope\pkg-mcp\dist\index.js"
        ));
        let win_bin_entry = mk_entry(r"C:\Program Files\nodejs\node.exe", vec![]);
        assert!(entry_matches_process_cmd(
            &win_bin_entry,
            r#""c:\program files\nodejs\node.exe" --stdio"#
        ));
    }
}
