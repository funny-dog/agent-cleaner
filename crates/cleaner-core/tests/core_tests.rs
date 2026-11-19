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
    fs::write(profile.join("node_modules/@scope/hoisted-pkg/index.js"), "ok").unwrap();
    fs::create_dir_all(profile.join("node_modules/injected-pkg")).unwrap();
    fs::write(profile.join("node_modules/injected-pkg/index.js"), "ok").unwrap();
    fs::create_dir_all(profile.join("node_modules/truly-orphan-pkg")).unwrap();
    fs::write(profile.join("node_modules/truly-orphan-pkg/index.js"), "dead").unwrap();

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
    let desktop_code_cache = home.join("Library/Application Support/@deepseek-ai/dsh-desktop/Code Cache");
    fs::create_dir_all(&desktop_code_cache).unwrap();
    fs::write(desktop_code_cache.join("data_0"), "cached-bytecode").unwrap();

    // 3. DSH sessions + workspace.json (active, archived, missing workspace, unmounted external drive)
    let active_ws = home.join("workspaces/active-app");
    fs::create_dir_all(&active_ws).unwrap();
    let missing_ws = home.join("workspaces/deleted-app");

    let active_encoded = format!(
        "--{}--",
        active_ws
            .to_string_lossy()
            .trim_matches('/')
            .replace('/', "-")
    );
    let missing_encoded = format!(
        "--{}--",
        missing_ws
            .to_string_lossy()
            .trim_matches('/')
            .replace('/', "-")
    );

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

    let unmounted_sess_dir = home.join(".dsh/sessions/--Volumes-DefinitelyUnmountedDrive_XYZ-app--");
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
    assert!(!paths.iter().any(|p| p.contains("DefinitelyUnmountedDrive_XYZ")));

    // Doctor checks DSH profile cordis.patch.yml + package.json missing bundle and auto-heals it
    let doctors = run_all_doctors(&ctx);
    let pkg_report = doctors
        .iter()
        .find(|r| r.path.ends_with("profiles/desktop/package.json"))
        .expect("DSH profile package.json should be inspected by doctor");
    assert!(!pkg_report.healthy);
    assert_eq!(pkg_report.issues.len(), 1);
    assert!(pkg_report.issues[0].message.contains("missing-bundle-plugin"));

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
    let results = scan_all(&ctx, &ScanOptions { lang: Some(Language::En), ..Default::default() });

    let qoder = results.iter().find(|r| r.agent == "qoder").unwrap();
    assert!(qoder.items.iter().any(|i| i.path.ends_with(".qoder-cn/logs")));

    let wb = results.iter().find(|r| r.agent == "workbuddy").unwrap();
    assert!(wb.items.iter().any(|i| i.path.ends_with(".workbuddy-ai/logs")));

    let kimi = results.iter().find(|r| r.agent == "kimi").unwrap();
    assert!(kimi.items.iter().any(|i| i.path.ends_with(".kimi-code/sessions")));
    assert!(kimi.items.iter().any(|i| i.path.ends_with(".kimi-code/search-index")));

    let claude = results.iter().find(|r| r.agent == "claude").unwrap();
    assert!(claude.items.iter().any(|i| i.path.ends_with("Claude-wb-cn-3p/Code Cache")));
    assert!(claude.items.iter().any(|i| i.path.ends_with("claude-code/2.1.317") && i.category == ScanCategory::Updater));
    assert!(!claude.items.iter().any(|i| i.path.ends_with("claude-code/2.1.321")));
    assert!(!claude.items.iter().any(|i| i.path.ends_with("lima/_config")));
    let base_vm = claude.items.iter().find(|i| i.path.ends_with("lima/base")).unwrap();
    assert_eq!(base_vm.category, ScanCategory::Snapshot);
    assert_eq!(base_vm.recommendation, CleanRecommendation::Optional);
    assert!(claude.items.iter().any(|i| i.path.ends_with(".claude-cage/state/lima/claude-cage-workspace-1")));
    assert!(claude.items.iter().any(|i| i.path.ends_with(".claude.json.backup") && i.category == ScanCategory::Backup));
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
    fs::write(home.join(".gemini/antigravity/brain/conv-1/note.md"), "brain").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity/conversations")).unwrap();
    fs::write(home.join(".gemini/antigravity/conversations/c1.db"), "db").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity-cli/brain/conv-2")).unwrap();
    fs::write(home.join(".gemini/antigravity-cli/brain/conv-2/note.md"), "cli brain").unwrap();
    fs::create_dir_all(home.join(".gemini/antigravity-browser-profile/Default/Code Cache")).unwrap();
    fs::write(home.join(".gemini/antigravity-browser-profile/Default/Code Cache/js"), "js").unwrap();
    fs::create_dir_all(home.join("Library/Logs/Antigravity")).unwrap();
    fs::write(home.join("Library/Logs/Antigravity/main.log"), "ag mac log").unwrap();

    // ZCode CLI, Codex SQLite & Logs, OpenCode dotdir, DSH Library logs
    fs::create_dir_all(home.join(".zcode/cli/rollout")).unwrap();
    fs::write(home.join(".zcode/cli/rollout/r1.jsonl"), "rollout").unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(home.join(".codex/logs_2.sqlite"), "sqlite").unwrap();
    fs::create_dir_all(home.join("Library/Logs/com.openai.codex")).unwrap();
    fs::write(home.join("Library/Logs/com.openai.codex/codex.log"), "codex log").unwrap();
    fs::create_dir_all(home.join(".opencode/logs")).unwrap();
    fs::write(home.join(".opencode/logs/opencode.log"), "oc log").unwrap();
    fs::create_dir_all(home.join("Library/Logs/DeepSeek Harness")).unwrap();
    fs::write(home.join("Library/Logs/DeepSeek Harness/dsh.log"), "dsh log").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(&ctx, &ScanOptions { lang: Some(Language::En), ..Default::default() });

    let gemini = results.iter().find(|r| r.agent == "gemini").unwrap();
    assert!(gemini.items.iter().any(|i| i.path.ends_with(".gemini/antigravity/log")));
    assert!(gemini.items.iter().any(|i| i.path.ends_with(".gemini/antigravity/scratch")));
    assert!(gemini.items.iter().any(|i| i.path.ends_with(".gemini/antigravity/brain") && i.recommendation == CleanRecommendation::Optional));
    assert!(gemini.items.iter().any(|i| i.path.ends_with(".gemini/antigravity/conversations") && i.recommendation == CleanRecommendation::Optional));
    assert!(gemini.items.iter().any(|i| i.path.ends_with(".gemini/antigravity-cli/brain")));
    assert!(gemini.items.iter().any(|i| i.path.ends_with("Default/Code Cache")));
    assert!(gemini.items.iter().any(|i| i.path.ends_with("Library/Logs/Antigravity")));

    let zcode = results.iter().find(|r| r.agent == "zcode").unwrap();
    assert!(zcode.items.iter().any(|i| i.path.ends_with(".zcode/cli/rollout")));

    let codex = results.iter().find(|r| r.agent == "codex").unwrap();
    assert!(codex.items.iter().any(|i| i.path.ends_with(".codex/logs_2.sqlite")));
    assert!(codex.items.iter().any(|i| i.path.ends_with("Library/Logs/com.openai.codex")));

    let opencode = results.iter().find(|r| r.agent == "opencode").unwrap();
    assert!(opencode.items.iter().any(|i| i.path.ends_with(".opencode/logs")));

    let dsh = results.iter().find(|r| r.agent == "dsh").unwrap();
    assert!(dsh.items.iter().any(|i| i.path.ends_with("Library/Logs/DeepSeek Harness")));
}

#[test]
fn test_uv_bucketed_cold_cache_and_xdg_cache_library_logs_discovery() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();

    // 1. uv bucketed cache + .tmp* + empty .tmp*
    fs::create_dir_all(home.join(".cache/uv/archive-v0/pkg-hash-1")).unwrap();
    fs::write(home.join(".cache/uv/archive-v0/pkg-hash-1/data.whl"), "wheel bytes").unwrap();
    fs::create_dir_all(home.join(".cache/uv/.tmp14EAgl")).unwrap();
    fs::write(home.join(".cache/uv/.tmp14EAgl/part"), "partial").unwrap();
    fs::create_dir_all(home.join(".cache/uv/.tmpEmpty")).unwrap();

    // 2. Puppeteer browser cache (should be claimed by pkg-cache, not unknown discovery)
    fs::create_dir_all(home.join(".cache/puppeteer/chrome/mac_arm-156")).unwrap();
    fs::write(home.join(".cache/puppeteer/chrome/mac_arm-156/chrome"), "browser").unwrap();

    // 3. Unknown agent caches under ~/.cache and ~/Library/Logs, plus root .log file
    fs::create_dir_all(home.join(".cache/oh-my-opencode/bin")).unwrap();
    fs::write(home.join(".cache/oh-my-opencode/bin/omo"), "binary").unwrap();
    fs::create_dir_all(home.join("Library/Logs/SuperAgent")).unwrap();
    fs::write(home.join("Library/Logs/SuperAgent/app.log"), "super agent").unwrap();
    fs::create_dir_all(home.join(".myagent")).unwrap();
    fs::write(home.join(".myagent/daemon.log"), "daemon log").unwrap();

    let ctx = old_ctx(home);
    let results = scan_all(&ctx, &ScanOptions { lang: Some(Language::En), ..Default::default() });

    let pkg_cache = results.iter().find(|r| r.agent == "pkg-cache").unwrap();
    assert!(pkg_cache.items.iter().any(|i| i.path.ends_with("archive-v0/pkg-hash-1") && i.category == ScanCategory::ColdCache));
    assert!(pkg_cache.items.iter().any(|i| i.path.ends_with(".tmp14EAgl") && i.category == ScanCategory::Tmp));
    assert!(!pkg_cache.items.iter().any(|i| i.path.ends_with(".tmpEmpty")));
    assert!(pkg_cache.items.iter().any(|i| i.path.ends_with("chrome/mac_arm-156") && i.category == ScanCategory::ColdCache));

    let omo = results.iter().find(|r| r.agent == "oh-my-opencode").unwrap();
    assert_eq!(omo.items.len(), 1);
    assert_eq!(omo.items[0].category, ScanCategory::Cache);
    assert_eq!(omo.items[0].recommendation, CleanRecommendation::Optional);

    let superagent = results.iter().find(|r| r.agent == "superagent").unwrap();
    assert_eq!(superagent.items.len(), 1);
    assert_eq!(superagent.items[0].category, ScanCategory::Log);
    assert_eq!(superagent.items[0].recommendation, CleanRecommendation::Optional);

    let myagent = results.iter().find(|r| r.agent == "myagent").unwrap();
    assert!(myagent.items.iter().any(|i| i.path.ends_with("daemon.log") && i.category == ScanCategory::Log));
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
    let desktop_cfg = home.join("Library/Application Support/Claude-qoder-cn-3p/claude_desktop_config.json");
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
