use crate::config;
use crate::doctor;
use crate::get_overview;
use crate::mcp_auditor;
use crate::scanner;
use crate::trash;
use crate::types::{CleanOptions, CleanerContext, Language, ScanOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

fn parse_opt_lang(ctx: &CleanerContext, args: &Value) -> Language {
    match args.get("lang").and_then(|v| v.as_str()) {
        Some(raw) if raw.trim().eq_ignore_ascii_case("zh") => Language::Zh,
        Some(raw) if raw.trim().eq_ignore_ascii_case("en") => Language::En,
        _ => {
            if config::config_path(ctx).exists() {
                config::load_config(ctx).lang
            } else {
                Language::En
            }
        }
    }
}

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "cleaner_overview",
                "description": "Get an aggregated overview of disk usage, reclaimable artifacts, config doctor issues, MCP audit, and trash batches.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "exemptHours": { "type": "number" },
                        "lang": { "type": "string", "enum": ["zh", "en"] }
                    }
                }
            },
            {
                "name": "cleaner_scan",
                "description": "Scan disk usage, bloated caches, snapshots, orphan sessions, and 24h protection status across installed AI coding agents.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "exemptHours": {
                            "type": "number",
                            "description": "Protect files modified within N hours (default from config.toml or 24)"
                        },
                        "agent": {
                            "type": "string",
                            "description": "Optional single agent filter (e.g. claude, opencode, codex, dsh, gemini, cursor)"
                        },
                        "lang": { "type": "string", "enum": ["zh", "en"] }
                    }
                }
            },
            {
                "name": "cleaner_clean",
                "description": "Move reclaimable agent artifacts into the reversible trash (~/.agent-cleaner/trash/<batchId>/), or permanently delete when permanent=true.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "exemptHours": { "type": "number" },
                        "onlyRecommended": { "type": "boolean" },
                        "dryRun": { "type": "boolean" },
                        "permanent": { "type": "boolean" },
                        "agent": { "type": "string" },
                        "lang": { "type": "string", "enum": ["zh", "en"] },
                        "selectedIds": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                }
            },
            {
                "name": "cleaner_restore",
                "description": "Restore a previously cleaned trash batch back to its original paths, list batches, or purge/prune trash.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "batchId": {
                            "type": "string",
                            "description": "Trash batch UUID to restore; omit to list batches"
                        },
                        "purgeBatchId": { "type": "string" },
                        "purgeAll": { "type": "boolean" },
                        "prune": { "type": "boolean" }
                    }
                }
            },
            {
                "name": "cleaner_doctor",
                "description": "Diagnose JSON/JSONC/TOML/YAML agent config syntax and dead MCP links, optionally auto-fixing all or selected issueIds while preserving comments.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fix": { "type": "boolean" },
                        "issueIds": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                }
            },
            {
                "name": "cleaner_mcp_audit",
                "description": "Audit cross-agent MCP dead links, duplicates, conflicts, cold npx/uv caches, and optionally terminate PPID=1 orphan stdio processes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "kill": { "type": "boolean" },
                        "pid": { "type": "number" }
                    }
                }
            },
            {
                "name": "cleaner_config",
                "description": "Read or update ~/.agent-cleaner/config.toml settings and ignored path/agent whitelist.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["get", "set", "ignore_path", "unignore_path", "ignore_agent", "unignore_agent"]
                        },
                        "pattern": { "type": "string" },
                        "exemptHours": { "type": "number" },
                        "coldThresholdDays": { "type": "number" },
                        "lang": { "type": "string", "enum": ["zh", "en"] },
                        "trashMaxAgeDays": { "type": "number" },
                        "trashMaxSizeMb": { "type": "number" },
                        "autoPruneTrash": { "type": "boolean" },
                        "backupMaxCount": { "type": "number" }
                    }
                }
            },
            {
                "name": "cleaner_backups",
                "description": "List, restore, delete, or prune saved configuration backups (~/.agent-cleaner/backups/).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "restore", "delete", "prune"]
                        },
                        "backupId": { "type": "string" },
                        "keepCount": { "type": "number" }
                    }
                }
            }
        ]
    })
}

fn call_tool(ctx: &CleanerContext, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "cleaner_overview" => {
            let exempt_hours = args.get("exemptHours").and_then(|v| v.as_u64());
            let lang = parse_opt_lang(ctx, args);
            let overview = get_overview(
                ctx,
                &ScanOptions {
                    exempt_hours,
                    agent_filter: None,
                    lang: Some(lang),
                },
            );
            let trash = trash::list_batches(ctx);
            Ok(json!({
                "summary": overview.summary,
                "agents": overview.agents,
                "doctors": overview.doctors,
                "mcp": overview.mcp,
                "trash": trash,
            }))
        }
        "cleaner_scan" => {
            let exempt_hours = args.get("exemptHours").and_then(|v| v.as_u64());
            let agent_filter = args
                .get("agent")
                .and_then(|v| v.as_str())
                .map(|a| vec![a.to_string()]);
            let lang = parse_opt_lang(ctx, args);
            let results = scanner::scan_all(
                ctx,
                &ScanOptions {
                    exempt_hours,
                    agent_filter,
                    lang: Some(lang),
                },
            );
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        "cleaner_clean" => {
            let lang = parse_opt_lang(ctx, args);
            let agent_filter = args
                .get("agent")
                .and_then(|v| v.as_str())
                .map(|a| vec![a.to_string()]);
            let opts = CleanOptions {
                exempt_hours: args.get("exemptHours").and_then(|v| v.as_u64()),
                dry_run: args
                    .get("dryRun")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                agent_filter,
                selected_ids: args.get("selectedIds").and_then(|v| {
                    v.as_array().map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                }),
                only_recommended: args
                    .get("onlyRecommended")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                lang: Some(lang),
                permanent: args
                    .get("permanent")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            };
            let report = scanner::clean(ctx, &opts).map_err(|e| e.to_string())?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        "cleaner_restore" => {
            if args.get("prune").and_then(|v| v.as_bool()).unwrap_or(false) {
                let cfg = config::load_config(ctx);
                let res =
                    trash::prune_trash(ctx, cfg.trash_max_age_days, cfg.trash_max_size_mb, None)
                        .map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            } else if args
                .get("purgeAll")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let count = trash::purge_all(ctx).map_err(|e| e.to_string())?;
                Ok(json!({ "purgedBatches": count }))
            } else if let Some(pid) = args.get("purgeBatchId").and_then(|v| v.as_str()) {
                trash::purge_batch(ctx, pid).map_err(|e| e.to_string())?;
                Ok(json!({ "purged": pid }))
            } else if let Some(batch_id) = args.get("batchId").and_then(|v| v.as_str()) {
                let res = trash::restore_batch(ctx, batch_id).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            } else {
                let batches = trash::list_batches(ctx);
                serde_json::to_value(batches).map_err(|e| e.to_string())
            }
        }
        "cleaner_doctor" => {
            let fix = args.get("fix").and_then(|v| v.as_bool()).unwrap_or(false);
            let issue_ids: Option<Vec<String>> = args.get("issueIds").and_then(|v| {
                v.as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(ToString::to_string))
                        .collect()
                })
            });
            if fix || issue_ids.as_ref().is_some_and(|ids| !ids.is_empty()) {
                let res = doctor::fix_doctor_issues(ctx, issue_ids.as_deref())
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            } else {
                let reports = doctor::run_all_doctors(ctx);
                serde_json::to_value(reports).map_err(|e| e.to_string())
            }
        }
        "cleaner_mcp_audit" => {
            let kill = args.get("kill").and_then(|v| v.as_bool()).unwrap_or(false);
            let target_pid = args.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32);
            let report = mcp_auditor::audit_mcp(ctx);
            if kill {
                let kills: Vec<_> = report
                    .orphan_processes
                    .iter()
                    .filter(|p| target_pid.is_none_or(|tp| tp == p.pid))
                    .map(|p| mcp_auditor::kill_orphan_process(p.pid))
                    .collect();
                Ok(json!({ "audit": report, "killResults": kills }))
            } else {
                serde_json::to_value(report).map_err(|e| e.to_string())
            }
        }
        "cleaner_config" => {
            let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("get");
            match action {
                "get" => {
                    let cfg = config::load_config(ctx);
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                "set" => {
                    let mut cfg = config::load_config(ctx);
                    if let Some(h) = args.get("exemptHours").and_then(|v| v.as_u64()) {
                        cfg.exempt_hours = h;
                    }
                    if let Some(d) = args.get("coldThresholdDays").and_then(|v| v.as_u64()) {
                        cfg.cold_threshold_days = d;
                    }
                    if let Some(l) = args.get("lang").and_then(|v| v.as_str()) {
                        cfg.lang = if l.trim().eq_ignore_ascii_case("en") {
                            Language::En
                        } else {
                            Language::Zh
                        };
                    }
                    if let Some(d) = args.get("trashMaxAgeDays").and_then(|v| v.as_u64()) {
                        cfg.trash_max_age_days = d;
                    }
                    if let Some(m) = args.get("trashMaxSizeMb").and_then(|v| v.as_u64()) {
                        cfg.trash_max_size_mb = m;
                    }
                    if let Some(a) = args.get("autoPruneTrash").and_then(|v| v.as_bool()) {
                        cfg.auto_prune_trash = a;
                    }
                    if let Some(c) = args.get("backupMaxCount").and_then(|v| v.as_u64()) {
                        cfg.backup_max_count = c as u32;
                    }
                    config::save_config(ctx, &cfg).map_err(|e| e.to_string())?;
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                "ignore_path" => {
                    let pattern = args
                        .get("pattern")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "pattern is required".to_string())?;
                    let cfg = config::add_ignored_path(ctx, pattern).map_err(|e| e.to_string())?;
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                "unignore_path" => {
                    let pattern = args
                        .get("pattern")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "pattern is required".to_string())?;
                    let cfg =
                        config::remove_ignored_path(ctx, pattern).map_err(|e| e.to_string())?;
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                "ignore_agent" => {
                    let pattern = args
                        .get("pattern")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "pattern is required".to_string())?;
                    let mut cfg = config::load_config(ctx);
                    let norm = pattern.trim().to_ascii_lowercase();
                    if !norm.is_empty() && !cfg.ignored_agents.contains(&norm) {
                        cfg.ignored_agents.push(norm);
                    }
                    config::save_config(ctx, &cfg).map_err(|e| e.to_string())?;
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                "unignore_agent" => {
                    let pattern = args
                        .get("pattern")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "pattern is required".to_string())?;
                    let mut cfg = config::load_config(ctx);
                    let norm = pattern.trim().to_ascii_lowercase();
                    cfg.ignored_agents.retain(|a| a != &norm);
                    config::save_config(ctx, &cfg).map_err(|e| e.to_string())?;
                    serde_json::to_value(cfg).map_err(|e| e.to_string())
                }
                other => Err(format!("Unknown config action: {other}")),
            }
        }
        "cleaner_backups" => {
            let action = args
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("list");
            match action {
                "list" => {
                    let backups = trash::list_backups(ctx);
                    serde_json::to_value(backups).map_err(|e| e.to_string())
                }
                "restore" => {
                    let id = args
                        .get("backupId")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "backupId is required".to_string())?;
                    let report = trash::restore_backup(ctx, id).map_err(|e| e.to_string())?;
                    serde_json::to_value(report).map_err(|e| e.to_string())
                }
                "delete" => {
                    let id = args
                        .get("backupId")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "backupId is required".to_string())?;
                    trash::delete_backup(ctx, id).map_err(|e| e.to_string())?;
                    Ok(json!({ "deleted": id }))
                }
                "prune" => {
                    let keep = args
                        .get("keepCount")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as usize)
                        .unwrap_or_else(|| config::load_config(ctx).backup_max_count as usize);
                    let report = trash::prune_backups(ctx, keep).map_err(|e| e.to_string())?;
                    serde_json::to_value(report).map_err(|e| e.to_string())
                }
                other => Err(format!("Unknown backups action: {other}")),
            }
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

pub fn handle_rpc_line(ctx: &CleanerContext, line: &str) -> Option<String> {
    let req: JsonRpcRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(err) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(json!({ "code": -32700, "message": format!("Parse error: {err}") })),
            };
            return serde_json::to_string(&resp).ok();
        }
    };

    // Notifications (no `id`) must not produce a response in JSON-RPC 2.0
    let id = req.id?;

    let resp = match req.method.as_str() {
        "initialize" => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "agent-cleaner",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })),
            error: None,
        },
        "ping" => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(json!({})),
            error: None,
        },
        "tools/list" => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(tool_definitions()),
            error: None,
        },
        "tools/call" => {
            let name = req
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(ctx, name, &args) {
                Ok(val) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: Some(json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&val).unwrap_or_default()
                        }]
                    })),
                    error: None,
                },
                Err(msg) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: Some(json!({
                        "isError": true,
                        "content": [{ "type": "text", "text": msg }]
                    })),
                    error: None,
                },
            }
        }
        other => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(json!({ "code": -32601, "message": format!("Method not found: {other}") })),
        },
    };

    serde_json::to_string(&resp).ok()
}

pub fn run_stdio_server(ctx: &CleanerContext) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(reply) = handle_rpc_line(ctx, trimmed) {
            writeln!(out, "{reply}")?;
            out.flush()?;
        }
    }
    Ok(())
}
