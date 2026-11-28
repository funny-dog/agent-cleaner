use cleaner_core::config::{add_ignored_path, load_config, save_config};
use cleaner_core::doctor::{fix_all_doctors, fix_doctor_issues, run_all_doctors};
use cleaner_core::fs_safe::{assert_safe_child, extract_external_mountpoint};
use cleaner_core::mcp_auditor::audit_mcp;
use cleaner_core::mcp_server::handle_rpc_line;
use cleaner_core::scanner::{clean, scan_all, scan_all_with_progress};
use cleaner_core::trash::{list_backups, list_batches, purge_batch, restore_backup, restore_batch};
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

fn path_ends_with(path: &str, suffix: &str) -> bool {
    Path::new(path).ends_with(suffix)
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
        format!("{}\n", json!({ "cwd": real_proj.to_string_lossy() })),
    )
    .unwrap();

    // 2. Orphan project (cwd does not exist)
    let missing_proj = home.join("codes/deleted-project");
    let claude_orphan = home.join(".claude/projects/-Users-me-codes-deleted-project");
    fs::create_dir_all(&claude_orphan).unwrap();
    fs::write(
        claude_orphan.join("session.jsonl"),
        format!("{}\n", json!({ "cwd": missing_proj.to_string_lossy() })),
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
    assert!(claude_res.items[0]
        .path
        .ends_with("-Users-me-codes-deleted-project"));
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
    fs::write(
        profile.join("node_modules/@scope/orphan-scoped/index.js"),
        "dead",
    )
    .unwrap();

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
    assert!(dsh
        .items
        .iter()
        .all(|i| i.category == ScanCategory::NodeModules));

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
            permanent: false,
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
    assert_eq!(tools.len(), 8);

    // Notification has no id -> no reply
    let notif = json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string();
    assert!(handle_rpc_line(&ctx, &notif).is_none());

    for (id, tool_name, arguments) in [
        (3, "cleaner_scan", json!({})),
        (4, "cleaner_overview", json!({})),
        (5, "cleaner_config", json!({"action": "get"})),
        (6, "cleaner_backups", json!({"action": "list"})),
    ] {
        let call_req = json!({
            "jsonrpc":"2.0",
            "id":id,
            "method":"tools/call",
            "params":{"name":tool_name,"arguments":arguments}
        })
        .to_string();
        let call_resp: serde_json::Value =
            serde_json::from_str(&handle_rpc_line(&ctx, &call_req).unwrap()).unwrap();
        assert!(call_resp["result"]["content"][0]["text"].is_string());
    }
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
    fs::write(
        home.join(".novacode/credentials.json"),
        "{\"token\":\"secret\"}",
    )
    .unwrap();
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

#[test]
fn test_dsh_deep_scan_transitive_deps_sessions_and_doctor() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. DSH profile with pnpm v5 .modules.yaml (hoistedLocations + injectedDeps) + transitive dep + true orphan
    let profile = home.join(".dsh/profiles/desktop");
    fs::create_dir_all(profile.join("node_modules/declared-pkg")).unwrap();
    fs::write(
        profile.join("node_modules/declared-pkg/package.json"),
        r#"{"name":"declared-pkg","dependencies":{"transitive-pkg":"^1.0.0"}}"#,
    )
    .unwrap();
    fs::create_dir_all(profile.join("node_modules/transitive-pkg")).unwrap();
    fs::write(profile.join("node_modules/transitive-pkg/index.js"), "ok").unwrap();
    fs::create_dir_all(profile.join("node_modules/@scope/hoisted-pkg")).unwrap();
    fs::write(
        profile.join("node_modules/@scope/hoisted-pkg/index.js"),
        "ok",
    )
    .unwrap();
    fs::create_dir_all(profile.join("node_modules/injected-pkg")).unwrap();
    fs::write(profile.join("node_modules/injected-pkg/index.js"), "ok").unwrap();
    fs::create_dir_all(profile.join("node_modules/truly-orphan-pkg")).unwrap();
    fs::write(
        profile.join("node_modules/truly-orphan-pkg/index.js"),
        "dead",
    )
    .unwrap();

    fs::write(
        profile.join("node_modules/.modules.yaml"),
        r#"hoistedDependencies: {}
injectedDeps:
  ../../../local/injected:
    - node_modules/injected-pkg
hoistedLocations:
  "@scope/hoisted-pkg@1.0.0":
    - node_modules/@scope/hoisted-pkg
"#,
    )
    .unwrap();

    fs::write(
        profile.join("package.json"),
        r#"{
  "dependencies": {
    "declared-pkg": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "declared-pkg",
        "missing-bundle-plugin"
      ]
    }
  }
}"#,
    )
    .unwrap();
    fs::write(
        profile.join("cordis.patch.yml"),
        "- id: agent-cleaner\n  name: dsh-agent-cleaner\n",
    )
    .unwrap();

    // 2. DSH Desktop Webview cache
    let desktop_code_cache =
        home.join("Library/Application Support/@deepseek-ai/dsh-desktop/Code Cache");
    fs::create_dir_all(&desktop_code_cache).unwrap();
    fs::write(desktop_code_cache.join("data_0"), "cached-bytecode").unwrap();

    // 3. DSH sessions + workspace.json (active, archived, missing workspace, unmounted external drive)
    let active_ws = home.join("workspaces/active-app");
    fs::create_dir_all(&active_ws).unwrap();
    let missing_ws = home.join("workspaces/deleted-app");

    let encode_ws = |p: &Path| {
        format!(
            "--{}--",
            p.to_string_lossy()
                .trim_matches(['/', '\\'])
                .replace(['/', '\\'], "-")
                .replace(':', "")
        )
    };
    let active_encoded = encode_ws(&active_ws);
    let missing_encoded = encode_ws(&missing_ws);

    let active_sess_dir = home.join(".dsh/sessions").join(&active_encoded);
    fs::create_dir_all(active_sess_dir.join("session-active-1")).unwrap();
    fs::write(
        active_sess_dir.join("session-active-1/session.v4.jsonl.zstd"),
        "active",
    )
    .unwrap();
    fs::create_dir_all(active_sess_dir.join("session-archived-1")).unwrap();
    fs::write(
        active_sess_dir.join("session-archived-1/session.v4.jsonl.zstd"),
        "archived",
    )
    .unwrap();

    let missing_sess_dir = home.join(".dsh/sessions").join(&missing_encoded);
    fs::create_dir_all(missing_sess_dir.join("session-orphan-1")).unwrap();
    fs::write(
        missing_sess_dir.join("session-orphan-1/session.v4.jsonl.zstd"),
        "orphan",
    )
    .unwrap();

    let unmounted_sess_dir =
        home.join(".dsh/sessions/--Volumes-DefinitelyUnmountedDrive_XYZ-app--");
    fs::create_dir_all(unmounted_sess_dir.join("session-ext-1")).unwrap();
    fs::write(
        unmounted_sess_dir.join("session-ext-1/session.v4.jsonl.zstd"),
        "external",
    )
    .unwrap();

    fs::create_dir_all(home.join(".dsh/storages")).unwrap();
    fs::write(
        home.join(".dsh/storages/workspace.json"),
        serde_json::to_string_pretty(&json!({
            "global": {
                "archivedSessionIds": ["session-archived-1"]
            },
            "tables": {
                "workspaces": {
                    "ws-1": {
                        "path": active_ws.to_string_lossy(),
                        "sessionIds": ["session-active-1", "session-archived-1"]
                    },
                    "ws-2": {
                        "path": missing_ws.to_string_lossy(),
                        "sessionIds": ["session-orphan-1"]
                    },
                    "ws-3": {
                        "path": "/Volumes/DefinitelyUnmountedDrive_XYZ/app",
                        "sessionIds": ["session-ext-1"]
                    }
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            exempt_hours: Some(24),
            agent_filter: Some(vec!["dsh".to_string()]),
            lang: Some(Language::En),
        },
    );
    assert_eq!(results.len(), 1);
    let dsh = &results[0];
    let paths: Vec<&str> = dsh.items.iter().map(|i| i.path.as_str()).collect();

    // Transitive, hoisted, and injected deps must NOT be flagged
    assert!(!paths.iter().any(|p| p.ends_with("declared-pkg")));
    assert!(!paths.iter().any(|p| p.ends_with("transitive-pkg")));
    assert!(!paths.iter().any(|p| p.ends_with("hoisted-pkg")));
    assert!(!paths.iter().any(|p| p.ends_with("injected-pkg")));
    // True orphan module IS flagged
    assert!(paths.iter().any(|p| p.ends_with("truly-orphan-pkg")));

    // Desktop cache, archived session, and missing workspace session ARE flagged
    assert!(paths.iter().any(|p| p.ends_with("Code Cache")));
    assert!(paths.iter().any(|p| p.ends_with("session-archived-1")));
    assert!(paths.iter().any(|p| p.ends_with(&missing_encoded)));

    // Active session and unmounted external drive sessions MUST NOT be flagged
    assert!(!paths.iter().any(|p| p.ends_with("session-active-1")));
    assert!(!paths
        .iter()
        .any(|p| p.contains("DefinitelyUnmountedDrive_XYZ")));

    // Doctor checks DSH profile cordis.patch.yml + package.json missing bundle and auto-heals it
    let doctors = run_all_doctors(&ctx);
    let pkg_report = doctors
        .iter()
        .find(|r| path_ends_with(&r.path, "profiles/desktop/package.json"))
        .expect("DSH profile package.json should be inspected by doctor");
    assert!(!pkg_report.healthy);
    assert_eq!(pkg_report.issues.len(), 1);
    assert!(pkg_report.issues[0]
        .message
        .contains("missing-bundle-plugin"));

    let fix = fix_all_doctors(&ctx).unwrap();
    assert_eq!(fix.fixed_count, 1);
    let updated_pkg = fs::read_to_string(profile.join("package.json")).unwrap();
    assert!(!updated_pkg.contains("missing-bundle-plugin"));
    assert!(updated_pkg.contains("@deepseek-ai/dsh-base"));
    assert!(updated_pkg.contains("declared-pkg"));
}

#[test]
fn test_brand_variants_claude_versions_and_lima_snapshots() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // Variant dirs for Qoder, WorkBuddy, Kimi
    fs::create_dir_all(home.join(".qoder-cn/logs")).unwrap();
    fs::write(home.join(".qoder-cn/logs/app.log"), "qoder cn log").unwrap();
    fs::create_dir_all(home.join(".workbuddy-ai/logs")).unwrap();
    fs::write(home.join(".workbuddy-ai/logs/wb.log"), "wb ai log").unwrap();
    fs::create_dir_all(home.join(".kimi-code/sessions")).unwrap();
    fs::write(home.join(".kimi-code/sessions/s1.json"), "{}").unwrap();
    fs::create_dir_all(home.join(".kimi-code/search-index")).unwrap();
    fs::write(home.join(".kimi-code/search-index/idx.bin"), "123").unwrap();

    // Claude 3rd-party variant desktop cache & multiple claude-code binary versions
    let wb_3p = home.join("Library/Application Support/Claude-wb-cn-3p");
    fs::create_dir_all(wb_3p.join("Code Cache")).unwrap();
    fs::write(wb_3p.join("Code Cache/data"), "bytecode").unwrap();
    fs::create_dir_all(wb_3p.join("claude-code/2.1.317")).unwrap();
    fs::write(wb_3p.join("claude-code/2.1.317/claude"), "old bin").unwrap();
    fs::create_dir_all(wb_3p.join("claude-code/2.1.321")).unwrap();
    fs::write(wb_3p.join("claude-code/2.1.321/claude"), "new bin").unwrap();

    // Claude Cage Lima VM instances + _config
    let lima = home.join(".claude-cage/state/lima");
    fs::create_dir_all(lima.join("_config")).unwrap();
    fs::write(lima.join("_config/user"), "key").unwrap();
    fs::create_dir_all(lima.join("base")).unwrap();
    fs::write(lima.join("base/disk"), "base vm").unwrap();
    fs::create_dir_all(lima.join("claude-cage-workspace-1")).unwrap();
    fs::write(lima.join("claude-cage-workspace-1/disk"), "ws vm").unwrap();

    // Backup file
    fs::write(home.join(".claude.json.backup"), "{}").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            lang: Some(Language::En),
            ..Default::default()
        },
    );

    let qoder = results.iter().find(|r| r.agent == "qoder").unwrap();
    assert!(qoder
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".qoder-cn/logs")));

    let wb = results.iter().find(|r| r.agent == "workbuddy").unwrap();
    assert!(wb
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".workbuddy-ai/logs")));

    let kimi = results.iter().find(|r| r.agent == "kimi").unwrap();
    assert!(kimi
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".kimi-code/sessions")));
    assert!(kimi
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".kimi-code/search-index")));

    let claude = results.iter().find(|r| r.agent == "claude").unwrap();
    assert!(claude
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "Claude-wb-cn-3p/Code Cache")));
    assert!(claude.items.iter().any(|i| {
        path_ends_with(&i.path, "claude-code/2.1.317") && i.category == ScanCategory::Updater
    }));
    assert!(!claude
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "claude-code/2.1.321")));
    assert!(!claude
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "lima/_config")));
    let base_vm = claude
        .items
        .iter()
        .find(|i| path_ends_with(&i.path, "lima/base"))
        .unwrap();
    assert_eq!(base_vm.category, ScanCategory::Snapshot);
    assert_eq!(base_vm.recommendation, CleanRecommendation::Optional);
    assert!(claude
        .items
        .iter()
        .any(|i| { path_ends_with(&i.path, ".claude-cage/state/lima/claude-cage-workspace-1") }));
    assert!(claude
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".claude.json.backup")
            && i.category == ScanCategory::Backup));
}

#[test]
fn test_high_usage_subdirs_and_library_logs() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // Gemini / Antigravity subdirs
    fs::create_dir_all(home.join(".gemini/antigravity/log")).unwrap();
    fs::write(home.join(".gemini/antigravity/log/ag.log"), "log").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity/scratch")).unwrap();
    fs::write(home.join(".gemini/antigravity/scratch/tmp.txt"), "scratch").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity/brain/conv-1")).unwrap();
    fs::write(
        home.join(".gemini/antigravity/brain/conv-1/note.md"),
        "brain",
    )
    .unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity/conversations")).unwrap();
    fs::write(home.join(".gemini/antigravity/conversations/c1.db"), "db").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity-cli/brain/conv-2")).unwrap();
    fs::write(
        home.join(".gemini/antigravity-cli/brain/conv-2/note.md"),
        "cli brain",
    )
    .unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity-browser-profile/Default/Code Cache"))
        .unwrap();
    fs::write(
        home.join(".gemini/antigravity-browser-profile/Default/Code Cache/js"),
        "js",
    )
    .unwrap();
    fs::create_dir_all(home.join("Library/Logs/Antigravity")).unwrap();
    fs::write(home.join("Library/Logs/Antigravity/main.log"), "ag mac log").unwrap();

    // ZCode CLI, Codex SQLite & Logs, OpenCode dotdir, DSH Library logs
    fs::create_dir_all(home.join(".zcode/cli/rollout")).unwrap();
    fs::write(home.join(".zcode/cli/rollout/r1.jsonl"), "rollout").unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(home.join(".codex/logs_2.sqlite"), "sqlite").unwrap();
    fs::create_dir_all(home.join("Library/Logs/com.openai.codex")).unwrap();
    fs::write(
        home.join("Library/Logs/com.openai.codex/codex.log"),
        "codex log",
    )
    .unwrap();
    fs::create_dir_all(home.join(".opencode/logs")).unwrap();
    fs::write(home.join(".opencode/logs/opencode.log"), "oc log").unwrap();
    fs::create_dir_all(home.join("Library/Logs/DeepSeek Harness")).unwrap();
    fs::write(
        home.join("Library/Logs/DeepSeek Harness/dsh.log"),
        "dsh log",
    )
    .unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            lang: Some(Language::En),
            ..Default::default()
        },
    );

    let gemini = results.iter().find(|r| r.agent == "gemini").unwrap();
    assert!(gemini
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".gemini/antigravity/log")));
    assert!(gemini
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".gemini/antigravity/scratch")));
    assert!(gemini.items.iter().any(|i| {
        path_ends_with(&i.path, ".gemini/antigravity/brain")
            && i.recommendation == CleanRecommendation::Optional
    }));
    assert!(gemini.items.iter().any(|i| {
        path_ends_with(&i.path, ".gemini/antigravity/conversations")
            && i.recommendation == CleanRecommendation::Optional
    }));
    assert!(gemini
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".gemini/antigravity-cli/brain")));
    assert!(gemini
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "Default/Code Cache")));
    assert!(gemini
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "Library/Logs/Antigravity")));

    let zcode = results.iter().find(|r| r.agent == "zcode").unwrap();
    assert!(zcode
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".zcode/cli/rollout")));

    let codex = results.iter().find(|r| r.agent == "codex").unwrap();
    assert!(codex
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".codex/logs_2.sqlite")));
    assert!(codex
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "Library/Logs/com.openai.codex")));

    let opencode = results.iter().find(|r| r.agent == "opencode").unwrap();
    assert!(opencode
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".opencode/logs")));

    let dsh = results.iter().find(|r| r.agent == "dsh").unwrap();
    assert!(dsh
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "Library/Logs/DeepSeek Harness")));
}

#[test]
fn test_uv_bucketed_cold_cache_and_xdg_cache_library_logs_discovery() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. uv bucketed cache + .tmp* + empty .tmp*
    fs::create_dir_all(home.join(".cache/uv/archive-v0/pkg-hash-1")).unwrap();
    fs::write(
        home.join(".cache/uv/archive-v0/pkg-hash-1/data.whl"),
        "wheel bytes",
    )
    .unwrap();
    fs::create_dir_all(home.join(".cache/uv/.tmp14EAgl")).unwrap();
    fs::write(home.join(".cache/uv/.tmp14EAgl/part"), "partial").unwrap();
    fs::create_dir_all(home.join(".cache/uv/.tmpEmpty")).unwrap();

    // 2. Puppeteer browser cache (should be claimed by pkg-cache, not unknown discovery)
    fs::create_dir_all(home.join(".cache/puppeteer/chrome/mac_arm-156")).unwrap();
    fs::write(
        home.join(".cache/puppeteer/chrome/mac_arm-156/chrome"),
        "browser",
    )
    .unwrap();

    // 3. Unknown agent caches under ~/.cache and ~/Library/Logs, plus root .log file
    fs::create_dir_all(home.join(".cache/oh-my-opencode/bin")).unwrap();
    fs::write(home.join(".cache/oh-my-opencode/bin/omo"), "binary").unwrap();
    fs::create_dir_all(home.join("Library/Logs/SuperAgent")).unwrap();
    fs::write(home.join("Library/Logs/SuperAgent/app.log"), "super agent").unwrap();
    fs::create_dir_all(home.join(".myagent")).unwrap();
    fs::write(home.join(".myagent/daemon.log"), "daemon log").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            lang: Some(Language::En),
            ..Default::default()
        },
    );

    let pkg_cache = results.iter().find(|r| r.agent == "pkg-cache").unwrap();
    assert!(pkg_cache.items.iter().any(|i| {
        path_ends_with(&i.path, "archive-v0/pkg-hash-1") && i.category == ScanCategory::ColdCache
    }));
    assert!(pkg_cache
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".tmp14EAgl") && i.category == ScanCategory::Tmp));
    assert!(!pkg_cache
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, ".tmpEmpty")));
    assert!(pkg_cache.items.iter().any(|i| {
        path_ends_with(&i.path, "chrome/mac_arm-156") && i.category == ScanCategory::ColdCache
    }));

    let omo = results
        .iter()
        .find(|r| r.agent == "oh-my-opencode")
        .unwrap();
    assert_eq!(omo.items.len(), 1);
    assert_eq!(omo.items[0].category, ScanCategory::Cache);
    assert_eq!(omo.items[0].recommendation, CleanRecommendation::Optional);

    let superagent = results.iter().find(|r| r.agent == "superagent").unwrap();
    assert_eq!(superagent.items.len(), 1);
    assert_eq!(superagent.items[0].category, ScanCategory::Log);
    assert_eq!(
        superagent.items[0].recommendation,
        CleanRecommendation::Optional
    );

    let myagent = results.iter().find(|r| r.agent == "myagent").unwrap();
    assert!(myagent
        .items
        .iter()
        .any(|i| path_ends_with(&i.path, "daemon.log") && i.category == ScanCategory::Log));
}

#[test]
fn test_mcp_and_doctor_extended_schemas() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. Codex official [mcp_servers.<name>]
    let codex_cfg = home.join(".codex/config.toml");
    fs::create_dir_all(codex_cfg.parent().unwrap()).unwrap();
    fs::write(
        &codex_cfg,
        r#"# Keep Codex comment
[mcp_servers.alive]
command = "sh"

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"

[mcp_servers.dead_codex]
command = "/nonexistent/codex_mcp_xyz"
"#,
    )
    .unwrap();

    // 2. Claude Desktop claude_desktop_config.json
    let desktop_cfg =
        home.join("Library/Application Support/Claude-qoder-cn-3p/claude_desktop_config.json");
    fs::create_dir_all(desktop_cfg.parent().unwrap()).unwrap();
    fs::write(
        &desktop_cfg,
        r#"{
  "mcpServers": {
    "alive_desktop": { "command": "sh" },
    "dead_desktop": { "command": "/nonexistent/desktop_mcp_xyz" }
  }
}"#,
    )
    .unwrap();

    // 3. ~/.claude.json nested projects.<path>.mcpServers
    let claude_json = home.join(".claude.json");
    fs::write(
        &claude_json,
        r#"{
  "projects": {
    "/Users/test/my-app": {
      "mcpServers": {
        "alive_proj": { "command": "sh" },
        "dead_proj": { "command": "/nonexistent/proj_mcp_xyz" }
      }
    }
  }
}"#,
    )
    .unwrap();

    // 4. OpenCode "mcp" with array command & remote entry
    let opencode_cfg = home.join(".config/opencode/opencode.jsonc");
    fs::create_dir_all(opencode_cfg.parent().unwrap()).unwrap();
    fs::write(
        &opencode_cfg,
        r#"{
  // OpenCode comment
  "mcp": {
    "alive_arr": { "type": "local", "command": ["sh", "-c"] },
    "dead_arr": { "type": "local", "command": ["/nonexistent/opencode_arr_xyz", "--stdio"] },
    "remote_srv": { "type": "remote", "url": "https://example.com/mcp" }
  }
}"#,
    )
    .unwrap();

    // 5. Zed context_servers with object command
    let zed_cfg = home.join("Library/Application Support/Zed/settings.json");
    fs::create_dir_all(zed_cfg.parent().unwrap()).unwrap();
    fs::write(
        &zed_cfg,
        r#"{
  // Zed comment
  "context_servers": {
    "alive_zed": { "command": { "path": "sh" } },
    "dead_zed": { "command": { "path": "/nonexistent/zed_mcp_xyz", "args": [] } }
  }
}"#,
    )
    .unwrap();

    let ctx = old_ctx(home);
    let mcp = audit_mcp(&ctx);
    let dead_names: Vec<&str> = mcp.dead_links.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(mcp.dead_links.len(), 5, "dead_links: {dead_names:?}");
    assert!(dead_names.contains(&"dead_codex"));
    assert!(dead_names.contains(&"dead_desktop"));
    assert!(dead_names.contains(&"dead_proj"));
    assert!(dead_names.contains(&"dead_arr"));
    assert!(dead_names.contains(&"dead_zed"));

    let fix = fix_all_doctors(&ctx).unwrap();
    assert_eq!(fix.fixed_count, 5);
    assert!(fix.reports.iter().all(|r| r.healthy));

    let fixed_codex = fs::read_to_string(&codex_cfg).unwrap();
    assert!(fixed_codex.contains("# Keep Codex comment"));
    assert!(fixed_codex.contains("[mcp_servers.alive]"));
    assert!(fixed_codex.contains("[mcp_servers.exa]"));
    assert!(!fixed_codex.contains("dead_codex"));

    let fixed_desktop = fs::read_to_string(&desktop_cfg).unwrap();
    assert!(fixed_desktop.contains("alive_desktop"));
    assert!(!fixed_desktop.contains("dead_desktop"));

    let fixed_claude_json = fs::read_to_string(&claude_json).unwrap();
    assert!(fixed_claude_json.contains("alive_proj"));
    assert!(!fixed_claude_json.contains("dead_proj"));

    let fixed_opencode = fs::read_to_string(&opencode_cfg).unwrap();
    assert!(fixed_opencode.contains("// OpenCode comment"));
    assert!(fixed_opencode.contains("alive_arr"));
    assert!(fixed_opencode.contains("remote_srv"));
    assert!(!fixed_opencode.contains("dead_arr"));

    let fixed_zed = fs::read_to_string(&zed_cfg).unwrap();
    assert!(fixed_zed.contains("// Zed comment"));
    assert!(fixed_zed.contains("alive_zed"));
    assert!(!fixed_zed.contains("dead_zed"));
}

#[test]
fn test_permanent_clean_bypasses_trash() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    let log_dir = home.join(".claude/debug");
    fs::create_dir_all(&log_dir).unwrap();
    let log_file = log_dir.join("old.log");
    fs::write(&log_file, "old debug log").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(
        &ctx,
        &ScanOptions {
            exempt_hours: Some(24),
            agent_filter: Some(vec!["claude".to_string()]),
            lang: Some(Language::En),
        },
    );
    let item_id = results[0].items[0].id.clone();

    let report = clean(
        &ctx,
        &CleanOptions {
            exempt_hours: Some(24),
            dry_run: false,
            agent_filter: None,
            selected_ids: Some(vec![item_id]),
            only_recommended: false,
            lang: Some(Language::En),
            permanent: true,
        },
    )
    .unwrap();

    assert!(report.batch_id.is_none());
    assert_eq!(report.cleaned_count, 1);
    assert!(report.freed_bytes > 0);
    assert!(report.errors.is_empty());
    assert!(!log_dir.exists() && !log_file.exists());
    assert!(list_batches(&ctx).is_empty());
}

#[test]
fn test_config_ignore_whitelist_and_progress_callback() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    let claude_debug = home.join(".claude/debug");
    let claude_paste = home.join(".claude/paste-cache");
    fs::create_dir_all(&claude_debug).unwrap();
    fs::create_dir_all(&claude_paste).unwrap();
    fs::write(claude_debug.join("a.log"), "debug").unwrap();
    fs::write(claude_paste.join("b.txt"), "paste").unwrap();

    // Ignore debug directory & hide opencode agent entirely
    let ctx = old_ctx(home);
    fs::create_dir_all(home.join(".local/share/opencode/log")).unwrap();
    fs::write(home.join(".local/share/opencode/log/app.log"), "ignored").unwrap();

    add_ignored_path(&ctx, "~/.claude/debug").unwrap();
    let mut cfg = load_config(&ctx);
    cfg.ignored_agents = vec!["opencode".to_string()];
    save_config(&ctx, &cfg).unwrap();

    let mut progress_events = Vec::new();
    let results = scan_all_with_progress(&ctx, &ScanOptions::default(), |p| {
        progress_events.push(p);
    });
    assert!(!progress_events.is_empty());
    assert!(progress_events.iter().all(|p| p.total >= p.completed));
    assert!(!results.iter().any(|r| r.agent == "opencode"));

    let claude = results.iter().find(|r| r.agent == "claude").unwrap();
    let debug_item = claude
        .items
        .iter()
        .find(|i| i.path.ends_with("debug"))
        .unwrap();
    assert_eq!(debug_item.recommendation, CleanRecommendation::Exempt);
    let paste_item = claude
        .items
        .iter()
        .find(|i| i.path.ends_with("paste-cache"))
        .unwrap();
    assert_eq!(paste_item.recommendation, CleanRecommendation::Recommended);
}

#[test]
fn test_selective_doctor_fix_backup_restore_and_mcp_conflicts() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    fs::create_dir_all(home.join(".claude")).unwrap();
    let claude_cfg = home.join(".claude/settings.json");
    fs::write(
        &claude_cfg,
        r#"{
  "mcpServers": {
    "dead_one": { "command": "nonexistent_cmd_alpha_111" },
    "dead_two": { "command": "nonexistent_cmd_beta_222" },
    "shared_srv": { "command": "sh", "args": ["-c", "echo claude"] }
  }
}"#,
    )
    .unwrap();

    fs::create_dir_all(home.join(".cursor")).unwrap();
    fs::write(
        home.join(".cursor/mcp.json"),
        r#"{
  "mcpServers": {
    "shared_srv": { "command": "sh", "args": ["-c", "echo cursor"] }
  }
}"#,
    )
    .unwrap();

    let ctx = old_ctx(home);
    let mcp = audit_mcp(&ctx);
    assert_eq!(mcp.conflicts.len(), 1);
    assert_eq!(mcp.conflicts[0].len(), 2);

    // Fix only dead_one, leaving dead_two intact
    let fix = fix_doctor_issues(&ctx, Some(&["claude:dead_mcp:dead_one".to_string()])).unwrap();
    assert_eq!(fix.fixed_count, 1);
    let after_partial = fs::read_to_string(&claude_cfg).unwrap();
    assert!(!after_partial.contains("dead_one"));
    assert!(after_partial.contains("dead_two"));

    // Restore from backup and confirm dead_one returns
    let backups = list_backups(&ctx);
    assert_eq!(backups.len(), 1);
    let restore_rep = restore_backup(&ctx, &backups[0].id).unwrap();
    assert!(restore_rep.restored);
    assert!(fs::read_to_string(&claude_cfg)
        .unwrap()
        .contains("dead_one"));
}

#[test]
fn test_cross_platform_paths_and_mountpoints() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // Windows AppData Cursor cache & Linux XDG Zed cache
    let win_cursor_cache = home.join("AppData/Roaming/Cursor/Cache");
    fs::create_dir_all(&win_cursor_cache).unwrap();
    fs::write(win_cursor_cache.join("data_0"), "win-cache").unwrap();

    let linux_zed_cache = home.join(".cache/Zed");
    fs::create_dir_all(&linux_zed_cache).unwrap();
    fs::write(linux_zed_cache.join("shader.bin"), "linux-cache").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(&ctx, &ScanOptions::default());
    assert!(results
        .iter()
        .any(|r| r.agent == "cursor" && !r.items.is_empty()));
    assert!(results
        .iter()
        .any(|r| r.agent == "zed" && !r.items.is_empty()));

    assert_eq!(
        extract_external_mountpoint(Path::new("/run/media/alice/SSD/proj"))
            .unwrap()
            .to_string_lossy(),
        "/run/media/alice/SSD"
    );
    assert_eq!(
        extract_external_mountpoint(Path::new("E:\\Projects\\app"))
            .unwrap()
            .to_string_lossy(),
        "E:\\"
    );
}

#[test]
fn test_windows_appdata_mcp_and_agent_discovery() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // Windows AppData/Roaming dynamic MCP configs: Claude Desktop, Cursor User/mcp.json, and Cline extension
    let claude_desktop = home.join("AppData/Roaming/Claude/claude_desktop_config.json");
    fs::create_dir_all(claude_desktop.parent().unwrap()).unwrap();
    fs::write(
        &claude_desktop,
        r#"{"mcpServers":{"dead_win_claude":{"command":"nonexistent_win_cmd_1"}}}"#,
    )
    .unwrap();

    let cursor_user_mcp = home.join("AppData/Roaming/Cursor/User/mcp.json");
    fs::create_dir_all(cursor_user_mcp.parent().unwrap()).unwrap();
    fs::write(
        &cursor_user_mcp,
        r#"{"mcpServers":{"dead_win_cursor":{"command":"nonexistent_win_cmd_2"}}}"#,
    )
    .unwrap();

    let cline_mcp = home.join(
        "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    );
    fs::create_dir_all(cline_mcp.parent().unwrap()).unwrap();
    fs::write(
        &cline_mcp,
        r#"{"mcpServers":{"dead_win_cline":{"command":"nonexistent_win_cmd_3"}}}"#,
    )
    .unwrap();

    // Windows AppData/Roaming unknown agent directory
    let custom_agent_logs = home.join("AppData/Roaming/MyCustomAgent/logs");
    fs::create_dir_all(&custom_agent_logs).unwrap();
    fs::write(custom_agent_logs.join("agent.log"), "windows log").unwrap();

    let ctx = old_ctx(home);
    let mcp = audit_mcp(&ctx);
    let dead_names: Vec<&str> = mcp.dead_links.iter().map(|e| e.name.as_str()).collect();
    assert!(dead_names.contains(&"dead_win_claude"));
    assert!(dead_names.contains(&"dead_win_cursor"));
    assert!(dead_names.contains(&"dead_win_cline"));

    let results = scan_all(&ctx, &ScanOptions::default());
    let custom = results
        .iter()
        .find(|r| r.agent == "mycustomagent")
        .expect("expected unknown AppData/Roaming agent to be discovered");
    assert!(custom.items.iter().any(|i| i.path.ends_with("logs")));
}
