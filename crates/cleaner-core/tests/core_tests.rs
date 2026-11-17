use cleaner_core::doctor::{fix_all_doctors, run_all_doctors};
use cleaner_core::fs_safe::assert_safe_child;
use cleaner_core::mcp_auditor::audit_mcp;
use cleaner_core::mcp_server::handle_rpc_line;
use cleaner_core::scanner::{clean, scan_all};
use cleaner_core::trash::{list_batches, purge_batch, restore_batch};
use cleaner_core::types::{
    CleanOptions, CleanRecommendation, CleanerContext, Language, ScanCategory, ScanOptions,
};
use serde_json::json;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn old_ctx(home: &Path) -> CleanerContext {
    // Set "now" far in the future (year 2030) so newly created test files are >24h old
    let year_2030_ms: u64 = 1_900_000_000_000;
    CleanerContext {
        home_dir: home.to_path_buf(),
        now_ms: Some(year_2030_ms),
        skip_system_processes: true,
    }
}

#[test]
fn test_path_traversal_guard() {
    let root = Path::new("/tmp/trash");
    assert!(assert_safe_child(root, Path::new("/tmp/trash/batch-1")).is_ok());
    assert!(assert_safe_child(root, Path::new("/tmp/trash")).is_err());
    assert!(assert_safe_child(root, Path::new("/tmp/trash/../etc/passwd")).is_err());
}

#[test]
fn test_claude_hyphen_protection_and_unmounted_guard() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. Existing hyphenated project (must NOT be flagged as orphan)
    let real_proj = home.join("codes/my-hyphen-app");
    fs::create_dir_all(&real_proj).unwrap();

    let claude_real = home.join(".claude/projects/-Users-me-codes-my-hyphen-app");
    fs::create_dir_all(&claude_real).unwrap();
    fs::write(
        claude_real.join("session.jsonl"),
        format!("{{\"cwd\":\"{}\"}}\n", real_proj.display()),
    )
    .unwrap();

    // 2. Orphan project (cwd does not exist)
    let missing_proj = home.join("codes/deleted-project");
    let claude_orphan = home.join(".claude/projects/-Users-me-codes-deleted-project");
    fs::create_dir_all(&claude_orphan).unwrap();
    fs::write(
        claude_orphan.join("session.jsonl"),
        format!("{{\"cwd\":\"{}\"}}\n", missing_proj.display()),
    )
    .unwrap();

    // 3. Unmounted external volume (must be protected/skipped)
    let claude_unmounted = home.join(".claude/projects/-Volumes-ExternalSSD-secret");
    fs::create_dir_all(&claude_unmounted).unwrap();
    fs::write(
        claude_unmounted.join("session.jsonl"),
        "{\"cwd\":\"/Volumes/DefinitelyNotMountedDrive_XYZ/secret\"}\n",
    )
    .unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            exempt_hours: Some(24),
            agent_filter: Some(vec!["claude".to_string()]),
            lang: Some(Language::En),
        },
    );

    assert_eq!(results.len(), 1);
    let claude_res = &results[0];
    assert_eq!(claude_res.items.len(), 1);
    assert_eq!(claude_res.items[0].category, ScanCategory::OrphanSession);
    assert!(claude_res.items[0].path.ends_with("-Users-me-codes-deleted-project"));
}

#[test]
fn test_dsh_undeclared_modules_and_clean_restore_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // Create DSH profile with declared + undeclared scoped/unscoped packages
    let profile = home.join(".dsh/profiles/default");
    fs::create_dir_all(profile.join("node_modules/declared-pkg")).unwrap();
    fs::write(profile.join("node_modules/declared-pkg/index.js"), "ok").unwrap();

    fs::create_dir_all(profile.join("node_modules/orphan-pkg")).unwrap();
    fs::write(profile.join("node_modules/orphan-pkg/index.js"), "dead").unwrap();

    fs::create_dir_all(profile.join("node_modules/@scope/orphan-scoped")).unwrap();
    fs::write(profile.join("node_modules/@scope/orphan-scoped/index.js"), "dead").unwrap();

    fs::write(
        profile.join("package.json"),
        r#"{"dependencies":{"declared-pkg":"^1.0.0"}}"#,
    )
    .unwrap();

    // Also add OpenCode cache & Codex tmp
    fs::create_dir_all(home.join(".local/share/opencode/log")).unwrap();
    fs::write(home.join(".local/share/opencode/log/app.log"), "hello").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(&ctx, &ScanOptions::default());
    let dsh = results.iter().find(|r| r.agent == "dsh").unwrap();
    assert_eq!(dsh.items.len(), 2);
    assert!(dsh.items.iter().all(|i| i.category == ScanCategory::NodeModules));

    // Clean only recommended items (the 2 orphan DSH modules + opencode log)
    let report = clean(
        &ctx,
        &CleanOptions {
            exempt_hours: Some(24),
            dry_run: false,
            agent_filter: None,
            selected_ids: None,
            only_recommended: true,
            lang: Some(Language::En),
        },
    )
    .unwrap();

    assert_eq!(report.cleaned_count, 3);
    let batch_id = report.batch_id.expect("batch_id");
    assert!(!profile.join("node_modules/orphan-pkg").exists());
    assert!(profile.join("node_modules/declared-pkg").exists());

    let batches = list_batches(&ctx);
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].items.len(), 3);

    // Restore batch
    let restored = restore_batch(&ctx, &batch_id).unwrap();
    assert_eq!(restored.restored, 3);
    assert!(restored.failed.is_empty());
    assert!(profile.join("node_modules/orphan-pkg/index.js").exists());

    // Purge batch
    purge_batch(&ctx, &batch_id).unwrap();
    assert!(list_batches(&ctx).is_empty());
}

#[test]
fn test_active_24h_protection_exempts_recent_cache() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    fs::create_dir_all(home.join(".claude/debug")).unwrap();
    fs::write(home.join(".claude/debug/latest.log"), "active session").unwrap();

    // Use real current time so mtime is within 24h
    let mut ctx = CleanerContext::with_home(home.to_path_buf());
    ctx.skip_system_processes = true;

    let results = scan_all(&ctx, &ScanOptions::default());
    let claude = results.iter().find(|r| r.agent == "claude").unwrap();
    assert_eq!(claude.items[0].recommendation, CleanRecommendation::Exempt);

    // Clean should skip exempt items
    let clean_report = clean(&ctx, &CleanOptions::default()).unwrap();
    assert_eq!(clean_report.cleaned_count, 0);
    assert!(home.join(".claude/debug/latest.log").exists());
}

#[test]
fn test_doctor_preserves_comments_across_jsonc_toml_yaml() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // OpenCode JSONC with comments
    let opencode_cfg = home.join(".config/opencode/opencode.jsonc");
    fs::create_dir_all(opencode_cfg.parent().unwrap()).unwrap();
    fs::write(
        &opencode_cfg,
        r#"{
  // Keep this top comment!
  "theme": "dark",
  "mcpServers": {
    // Keep alive server
    "alive": { "command": "sh" },
    // Dead server to remove
    "dead_srv": { "command": "/nonexistent/binary/xyz_12345" }
  }
}
"#,
    )
    .unwrap();

    // Codex TOML with comments
    let codex_cfg = home.join(".codex/config.toml");
    fs::create_dir_all(codex_cfg.parent().unwrap()).unwrap();
    fs::write(
        &codex_cfg,
        r#"# Global Codex comment
model = "o3"

[mcp.servers.alive]
command = "sh"

[mcp.servers.dead_toml]
command = "/nonexistent/toml/cmd_999"
"#,
    )
    .unwrap();

    // DSH YAML with comments
    let dsh_cfg = home.join(".dsh/settings.yaml");
    fs::create_dir_all(dsh_cfg.parent().unwrap()).unwrap();
    fs::write(
        &dsh_cfg,
        r#"# DSH header comment
plugins:
  - demo-plugin
mcpServers:
  # Alive entry
  alive:
    command: sh
  dead_yaml:
    command: /nonexistent/yaml/cmd_999
    args:
      - --stdio
"#,
    )
    .unwrap();

    let ctx = old_ctx(home);

    // Audit MCP should find dead links and duplicates across agents (alive on 3 agents!)
    let mcp = audit_mcp(&ctx);
    assert_eq!(mcp.dead_links.len(), 3);
    assert_eq!(mcp.duplicates.len(), 1); // "alive::sh" appears across opencode/codex/dsh

    let initial = run_all_doctors(&ctx);
    assert_eq!(initial.iter().map(|r| r.issues.len()).sum::<usize>(), 3);

    let fix_report = fix_all_doctors(&ctx).unwrap();
    assert_eq!(fix_report.fixed_count, 3);
    assert_eq!(fix_report.backup_paths.len(), 3);
    assert!(fix_report.reports.iter().all(|r| r.healthy));

    let fixed_jsonc = fs::read_to_string(&opencode_cfg).unwrap();
    assert!(fixed_jsonc.contains("// Keep this top comment!"));
    assert!(!fixed_jsonc.contains("dead_srv"));
    assert!(fixed_jsonc.contains("alive"));

    let fixed_toml = fs::read_to_string(&codex_cfg).unwrap();
    assert!(fixed_toml.contains("# Global Codex comment"));
    assert!(!fixed_toml.contains("dead_toml"));
    assert!(fixed_toml.contains("alive"));

    let fixed_yaml = fs::read_to_string(&dsh_cfg).unwrap();
    assert!(fixed_yaml.contains("# DSH header comment"));
    assert!(!fixed_yaml.contains("dead_yaml"));
    assert!(fixed_yaml.contains("alive:"));
}

#[test]
fn test_mcp_server_jsonrpc_protocol() {
    let tmp = TempDir::new().unwrap();
    let ctx = old_ctx(tmp.path());

    let init_req = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string();
    let init_resp: serde_json::Value =
        serde_json::from_str(&handle_rpc_line(&ctx, &init_req).unwrap()).unwrap();
    assert_eq!(init_resp["result"]["serverInfo"]["name"], "agent-cleaner");

    let list_req = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string();
    let list_resp: serde_json::Value =
        serde_json::from_str(&handle_rpc_line(&ctx, &list_req).unwrap()).unwrap();
    let tools = list_resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 5);

    // Notification has no id -> no reply
    let notif = json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string();
    assert!(handle_rpc_line(&ctx, &notif).is_none());

    let call_req = json!({
        "jsonrpc":"2.0",
        "id":3,
        "method":"tools/call",
        "params":{"name":"cleaner_scan","arguments":{}}
    })
    .to_string();
    let call_resp: serde_json::Value =
        serde_json::from_str(&handle_rpc_line(&ctx, &call_req).unwrap()).unwrap();
    assert!(call_resp["result"]["content"][0]["text"].is_string());
}

#[test]
fn test_bilingual_scan_descriptions_and_stable_ids() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    fs::create_dir_all(home.join(".claude/debug")).unwrap();
    fs::write(home.join(".claude/debug/run.log"), "abc").unwrap();

    let ctx = old_ctx(home);
    let zh = scan_all(
        &ctx,
        &ScanOptions {
            exempt_hours: Some(24),
            agent_filter: Some(vec!["claude".to_string()]),
            lang: Some(Language::Zh),
        },
    );
    let en = scan_all(
        &ctx,
        &ScanOptions {
            exempt_hours: Some(24),
            agent_filter: Some(vec!["claude".to_string()]),
            lang: Some(Language::En),
        },
    );

    let zh_item = &zh[0].items[0];
    let en_item = &en[0].items[0];
    assert_eq!(zh_item.id, en_item.id);
    assert!(zh_item.description.contains("调试日志"));
    assert!(en_item.description.contains("debug logs"));
    assert_ne!(zh_item.recommendation_reason, en_item.recommendation_reason);
}

#[test]
fn test_dynamic_discovery_custom_rules_and_mcp_doctor() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. Newly supported built-in target (ZCode)
    fs::create_dir_all(home.join(".zcode/v2/logs")).unwrap();
    fs::write(home.join(".zcode/v2/logs/zcode.log"), "zcode log").unwrap();

    // 2. Unknown AI agent with marker (mcp.json + skills/) + safe logs + sensitive credentials
    fs::create_dir_all(home.join(".novacode/skills")).unwrap();
    fs::write(home.join(".novacode/skills/review.md"), "# skill").unwrap();
    fs::write(home.join(".novacode/credentials.json"), "{\"token\":\"secret\"}").unwrap();
    fs::create_dir_all(home.join(".novacode/logs")).unwrap();
    fs::write(home.join(".novacode/logs/agent.log"), "nova log").unwrap();
    fs::write(
        home.join(".novacode/mcp.json"),
        r#"{
  // NovaCode MCP config
  "mcpServers": {
    "alive": { "command": "sh" },
    "dead_nova": { "command": "/nonexistent/nova_mcp_bin_xyz" }
  }
}
"#,
    )
    .unwrap();

    // 3. Unrelated non-agent dotdir and Apple system caches (must NOT be flagged)
    fs::create_dir_all(home.join(".randomtool/logs")).unwrap();
    fs::write(home.join(".randomtool/logs/app.log"), "ignore me").unwrap();
    fs::create_dir_all(home.join("Library/Caches/com.apple.icloudmailagent")).unwrap();
    fs::write(
        home.join("Library/Caches/com.apple.icloudmailagent/Cache.db"),
        "apple cache",
    )
    .unwrap();
    fs::create_dir_all(home.join("Library/Caches/com.apple.campo")).unwrap();
    fs::write(home.join("Library/Caches/com.apple.campo/data"), "apple").unwrap();

    // 4. Custom user rule in ~/.agent-cleaner/targets.toml
    fs::create_dir_all(home.join(".agent-cleaner")).unwrap();
    fs::create_dir_all(home.join(".customclaw/cache")).unwrap();
    fs::write(home.join(".customclaw/cache/blob.bin"), "123456").unwrap();
    fs::write(
        home.join(".agent-cleaner/targets.toml"),
        r#"
[[targets]]
id = "customclaw"
usage_dirs = ["~/.customclaw"]

[[targets.cleanable]]
path = "~/.customclaw/cache"
category = "cache"
description = "CustomClaw cache"
"#,
    )
    .unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(&ctx, &ScanOptions::default());

    assert!(results.iter().any(|r| r.agent == "zcode"));
    assert!(results.iter().any(|r| r.agent == "customclaw"));
    assert!(!results.iter().any(|r| r.agent == "randomtool"));
    assert!(!results.iter().any(|r| r.agent.contains("apple")));

    let nova = results
        .iter()
        .find(|r| r.agent == "novacode")
        .expect("unknown agent novacode should be auto-discovered");
    assert_eq!(nova.items.len(), 1);
    assert!(nova.items[0].path.ends_with("logs"));
    // Heuristic discovery must never auto-recommend deletion without human review.
    assert_eq!(nova.items[0].recommendation, CleanRecommendation::Optional);

    // MCP auditor & Doctor should also pick up .novacode/mcp.json and fix it while preserving comments.
    let mcp = audit_mcp(&ctx);
    assert_eq!(mcp.dead_links.len(), 1);
    assert_eq!(mcp.dead_links[0].agent, "novacode");

    let fix_report = fix_all_doctors(&ctx).unwrap();
    assert_eq!(fix_report.fixed_count, 1);
    let fixed_nova = fs::read_to_string(home.join(".novacode/mcp.json")).unwrap();
    assert!(fixed_nova.contains("// NovaCode MCP config"));
    assert!(!fixed_nova.contains("dead_nova"));
    assert!(fixed_nova.contains("alive"));
}
