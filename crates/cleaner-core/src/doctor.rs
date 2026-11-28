use crate::mcp_auditor::{
    command_exists, extract_mcp_servers_from_value, infer_agent_from_path, known_config_paths,
};
use crate::trash;
use crate::types::{
    CleanerContext, DoctorFixReport, DoctorIssue, DoctorReport, IssueSeverity, McpTransport,
};
use anyhow::Result;
use jsonc_parser::cst::CstRootNode;
use jsonc_parser::ParseOptions;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, TableLike};

const CST_PATH_PREFIX: &str = "cst_path:";
const TOML_PATH_PREFIX: &str = "toml_path:";

fn encode_path_key(prefix: &str, segments: &[String]) -> String {
    let json = serde_json::to_string(segments).unwrap_or_else(|_| "[]".to_string());
    format!("{prefix}{json}")
}

fn decode_path_key(prefix: &str, key: &str) -> Option<Vec<String>> {
    let raw = key.strip_prefix(prefix)?;
    serde_json::from_str::<Vec<String>>(raw).ok()
}

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
    for srv in extract_mcp_servers_from_value(&parsed) {
        if srv.transport == McpTransport::Stdio {
            if let Some(cmd) = srv.command.as_deref() {
                if !command_exists(cmd) {
                    issues.push(DoctorIssue {
                        id: format!("{agent}:dead_mcp:{}", srv.name),
                        path: path_str.clone(),
                        severity: IssueSeverity::Warning,
                        message: format!("MCP server \"{}\" command not found: {cmd}", srv.name),
                        auto_fixable: true,
                        fix_target_key: Some(encode_path_key(CST_PATH_PREFIX, &srv.location_path)),
                    });
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

fn remove_cst_path(root: &CstRootNode, segments: &[String]) -> bool {
    if segments.is_empty() {
        return false;
    }
    let Some(mut cur_obj) = root.object_value() else {
        return false;
    };
    for seg in &segments[..segments.len() - 1] {
        let Some(next_obj) = cur_obj.object_value(seg) else {
            return false;
        };
        cur_obj = next_obj;
    }
    let last_seg = &segments[segments.len() - 1];
    if let Some(prop) = cur_obj.get(last_seg) {
        prop.remove();
        return true;
    }
    false
}

fn fix_jsonc_dead_servers(path: &Path, keys: &[String]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let parse_opts = ParseOptions::default();
    let root = CstRootNode::parse(&raw, &parse_opts)
        .map_err(|e| anyhow::anyhow!("Failed to parse JSONC CST: {e}"))?;
    let mut fixed = 0usize;
    for key in keys {
        let removed = if let Some(segments) = decode_path_key(CST_PATH_PREFIX, key) {
            remove_cst_path(&root, &segments)
        } else {
            remove_cst_path(&root, &["mcpServers".to_string(), key.clone()])
        };
        if removed {
            fixed += 1;
        }
    }
    if fixed > 0 {
        fs::write(path, root.to_string())?;
    }
    Ok(fixed)
}

fn check_toml_server_table(
    servers: &dyn TableLike,
    prefix: &[&str],
    path_str: &str,
    issues: &mut Vec<DoctorIssue>,
) {
    for (name, val) in servers.iter() {
        let transport = val
            .get("transport")
            .or_else(|| val.get("type"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_lowercase());
        let has_url = val.get("url").and_then(|v| v.as_str()).is_some();
        let command = val.get("command").and_then(|c| c.as_str()).or_else(|| {
            val.get("command")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.get(0))
                .and_then(|v| v.as_str())
        });
        let is_stdio = matches!(transport.as_deref(), Some("stdio") | Some("local"))
            || (transport.is_none() && !has_url && command.is_some());
        if is_stdio {
            if let Some(cmd) = command {
                if !command_exists(cmd) {
                    let mut segments: Vec<String> =
                        prefix.iter().map(|s| (*s).to_string()).collect();
                    segments.push(name.to_string());
                    issues.push(DoctorIssue {
                        id: format!("codex:dead_mcp:{name}"),
                        path: path_str.to_string(),
                        severity: IssueSeverity::Warning,
                        message: format!("MCP server \"{name}\" command not found: {cmd}"),
                        auto_fixable: true,
                        fix_target_key: Some(encode_path_key(TOML_PATH_PREFIX, &segments)),
                    });
                }
            }
        }
    }
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
    if let Some(servers) = doc.get("mcp_servers").and_then(|s| s.as_table_like()) {
        check_toml_server_table(servers, &["mcp_servers"], &path_str, &mut issues);
    }
    if let Some(servers) = doc
        .get("mcp")
        .and_then(|m| m.get("servers"))
        .and_then(|s| s.as_table_like())
    {
        check_toml_server_table(servers, &["mcp", "servers"], &path_str, &mut issues);
    }

    DoctorReport {
        path: path_str,
        agent: "codex".to_string(),
        healthy: issues.is_empty(),
        issues,
    }
}

fn remove_toml_mcp_servers_key(doc: &mut DocumentMut, name: &str) -> bool {
    let mut removed = false;
    let empty_table = if let Some(servers) = doc
        .get_mut("mcp_servers")
        .and_then(|v| v.as_table_like_mut())
    {
        if servers.remove(name).is_some() {
            removed = true;
        }
        servers.is_empty()
    } else {
        false
    };
    if empty_table {
        doc.remove("mcp_servers");
    }
    removed
}

fn remove_toml_nested_mcp_key(doc: &mut DocumentMut, name: &str) -> bool {
    let mut removed = false;
    if let Some(mcp_table) = doc.get_mut("mcp").and_then(|v| v.as_table_like_mut()) {
        let remove_servers_table = if let Some(servers) = mcp_table
            .get_mut("servers")
            .and_then(|v| v.as_table_like_mut())
        {
            if servers.remove(name).is_some() {
                removed = true;
            }
            servers.is_empty()
        } else {
            false
        };
        if remove_servers_table {
            mcp_table.remove("servers");
        }
    }
    removed
}

fn fix_codex_toml(path: &Path, keys: &[String]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let mut doc: DocumentMut = raw.parse()?;
    let mut fixed = 0usize;
    for key in keys {
        if let Some(segments) = decode_path_key(TOML_PATH_PREFIX, key) {
            match segments.as_slice() {
                [section, name]
                    if section == "mcp_servers" && remove_toml_mcp_servers_key(&mut doc, name) =>
                {
                    fixed += 1;
                }
                [section, sub, name]
                    if section == "mcp"
                        && sub == "servers"
                        && remove_toml_nested_mcp_key(&mut doc, name) =>
                {
                    fixed += 1;
                }
                _ => {}
            }
        } else {
            if remove_toml_mcp_servers_key(&mut doc, key) {
                fixed += 1;
            }
            if remove_toml_nested_mcp_key(&mut doc, key) {
                fixed += 1;
            }
        }
    }
    if fixed > 0 {
        fs::write(path, doc.to_string())?;
    }
    Ok(fixed)
}

fn dsh_plugin_installed(config_path: &Path, plugin: &str) -> bool {
    let mut cur = config_path.parent();
    while let Some(dir) = cur {
        if dir.file_name().and_then(|n| n.to_str()) == Some(".dsh") {
            if let Ok(profiles) = fs::read_dir(dir.join("profiles")) {
                for entry in profiles.flatten() {
                    if entry.path().join("node_modules").join(plugin).exists() {
                        return true;
                    }
                }
            }
            break;
        }
        cur = dir.parent();
    }
    false
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
                if !command_exists(plugin) && !dsh_plugin_installed(path, plugin) {
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

fn check_dsh_profile_package_json(
    profile_dir: &Path,
    profile_name: &str,
    pkg_path: &Path,
) -> DoctorReport {
    let Ok(raw) = fs::read_to_string(pkg_path) else {
        return healthy_report(pkg_path, "dsh");
    };
    let path_str = pkg_path.to_string_lossy().to_string();
    let val: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            return DoctorReport {
                path: path_str.clone(),
                agent: "dsh".to_string(),
                issues: vec![DoctorIssue {
                    id: format!("dsh:parse_error:{profile_name}:package_json"),
                    path: path_str,
                    severity: IssueSeverity::Error,
                    message: format!(
                        "DSH profile \"{profile_name}\" package.json parse error: {err}"
                    ),
                    auto_fixable: false,
                    fix_target_key: None,
                }],
                healthy: false,
            };
        }
    };

    let mut issues = Vec::new();
    let node_modules_dir = profile_dir.join("node_modules");
    if node_modules_dir.is_dir() {
        let deps = val.get("dependencies").and_then(|v| v.as_object());
        let dev_deps = val.get("devDependencies").and_then(|v| v.as_object());
        let opt_deps = val.get("optionalDependencies").and_then(|v| v.as_object());

        if let Some(bundles) = val
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array())
        {
            let mut seen = HashSet::new();
            for item in bundles {
                let Some(bundle) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                    continue;
                };
                if bundle.starts_with("@deepseek-ai/dsh-") || !seen.insert(bundle.to_string()) {
                    continue;
                }
                let installed = node_modules_dir.join(bundle).exists();
                let declared = deps.is_some_and(|m| m.contains_key(bundle))
                    || dev_deps.is_some_and(|m| m.contains_key(bundle))
                    || opt_deps.is_some_and(|m| m.contains_key(bundle));
                if !installed && !declared {
                    issues.push(DoctorIssue {
                        id: format!("dsh:missing_bundle:{profile_name}:{bundle}"),
                        path: path_str.clone(),
                        severity: IssueSeverity::Warning,
                        message: format!(
                            "DSH profile \"{profile_name}\" bundle \"{bundle}\" is missing from node_modules and dependencies"
                        ),
                        auto_fixable: true,
                        fix_target_key: Some(format!("dsh_bundle:{bundle}")),
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

fn check_dsh_profiles(ctx: &CleanerContext) -> Vec<DoctorReport> {
    let profiles_dir = ctx.home_dir.join(".dsh/profiles");
    let Ok(entries) = fs::read_dir(&profiles_dir) else {
        return Vec::new();
    };
    let mut profile_dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.is_dir() {
                Some((e.file_name().to_string_lossy().to_string(), p))
            } else {
                None
            }
        })
        .collect();
    profile_dirs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut reports = Vec::new();
    for (profile_name, profile_dir) in profile_dirs {
        let cordis_patch = profile_dir.join("cordis.patch.yml");
        if cordis_patch.is_file() {
            reports.push(check_dsh_yaml(&cordis_patch));
        }
        let pkg_json = profile_dir.join("package.json");
        if pkg_json.is_file() {
            reports.push(check_dsh_profile_package_json(
                &profile_dir,
                &profile_name,
                &pkg_json,
            ));
        }
    }
    reports
}

fn fix_dsh_profile_bundles(path: &Path, bundles_to_remove: &[&str]) -> Result<usize> {
    let raw = fs::read_to_string(path)?;
    let mut val: serde_json::Value = serde_json::from_str(&raw)?;
    let mut fixed = 0usize;
    if let Some(arr) = val
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|item| {
            item.as_str()
                .map(|s| !bundles_to_remove.contains(&s.trim()))
                .unwrap_or(true)
        });
        fixed = before.saturating_sub(arr.len());
    }
    if fixed > 0 {
        let mut updated = serde_json::to_string_pretty(&val)?;
        updated.push('\n');
        fs::write(path, updated)?;
    }
    Ok(fixed)
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
    if name.contains("mcp") || name == "claude_desktop_config.json" || name == ".claude.json" {
        return true;
    }
    fs::read_to_string(path)
        .map(|raw| {
            raw.contains("\"mcpServers\"")
                || raw.contains("mcpServers")
                || raw.contains("\"mcp_servers\"")
                || raw.contains("mcp_servers")
                || raw.contains("\"context_servers\"")
                || raw.contains("\"mcp\"")
        })
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
    ];

    let profile_reports = check_dsh_profiles(ctx);
    if dsh_path.exists() {
        reports.push(check_dsh_yaml(&dsh_path));
        for r in profile_reports {
            seen.insert(PathBuf::from(&r.path));
            reports.push(r);
        }
    } else if profile_reports.is_empty() {
        reports.push(check_dsh_yaml(&dsh_path));
    } else {
        for r in profile_reports {
            seen.insert(PathBuf::from(&r.path));
            reports.push(r);
        }
    }

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
    fix_doctor_issues(ctx, None)
}

pub fn fix_doctor_issues(
    ctx: &CleanerContext,
    issue_ids: Option<&[String]>,
) -> Result<DoctorFixReport> {
    let initial = run_all_doctors(ctx);
    let mut fixed_count = 0usize;
    let mut backup_paths = Vec::new();
    let id_filter: Option<HashSet<&str>> = issue_ids
        .filter(|ids| !ids.is_empty())
        .map(|ids| ids.iter().map(|s| s.as_str()).collect());

    for report in &initial {
        let mut keys: Vec<String> = report
            .issues
            .iter()
            .filter(|i| i.auto_fixable)
            .filter(|i| id_filter.as_ref().is_none_or(|f| f.contains(i.id.as_str())))
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
            let bundle_keys: Vec<&str> = keys
                .iter()
                .filter_map(|k| k.strip_prefix("dsh_bundle:"))
                .collect();
            let mcp_keys: Vec<String> = keys
                .iter()
                .filter(|k| !k.starts_with("dsh_bundle:"))
                .cloned()
                .collect();
            let mut total = 0usize;
            if !mcp_keys.is_empty() {
                total += fix_jsonc_dead_servers(path, &mcp_keys)?;
            }
            if !bundle_keys.is_empty() {
                total += fix_dsh_profile_bundles(path, &bundle_keys)?;
            }
            total
        } else {
            0
        };
        fixed_count += fixed;
    }

    if fixed_count > 0 {
        let cfg = crate::config::load_config(ctx);
        if cfg.backup_max_count > 0 {
            let _ = trash::prune_backups(ctx, cfg.backup_max_count as usize);
        }
    }

    let reports = run_all_doctors(ctx);
    Ok(DoctorFixReport {
        fixed_count,
        backup_paths,
        reports,
    })
}
