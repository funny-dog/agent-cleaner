use crate::mcp_auditor::{command_exists, infer_agent_from_path, known_config_paths};
use crate::trash;
use crate::types::{CleanerContext, DoctorFixReport, DoctorIssue, DoctorReport, IssueSeverity};
use anyhow::Result;
use jsonc_parser::cst::CstRootNode;
use jsonc_parser::ParseOptions;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::DocumentMut;

fn healthy_report(path: &Path, agent: &str) -> DoctorReport {
    DoctorReport {
        path: path.to_string_lossy().to_string(),
        agent: agent.to_string(),
        issues: Vec::new(),
        healthy: true,
    }
}

fn check_jsonc_config(path: &Path, agent: &str) -> DoctorReport {
    let Ok(raw) = fs::read_to_string(path) else {
        return healthy_report(path, agent);
    };
    let path_str = path.to_string_lossy().to_string();
    let parse_opts = ParseOptions::default();

    let parsed: serde_json::Value =
        match jsonc_parser::parse_to_serde_value::<Option<serde_json::Value>>(&raw, &parse_opts) {
            Ok(Some(val)) => val,
            Ok(None) => {
                return healthy_report(path, agent);
            }
        Err(err) => {
            return DoctorReport {
                path: path_str.clone(),
                agent: agent.to_string(),
                issues: vec![DoctorIssue {
                    id: format!("{agent}:parse_error"),
                    path: path_str,
                    severity: IssueSeverity::Error,
                    message: format!("JSON/JSONC parse error: {err}"),
                    auto_fixable: false,
                    fix_target_key: None,
                }],
                healthy: false,
            };
        }
    };

    let mut issues = Vec::new();
    if let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg) in servers {
            let Some(obj) = cfg.as_object() else {
                continue;
            };
            let transport = obj
                .get("transport")
                .or_else(|| obj.get("type"))
                .and_then(|v| v.as_str());
            let has_url = obj.get("url").and_then(|v| v.as_str()).is_some();
            let command = obj.get("command").and_then(|v| v.as_str());
            let is_stdio = transport == Some("stdio") || (!has_url && command.is_some());
            if is_stdio {
                if let Some(cmd) = command {
                    if !command_exists(cmd) {
                        issues.push(DoctorIssue {
                            id: format!("{agent}:dead_mcp:{name}"),
                            path: path_str.clone(),
                            severity: IssueSeverity::Warning,
                            message: format!("MCP server \"{name}\" command not found: {cmd}"),
                            auto_fixable: true,
                            fix_target_key: Some(name.clone()),
                        });
                    }
                }
            }
        }
    }

    DoctorReport {
        path: path_str,
        agent: agent.to_string(),
        healthy: issues.is_empty(),
        issues,
    }
}

fn fix_jsonc_dead_servers(path: &Path, keys: &[String]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let parse_opts = ParseOptions::default();
    let root = CstRootNode::parse(&raw, &parse_opts)
        .map_err(|e| anyhow::anyhow!("Failed to parse JSONC CST: {e}"))?;
    let mut fixed = 0usize;
    if let Some(root_obj) = root.object_value() {
        if let Some(servers_obj) = root_obj.object_value("mcpServers") {
            for key in keys {
                if let Some(prop) = servers_obj.get(key) {
                    prop.remove();
                    fixed += 1;
                }
            }
        }
    }
    if fixed > 0 {
        fs::write(path, root.to_string())?;
    }
    Ok(fixed)
}

fn check_codex_toml(path: &Path) -> DoctorReport {
    let Ok(raw) = fs::read_to_string(path) else {
        return healthy_report(path, "codex");
    };
    let path_str = path.to_string_lossy().to_string();
    let doc: DocumentMut = match raw.parse() {
        Ok(d) => d,
        Err(err) => {
            return DoctorReport {
                path: path_str.clone(),
                agent: "codex".to_string(),
                issues: vec![DoctorIssue {
                    id: "codex:parse_error".to_string(),
                    path: path_str,
                    severity: IssueSeverity::Error,
                    message: format!("TOML parse error: {err}"),
                    auto_fixable: false,
                    fix_target_key: None,
                }],
                healthy: false,
            };
        }
    };

    let mut issues = Vec::new();
    if let Some(servers) = doc
        .get("mcp")
        .and_then(|m| m.get("servers"))
        .and_then(|s| s.as_table_like())
    {
        for (name, val) in servers.iter() {
            if let Some(cmd) = val.get("command").and_then(|c| c.as_str()) {
                if !command_exists(cmd) {
                    issues.push(DoctorIssue {
                        id: format!("codex:dead_mcp:{name}"),
                        path: path_str.clone(),
                        severity: IssueSeverity::Warning,
                        message: format!("MCP server \"{name}\" command not found: {cmd}"),
                        auto_fixable: true,
                        fix_target_key: Some(name.to_string()),
                    });
                }
            }
        }
    }

    DoctorReport {
        path: path_str,
        agent: "codex".to_string(),
        healthy: issues.is_empty(),
        issues,
    }
}

fn fix_codex_toml(path: &Path, keys: &[String]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let mut doc: DocumentMut = raw.parse()?;
    let mut fixed = 0usize;
    if let Some(mcp_table) = doc.get_mut("mcp").and_then(|v| v.as_table_like_mut()) {
        let remove_servers_table = if let Some(servers) =
            mcp_table.get_mut("servers").and_then(|v| v.as_table_like_mut())
        {
            for key in keys {
                if servers.remove(key).is_some() {
                    fixed += 1;
                }
            }
            servers.is_empty()
        } else {
            false
        };
        if remove_servers_table {
            mcp_table.remove("servers");
        }
    }
    if fixed > 0 {
        fs::write(path, doc.to_string())?;
    }
    Ok(fixed)
}

fn check_dsh_yaml(path: &Path) -> DoctorReport {
    let Ok(raw) = fs::read_to_string(path) else {
        return healthy_report(path, "dsh");
    };
    let path_str = path.to_string_lossy().to_string();
    let val: serde_json::Value = match serde_yml::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return DoctorReport {
                path: path_str.clone(),
                agent: "dsh".to_string(),
                issues: vec![DoctorIssue {
                    id: "dsh:parse_error".to_string(),
                    path: path_str,
                    severity: IssueSeverity::Error,
                    message: format!("YAML parse error: {err}"),
                    auto_fixable: false,
                    fix_target_key: None,
                }],
                healthy: false,
            };
        }
    };

    let mut issues = Vec::new();
    if let Some(servers) = val.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg) in servers {
            let Some(obj) = cfg.as_object() else {
                continue;
            };
            let transport = obj
                .get("transport")
                .or_else(|| obj.get("type"))
                .and_then(|v| v.as_str());
            let has_url = obj.get("url").and_then(|v| v.as_str()).is_some();
            let command = obj.get("command").and_then(|v| v.as_str());
            if (transport == Some("stdio") || (!has_url && command.is_some()))
                && command.is_some_and(|c| !command_exists(c))
            {
                let cmd = command.unwrap_or_default();
                issues.push(DoctorIssue {
                    id: format!("dsh:dead_mcp:{name}"),
                    path: path_str.clone(),
                    severity: IssueSeverity::Warning,
                    message: format!("MCP server \"{name}\" command not found: {cmd}"),
                    auto_fixable: true,
                    fix_target_key: Some(name.clone()),
                });
            }
            if let Some(plugin) = obj.get("plugin").and_then(|v| v.as_str()) {
                if !command_exists(plugin) {
                    issues.push(DoctorIssue {
                        id: format!("dsh:dead_plugin:{name}"),
                        path: path_str.clone(),
                        severity: IssueSeverity::Warning,
                        message: format!(
                            "MCP server \"{name}\" references uninstalled plugin: {plugin}"
                        ),
                        auto_fixable: true,
                        fix_target_key: Some(name.clone()),
                    });
                }
            }
        }
    }

    DoctorReport {
        path: path_str,
        agent: "dsh".to_string(),
        healthy: issues.is_empty(),
        issues,
    }
}

/// Comment-preserving removal of specific subkeys under top-level `mcpServers:` in YAML.
fn fix_dsh_yaml(path: &Path, keys: &[String]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let lines: Vec<&str> = raw.lines().collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    let mut in_mcp_servers = false;
    let mut mcp_indent: Option<usize> = None;
    let mut entry_indent: Option<usize> = None;
    let mut fixed = 0usize;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        let indent = line.len() - line.trim_start().len();

        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(m_indent) = mcp_indent {
                if indent <= m_indent {
                    in_mcp_servers = false;
                    mcp_indent = None;
                    entry_indent = None;
                }
            }
        }

        if !in_mcp_servers {
            if trimmed == "mcpServers:" || trimmed.starts_with("mcpServers:") {
                in_mcp_servers = true;
                mcp_indent = Some(indent);
            }
            out.push(line);
            i += 1;
            continue;
        }

        // Inside `mcpServers:` block
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let cur_entry_indent = *entry_indent.get_or_insert(indent);
            if indent == cur_entry_indent {
                if let Some((key_raw, _)) = trimmed.split_once(':') {
                    let key_clean = key_raw.trim().trim_matches('"').trim_matches('\'');
                    if keys.iter().any(|k| k == key_clean) {
                        fixed += 1;
                        i += 1;
                        while i < lines.len() {
                            let next = lines[i];
                            let next_trimmed = next.trim();
                            let next_indent = next.len() - next.trim_start().len();
                            if next_trimmed.is_empty() || next_trimmed.starts_with('#') {
                                // Only skip comments if deeper than entry indent
                                if next_indent > cur_entry_indent {
                                    i += 1;
                                    continue;
                                }
                                break;
                            }
                            if next_indent > cur_entry_indent {
                                i += 1;
                            } else {
                                break;
                            }
                        }
                        continue;
                    }
                }
            }
        }

        out.push(line);
        i += 1;
    }

    if fixed > 0 {
        let mut updated = out.join("\n");
        if raw.ends_with('\n') {
            updated.push('\n');
        }
        fs::write(path, updated)?;
    }
    Ok(fixed)
}

fn first_existing(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

fn should_check_extra_config(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("mcp") {
        return true;
    }
    fs::read_to_string(path)
        .map(|raw| raw.contains("\"mcpServers\"") || raw.contains("mcpServers"))
        .unwrap_or(false)
}

pub fn run_all_doctors(ctx: &CleanerContext) -> Vec<DoctorReport> {
    let claude_path = ctx.home_dir.join(".claude/settings.json");
    let opencode_path = first_existing(&[
        ctx.home_dir.join(".config/opencode/opencode.jsonc"),
        ctx.home_dir.join(".config/opencode/opencode.json"),
    ]);
    let codex_path = ctx.home_dir.join(".codex/config.toml");
    let dsh_path = first_existing(&[
        ctx.home_dir.join(".dsh/settings.yaml"),
        ctx.home_dir.join(".dsh/settings.yml"),
    ]);

    let mut seen: HashSet<PathBuf> = [
        claude_path.clone(),
        opencode_path.clone(),
        codex_path.clone(),
        dsh_path.clone(),
    ]
    .into_iter()
    .collect();

    let mut reports = vec![
        check_jsonc_config(&claude_path, "claude"),
        check_jsonc_config(&opencode_path, "opencode"),
        check_codex_toml(&codex_path),
        check_dsh_yaml(&dsh_path),
    ];

    for path in known_config_paths(ctx) {
        if !seen.insert(path.clone()) || !should_check_extra_config(&path) {
            continue;
        }
        let lower = path.to_string_lossy().to_ascii_lowercase();
        let agent = infer_agent_from_path(&path);
        if lower.ends_with(".json") || lower.ends_with(".jsonc") {
            reports.push(check_jsonc_config(&path, &agent));
        }
    }

    reports
}

pub fn fix_all_doctors(ctx: &CleanerContext) -> Result<DoctorFixReport> {
    let initial = run_all_doctors(ctx);
    let mut fixed_count = 0usize;
    let mut backup_paths = Vec::new();

    for report in &initial {
        let mut keys: Vec<String> = report
            .issues
            .iter()
            .filter(|i| i.auto_fixable)
            .filter_map(|i| i.fix_target_key.clone())
            .collect();
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            continue;
        }
        let path = Path::new(&report.path);
        let backup = trash::backup_file(ctx, path)?;
        backup_paths.push(backup);

        let lower = report.path.to_ascii_lowercase();
        let fixed = if lower.ends_with(".toml") {
            fix_codex_toml(path, &keys)?
        } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
            fix_dsh_yaml(path, &keys)?
        } else if lower.ends_with(".json") || lower.ends_with(".jsonc") {
            fix_jsonc_dead_servers(path, &keys)?
        } else {
            0
        };
        fixed_count += fixed;
    }

    let reports = run_all_doctors(ctx);
    Ok(DoctorFixReport {
        fixed_count,
        backup_paths,
        reports,
    })
}
