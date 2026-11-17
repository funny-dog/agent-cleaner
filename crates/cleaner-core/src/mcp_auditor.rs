use crate::fs_safe::{get_dir_size, get_file_size, safe_atime_ms};
use crate::targets::cold_cache::COLD_THRESHOLD_DAYS;
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

const MS_PER_DAY: u64 = 86_400_000;

pub(crate) fn command_exists(cmd: &str) -> bool {
    if cmd.is_empty() {
        return false;
    }
    let path = Path::new(cmd);
    if path.is_absolute() {
        return path.exists();
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(cmd);
            if candidate.is_file() {
                return true;
            }
            #[cfg(windows)]
            {
                let exe = dir.join(format!("{cmd}.exe"));
                if exe.is_file() {
                    return true;
                }
            }
        }
    }
    false
}

fn detect_transport(
    transport: Option<&str>,
    typ: Option<&str>,
    url: Option<&str>,
    command: Option<&str>,
) -> McpTransport {
    if let Some(t) = transport.or(typ) {
        if t.eq_ignore_ascii_case("sse") {
            return McpTransport::Sse;
        }
        if t.eq_ignore_ascii_case("http") {
            return McpTransport::Http;
        }
    }
    if url.is_some() && command.is_none() {
        return McpTransport::Sse;
    }
    McpTransport::Stdio
}

fn extract_entries_from_json_value(
    val: &serde_json::Value,
    config_path: &Path,
    agent: &str,
) -> Vec<McpEntry> {
    let Some(servers) = val
        .get("mcpServers")
        .or_else(|| val.get("mcp").and_then(|m| m.get("servers")))
        .or_else(|| val.get("context_servers"))
        .and_then(|v| v.as_object())
    else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, cfg)| {
            let obj = cfg.as_object()?;
            let command = obj
                .get("command")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let url = obj
                .get("url")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let args = obj.get("args").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(ToString::to_string))
                    .collect()
            });
            let transport = detect_transport(
                obj.get("transport").and_then(|v| v.as_str()),
                obj.get("type").and_then(|v| v.as_str()),
                url.as_deref(),
                command.as_deref(),
            );
            Some(McpEntry {
                name: name.clone(),
                transport,
                command,
                args,
                url,
                config_path: config_path.to_string_lossy().to_string(),
                agent: agent.to_string(),
            })
        })
        .collect()
}

pub(crate) fn infer_agent_from_path(config_path: &Path) -> String {
    let lower = config_path.to_string_lossy().to_lowercase();
    for (needle, agent) in [
        (".claude", "claude"),
        ("opencode", "opencode"),
        (".codex", "codex"),
        (".dsh", "dsh"),
        (".cursor", "cursor"),
        ("windsurf", "windsurf"),
        (".codeium", "windsurf"),
        (".gemini", "gemini"),
        ("antigravity", "gemini"),
        (".kiro", "kiro"),
        (".kimi", "kimi"),
        (".qoder", "qoder"),
        (".trae", "trae"),
        (".continue", "continue"),
        (".copilot", "copilot"),
        (".zcode", "zcode"),
        (".codebuddy", "codebuddy"),
        (".devin", "devin"),
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
        if let Ok(Some(val)) =
            jsonc_parser::parse_to_serde_value::<Option<serde_json::Value>>(&raw, &Default::default())
        {
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
        ctx.home_dir.join(".qoder/mcp.json"),
        ctx.home_dir.join(".qoder.json"),
        ctx.home_dir.join(".trae/mcp.json"),
        ctx.home_dir.join(".continue/config.json"),
        ctx.home_dir.join(".copilot/mcp-config.json"),
        ctx.home_dir.join(".zcode/mcp.json"),
        ctx.home_dir.join(".codebuddy/mcp.json"),
        ctx.home_dir.join("Library/Application Support/Zed/settings.json"),
    ];
    paths.extend(custom_target_mcp_configs(ctx));
    paths.extend(discover_dynamic_mcp_configs(ctx));

    let mut seen = HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

pub fn scan_cold_caches(ctx: &CleanerContext) -> Vec<ColdCacheEntry> {
    let now = ctx.now();
    let mut entries = Vec::new();
    for (source, dir) in [
        ("npm/_npx", ctx.home_dir.join(".npm/_npx")),
        ("uv", ctx.home_dir.join(".cache/uv")),
    ] {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read_dir.flatten() {
            let p = item.path();
            let atime = safe_atime_ms(&p, now);
            let days = now.saturating_sub(atime) / MS_PER_DAY;
            if days > COLD_THRESHOLD_DAYS {
                let size_bytes = if p.is_dir() {
                    get_dir_size(&p)
                } else {
                    get_file_size(&p)
                };
                entries.push(ColdCacheEntry {
                    source: source.to_string(),
                    path: p.to_string_lossy().to_string(),
                    size_bytes,
                    last_access_days: days,
                });
            }
        }
    }
    entries
}

pub fn scan_orphan_mcp_processes(entries: &[McpEntry]) -> Vec<McpProcessInfo> {
    let stdio_entries: Vec<&McpEntry> = entries
        .iter()
        .filter(|e| e.transport == McpTransport::Stdio && e.command.as_deref().is_some_and(|c| !c.is_empty()))
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
        if ppid != 1 {
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

        let matched = stdio_entries.iter().find(|e| {
            e.command
                .as_deref()
                .is_some_and(|cmd| !cmd.is_empty() && command.contains(cmd))
        });

        let by_marker = (command.contains("@modelcontextprotocol") || command.contains("mcp-server"))
            && command.contains("stdio");

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
    for entry in &entries {
        let target = entry
            .command
            .as_deref()
            .or(entry.url.as_deref())
            .unwrap_or("");
        let key = format!("{}::{target}", entry.name);
        groups.entry(key).or_default().push(entry.clone());
    }

    let duplicates: Vec<Vec<McpEntry>> = groups
        .into_values()
        .filter(|group| {
            let agents: HashSet<&str> = group.iter().map(|e| e.agent.as_str()).collect();
            agents.len() > 1
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
        orphan_processes,
        cold_caches,
    }
}

fn is_pid_alive(pid: u32) -> bool {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), false);
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

        return KillProcessResult {
            pid,
            success: !is_pid_alive(pid),
            method: "SIGKILL".to_string(),
        };
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
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
            .args(["/F", "/PID", &pid.to_string()])
            .status();
        thread::sleep(Duration::from_millis(200));
        return KillProcessResult {
            pid,
            success: !is_pid_alive(pid),
            method: "SIGKILL".to_string(),
        };
    }
}
