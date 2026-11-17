use crate::doctor;
use crate::mcp_auditor;
use crate::recommendation::DEFAULT_EXEMPT_HOURS;
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

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "cleaner_scan",
                "description": "Scan disk usage, bloated caches, snapshots, orphan sessions, and 24h protection status across installed AI coding agents.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "exemptHours": {
                            "type": "number",
                            "description": "Protect files modified within N hours (default 24)"
                        },
                        "agent": {
                            "type": "string",
                            "description": "Optional single agent filter (e.g. claude, opencode, codex, dsh, gemini, cursor)"
                        }
                    }
                }
            },
            {
                "name": "cleaner_clean",
                "description": "Move reclaimable agent artifacts into the reversible trash (~/.agent-cleaner/trash/<batchId>/). Never deletes permanently.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "exemptHours": { "type": "number" },
                        "onlyRecommended": { "type": "boolean" },
                        "dryRun": { "type": "boolean" },
                        "selectedIds": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                }
            },
            {
                "name": "cleaner_restore",
                "description": "Restore a previously cleaned trash batch back to its original paths (or list available batches if batchId is omitted).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "batchId": {
                            "type": "string",
                            "description": "Trash batch UUID to restore; omit to list batches"
                        }
                    }
                }
            },
            {
                "name": "cleaner_doctor",
                "description": "Diagnose JSON/JSONC/TOML/YAML agent config syntax and dead MCP links, optionally auto-fixing while preserving comments.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fix": { "type": "boolean" }
                    }
                }
            },
            {
                "name": "cleaner_mcp_audit",
                "description": "Audit cross-agent MCP dead links, duplicates, cold npx/uv caches, and optionally terminate PPID=1 orphan stdio processes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "kill": { "type": "boolean" }
                    }
                }
            }
        ]
    })
}

fn call_tool(ctx: &CleanerContext, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "cleaner_scan" => {
            let exempt_hours = args
                .get("exemptHours")
                .and_then(|v| v.as_u64())
                .or(Some(DEFAULT_EXEMPT_HOURS));
            let agent_filter = args
                .get("agent")
                .and_then(|v| v.as_str())
                .map(|a| vec![a.to_string()]);
            let results = scanner::scan_all(
                ctx,
                &ScanOptions {
                    exempt_hours,
                    agent_filter,
                    lang: Some(Language::En),
                },
            );
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        "cleaner_clean" => {
            let opts = CleanOptions {
                exempt_hours: args.get("exemptHours").and_then(|v| v.as_u64()),
                dry_run: args
                    .get("dryRun")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                agent_filter: None,
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
                lang: Some(Language::En),
            };
            let report = scanner::clean(ctx, &opts).map_err(|e| e.to_string())?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        "cleaner_restore" => {
            if let Some(batch_id) = args.get("batchId").and_then(|v| v.as_str()) {
                let res = trash::restore_batch(ctx, batch_id).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            } else {
                let batches = trash::list_batches(ctx);
                serde_json::to_value(batches).map_err(|e| e.to_string())
            }
        }
        "cleaner_doctor" => {
            let fix = args.get("fix").and_then(|v| v.as_bool()).unwrap_or(false);
            if fix {
                let res = doctor::fix_all_doctors(ctx).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            } else {
                let reports = doctor::run_all_doctors(ctx);
                serde_json::to_value(reports).map_err(|e| e.to_string())
            }
        }
        "cleaner_mcp_audit" => {
            let kill = args.get("kill").and_then(|v| v.as_bool()).unwrap_or(false);
            let report = mcp_auditor::audit_mcp(ctx);
            if kill {
                let kills: Vec<_> = report
                    .orphan_processes
                    .iter()
                    .map(|p| mcp_auditor::kill_orphan_process(p.pid))
                    .collect();
                Ok(json!({ "audit": report, "killResults": kills }))
            } else {
                serde_json::to_value(report).map_err(|e| e.to_string())
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
    let Some(id) = req.id else {
        return None;
    };

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
