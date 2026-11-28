use std::io::IsTerminal;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use cleaner_core::config::{
    add_ignored_path, format_config_toml, load_config, remove_ignored_path, save_config,
};
use cleaner_core::doctor::{fix_doctor_issues, run_all_doctors};
use cleaner_core::get_overview;
use cleaner_core::mcp_auditor::{audit_mcp, kill_orphan_process};
use cleaner_core::mcp_server::run_stdio_server;
use cleaner_core::scanner::{clean, scan_all, scan_all_with_progress};
use cleaner_core::trash::{
    delete_backup, list_backups, list_batches, prune_backups, prune_trash, purge_all, purge_batch,
    restore_backup, restore_batch,
};
use cleaner_core::types::{
    CleanOptions, CleanRecommendation, CleanerContext, IssueSeverity, Language, ScanOptions,
};
use comfy_table::{presets::UTF8_FULL_CONDENSED, Table};
use dialoguer::{Confirm, MultiSelect, Select};
use owo_colors::OwoColorize;

#[derive(Parser)]
#[command(
    name = "ac",
    bin_name = "ac",
    version,
    about = "Agent Cleaner — Global disk cleanup, orphan MCP killer, and comment-preserving config healer"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Launch interactive terminal wizard (default when run with no subcommand)
    #[command(alias = "ui")]
    Interactive {
        /// Protect files modified within N hours (e.g. 24h, 48h; defaults to config.toml)
        #[arg(long)]
        older_than: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en; defaults to config.toml)
        #[arg(long)]
        lang: Option<String>,
    },
    /// Concurrently scan AI agent disk usage, orphan sessions, and caches
    Scan {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
        /// Emit NDJSON scan progress lines to stderr
        #[arg(long)]
        progress_json: bool,
        /// Protect files modified within N hours (e.g. 24h, 48h; defaults to config.toml)
        #[arg(long)]
        older_than: Option<String>,
        /// Filter to a specific agent (claude, opencode, codex, dsh, gemini, ...)
        #[arg(long)]
        agent: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en; defaults to config.toml)
        #[arg(long)]
        lang: Option<String>,
    },
    /// Safely move reclaimable artifacts into ~/.agent-cleaner/trash/
    Clean {
        /// Preview without moving any files
        #[arg(long)]
        dry_run: bool,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
        /// Skip interactive prompts
        #[arg(short = 'y', long)]
        yes: bool,
        /// Only clean safe recommended items
        #[arg(long)]
        only_recommended: bool,
        /// Exempt files modified within N hours (e.g. 24h, 48h; defaults to config.toml)
        #[arg(long)]
        older_than: Option<String>,
        /// Comma-separated item IDs to clean
        #[arg(long)]
        ids: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en; defaults to config.toml)
        #[arg(long)]
        lang: Option<String>,
        /// Permanently delete selected items without moving to trash
        #[arg(long)]
        permanent: bool,
    },
    /// Diagnose agent configs for syntax errors and dead MCP links
    Doctor {
        /// Auto-fix repairable issues while preserving comments (backs up first)
        #[arg(long)]
        fix: bool,
        /// Optional comma-separated issue IDs to fix selectively (used with --fix)
        #[arg(long)]
        ids: Option<String>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Audit cross-agent MCP configs, cold caches, and PPID=1 orphan processes
    Mcp {
        /// Terminate detected PPID=1 orphan stdio MCP processes
        #[arg(long)]
        kill: bool,
        /// Optional specific orphan PID to terminate (used with --kill)
        #[arg(long)]
        pid: Option<u32>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Output aggregated scan, doctor, MCP audit, and trash batches overview
    Overview {
        /// Protect files modified within N hours (e.g. 24h, 48h; defaults to config.toml)
        #[arg(long)]
        older_than: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en; defaults to config.toml)
        #[arg(long)]
        lang: Option<String>,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// List trash batches or restore/purge a batch
    Restore {
        /// Trash batch UUID to restore (omit to list all batches)
        batch_id: Option<String>,
        /// Permanently purge a specific batch ID
        #[arg(long)]
        purge: Option<String>,
        /// Permanently purge ALL trash batches
        #[arg(long)]
        purge_all: bool,
        /// Prune expired or over-quota trash batches according to config.toml
        #[arg(long)]
        prune: bool,
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Manage global settings and ignore whitelist (~/.agent-cleaner/config.toml)
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
        /// Output raw JSON (for bare `ac config`)
        #[arg(long)]
        json: bool,
    },
    /// List, restore, delete, or prune config backups (~/.agent-cleaner/backups/)
    Backups {
        #[command(subcommand)]
        action: Option<BackupsAction>,
        /// Output raw JSON (for bare `ac backups`)
        #[arg(long)]
        json: bool,
    },
    /// Run stdio JSON-RPC 2.0 MCP server for AI agents
    McpServer,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print current effective configuration
    Show {
        #[arg(long)]
        json: bool,
    },
    /// Update configuration fields
    Set {
        #[arg(long)]
        exempt_hours: Option<u64>,
        #[arg(long)]
        cold_days: Option<u64>,
        #[arg(long)]
        lang: Option<String>,
        #[arg(long)]
        trash_max_age_days: Option<u64>,
        #[arg(long)]
        trash_max_size_mb: Option<u64>,
        #[arg(long)]
        auto_prune_trash: Option<bool>,
        #[arg(long)]
        backup_max_count: Option<u32>,
        #[arg(long)]
        json: bool,
    },
    /// Manage ignored path patterns
    Ignore {
        #[command(subcommand)]
        action: IgnoreAction,
    },
    /// Manage ignored agent IDs
    IgnoreAgent {
        #[command(subcommand)]
        action: IgnoreAction,
    },
}

#[derive(Subcommand)]
enum IgnoreAction {
    List {
        #[arg(long)]
        json: bool,
    },
    Add {
        pattern: String,
        #[arg(long)]
        json: bool,
    },
    Remove {
        pattern: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum BackupsAction {
    /// List saved configuration backups
    List {
        #[arg(long)]
        json: bool,
    },
    /// Restore a saved configuration backup back to its original path
    Restore {
        backup_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a specific configuration backup
    Delete {
        backup_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Prune older configuration backups beyond keep count
    Prune {
        #[arg(long)]
        keep: Option<usize>,
        #[arg(long)]
        json: bool,
    },
}

fn parse_hours(spec: &str) -> Result<u64> {
    let trimmed = spec.trim().to_lowercase();
    if let Some(num) = trimmed.strip_suffix('h') {
        Ok(num.parse::<u64>()?)
    } else if let Some(num) = trimmed.strip_suffix('d') {
        Ok(num.parse::<u64>()? * 24)
    } else if let Ok(hours) = trimmed.parse::<u64>() {
        Ok(hours)
    } else {
        bail!("Invalid duration format: {spec} (expected e.g. 24h, 48h, 7d)")
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut val = bytes as f64;
    let mut idx = 0;
    while val >= 1024.0 && idx < UNITS.len() - 1 {
        val /= 1024.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{bytes} B")
    } else {
        format!("{val:.1} {}", UNITS[idx])
    }
}

fn parse_lang(spec: &str) -> Language {
    if spec.trim().eq_ignore_ascii_case("en") {
        Language::En
    } else {
        Language::Zh
    }
}

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    let ctx = CleanerContext::default();

    match cli.command {
        None => run_interactive(&ctx, None, None)?,
        Some(Commands::Interactive { older_than, lang }) => {
            run_interactive(&ctx, older_than.as_deref(), lang.as_deref())?;
        }
        Some(Commands::Scan {
            json,
            progress_json,
            older_than,
            agent,
            lang,
        }) => execute_scan(
            &ctx,
            json,
            progress_json,
            older_than.as_deref(),
            agent,
            lang.as_deref(),
        )?,
        Some(Commands::Clean {
            dry_run,
            json,
            yes,
            only_recommended,
            older_than,
            ids,
            lang,
            permanent,
        }) => execute_clean(
            &ctx,
            dry_run,
            json,
            yes,
            only_recommended,
            older_than.as_deref(),
            ids,
            lang.as_deref(),
            permanent,
        )?,
        Some(Commands::Doctor { fix, ids, json }) => execute_doctor(&ctx, fix, ids, json)?,
        Some(Commands::Mcp { kill, pid, json }) => execute_mcp(&ctx, kill, pid, json)?,
        Some(Commands::Overview {
            older_than,
            lang,
            json,
        }) => execute_overview(&ctx, older_than.as_deref(), lang.as_deref(), json)?,
        Some(Commands::Restore {
            batch_id,
            purge,
            purge_all: do_purge_all,
            prune,
            json,
        }) => execute_restore(&ctx, batch_id, purge, do_purge_all, prune, json)?,
        Some(Commands::Config { action, json }) => execute_config(&ctx, action, json)?,
        Some(Commands::Backups { action, json }) => execute_backups(&ctx, action, json)?,
        Some(Commands::McpServer) => run_stdio_server(&ctx)?,
    }

    Ok(())
}

fn resolve_exempt_hours(ctx: &CleanerContext, older_than: Option<&str>) -> Result<u64> {
    match older_than {
        Some(spec) => parse_hours(spec),
        None => Ok(load_config(ctx).exempt_hours),
    }
}

fn resolve_lang(ctx: &CleanerContext, lang: Option<&str>) -> Language {
    match lang {
        Some(spec) => parse_lang(spec),
        None => load_config(ctx).lang,
    }
}

fn execute_scan(
    ctx: &CleanerContext,
    json: bool,
    progress_json: bool,
    older_than: Option<&str>,
    agent: Option<String>,
    lang: Option<&str>,
) -> Result<()> {
    let exempt_hours = resolve_exempt_hours(ctx, older_than)?;
    let agent_filter = agent.map(|a| vec![a]);
    let parsed_lang = resolve_lang(ctx, lang);
    let show_tty_progress = !json && !progress_json && std::io::stderr().is_terminal();
    let opts = ScanOptions {
        exempt_hours: Some(exempt_hours),
        agent_filter,
        lang: Some(parsed_lang),
    };
    let results = scan_all_with_progress(ctx, &opts, |prog| {
        if progress_json {
            if let Ok(line) = serde_json::to_string(&prog) {
                eprintln!("{line}");
            }
        } else if show_tty_progress {
            use std::io::Write;
            eprint!(
                "\rScanning [{}/{}] {}...          ",
                prog.completed, prog.total, prog.agent
            );
            let _ = std::io::stderr().flush();
        }
    });
    if show_tty_progress {
        use std::io::Write;
        eprint!("\r                                                  \r");
        let _ = std::io::stderr().flush();
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&results)?);
        return Ok(());
    }

    if results.is_empty() {
        println!("{}", "No AI agent artifacts found.".green());
        return Ok(());
    }

    let mut table = Table::new();
    table.load_preset(UTF8_FULL_CONDENSED);
    table.set_header(vec!["Agent", "Reclaimable", "Total Disk", "Items"]);

    let mut total_reclaim = 0u64;
    for r in &results {
        total_reclaim += r.total_bytes;
        table.add_row(vec![
            r.agent.clone(),
            format_bytes(r.total_bytes),
            format_bytes(r.disk_usage_bytes),
            r.items.len().to_string(),
        ]);
    }
    println!("{table}");
    println!(
        "\nTotal reclaimable: {} (exempt window: {}h)",
        format_bytes(total_reclaim).cyan().bold(),
        exempt_hours
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_clean(
    ctx: &CleanerContext,
    dry_run: bool,
    json: bool,
    yes: bool,
    only_recommended: bool,
    older_than: Option<&str>,
    ids: Option<String>,
    lang: Option<&str>,
    permanent: bool,
) -> Result<()> {
    let exempt_hours = resolve_exempt_hours(ctx, older_than)?;
    let parsed_lang = resolve_lang(ctx, lang);
    let mut selected_ids = ids.map(|s| {
        s.split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
    });

    if !yes && !json && selected_ids.is_none() && !only_recommended {
        let results = scan_all(
            ctx,
            &ScanOptions {
                exempt_hours: Some(exempt_hours),
                agent_filter: None,
                lang: Some(parsed_lang),
            },
        );
        let selectable: Vec<_> = results
            .into_iter()
            .flat_map(|r| r.items)
            .filter(|i| i.recommendation != CleanRecommendation::Exempt)
            .collect();

        if selectable.is_empty() {
            println!("{}", "Nothing eligible to clean right now.".green());
            return Ok(());
        }

        let labels: Vec<String> = selectable
            .iter()
            .map(|i| {
                format!(
                    "[{}] {} ({}) - {}",
                    i.agent,
                    i.description,
                    format_bytes(i.size_bytes),
                    i.path
                )
            })
            .collect();
        let defaults: Vec<bool> = selectable
            .iter()
            .map(|i| i.recommendation == CleanRecommendation::Recommended)
            .collect();

        let chosen = MultiSelect::new()
            .with_prompt("Select items to move to reversible trash")
            .items(&labels)
            .defaults(&defaults)
            .interact()?;

        if chosen.is_empty() {
            println!("Cancelled.");
            return Ok(());
        }
        selected_ids = Some(
            chosen
                .into_iter()
                .map(|idx| selectable[idx].id.clone())
                .collect(),
        );
    }

    let report = clean(
        ctx,
        &CleanOptions {
            exempt_hours: Some(exempt_hours),
            dry_run,
            agent_filter: None,
            selected_ids,
            only_recommended,
            lang: Some(parsed_lang),
            permanent,
        },
    )?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    if dry_run {
        println!(
            "{} Would {} {} item(s), freeing {}",
            "[DRY-RUN]".yellow().bold(),
            if permanent {
                "permanently delete"
            } else {
                "move"
            },
            report.cleaned_count,
            format_bytes(report.freed_bytes).cyan()
        );
    } else if permanent {
        println!(
            "{} Permanently deleted {} item(s), freed {}",
            "[DELETED]".red().bold(),
            report.cleaned_count,
            format_bytes(report.freed_bytes).cyan()
        );
    } else {
        println!(
            "{} Moved {} item(s), freed {}",
            "[CLEANED]".green().bold(),
            report.cleaned_count,
            format_bytes(report.freed_bytes).cyan()
        );
        if let Some(batch) = report.batch_id {
            println!(
                "Restore anytime with: {}",
                format!("ac restore {batch}").yellow()
            );
        }
    }
    for err in report.errors {
        eprintln!("{} {err}", "Error:".red());
    }
    Ok(())
}

fn execute_doctor(ctx: &CleanerContext, fix: bool, ids: Option<String>, json: bool) -> Result<()> {
    if fix {
        let issue_ids: Option<Vec<String>> = ids.map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        });
        let res = fix_doctor_issues(ctx, issue_ids.as_deref())?;
        if json {
            println!("{}", serde_json::to_string_pretty(&res)?);
            return Ok(());
        }
        println!(
            "{} Fixed {} issue(s). Backups saved: {}",
            "[DOCTOR]".green().bold(),
            res.fixed_count,
            res.backup_paths.len()
        );
    } else {
        let reports = run_all_doctors(ctx);
        if json {
            println!("{}", serde_json::to_string_pretty(&reports)?);
            return Ok(());
        }
        for r in reports {
            if r.healthy {
                println!("{} {} ({})", "✓".green(), r.agent, r.path);
            } else {
                println!("{} {} ({})", "✗".red(), r.agent, r.path);
                for issue in r.issues {
                    let tag = match issue.severity {
                        IssueSeverity::Error => "ERR".red().to_string(),
                        IssueSeverity::Warning => "WARN".yellow().to_string(),
                        IssueSeverity::Info => "INFO".blue().to_string(),
                    };
                    println!("  [{tag}] {}", issue.message);
                }
            }
        }
    }
    Ok(())
}

fn execute_mcp(ctx: &CleanerContext, kill: bool, pid: Option<u32>, json: bool) -> Result<()> {
    let report = audit_mcp(ctx);
    let mut kill_results = Vec::new();
    if kill && !report.orphan_processes.is_empty() {
        let targets: Vec<_> = match pid {
            Some(target_pid) => report
                .orphan_processes
                .iter()
                .filter(|p| p.pid == target_pid)
                .collect(),
            None => report.orphan_processes.iter().collect(),
        };
        if !targets.is_empty() {
            let proceed = json
                || Confirm::new()
                    .with_prompt(format!(
                        "Terminate {} orphan PPID=1 MCP process(es)?",
                        targets.len()
                    ))
                    .default(true)
                    .interact()?;
            if proceed {
                for p in targets {
                    kill_results.push(kill_orphan_process(p.pid));
                }
            }
        }
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "audit": report,
                "killResults": kill_results
            }))?
        );
        return Ok(());
    }
    println!(
        "MCP entries: {} | Dead links: {} | Duplicates: {} | Conflicts: {} | Orphan PPID=1 procs: {} | Cold caches: {}",
        report.entries.len(),
        report.dead_links.len(),
        report.duplicates.len(),
        report.conflicts.len(),
        report.orphan_processes.len(),
        report.cold_caches.len()
    );
    for p in &report.orphan_processes {
        println!(
            "  Orphan PID {} ({} KB): {}",
            p.pid.to_string().yellow(),
            p.rss_kb,
            p.command
        );
    }
    for k in &kill_results {
        println!("  Killed PID {} via {} (ok={})", k.pid, k.method, k.success);
    }
    Ok(())
}

fn execute_overview(
    ctx: &CleanerContext,
    older_than: Option<&str>,
    lang: Option<&str>,
    json: bool,
) -> Result<()> {
    let exempt_hours = resolve_exempt_hours(ctx, older_than)?;
    let parsed_lang = resolve_lang(ctx, lang);
    let overview = get_overview(
        ctx,
        &ScanOptions {
            exempt_hours: Some(exempt_hours),
            agent_filter: None,
            lang: Some(parsed_lang),
        },
    );
    let trash = list_batches(ctx);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "summary": overview.summary,
                "agents": overview.agents,
                "doctors": overview.doctors,
                "mcp": overview.mcp,
                "trash": trash,
            }))?
        );
        return Ok(());
    }

    println!(
        "Total disk: {} | Reclaimable: {} | Recommended: {} | Orphan MCPs: {} | Doctor issues: {} | Trash batches: {}",
        format_bytes(overview.summary.total_disk_usage_bytes)
            .cyan()
            .bold(),
        format_bytes(overview.summary.total_reclaimable_bytes)
            .yellow()
            .bold(),
        format_bytes(overview.summary.recommended_bytes)
            .green()
            .bold(),
        overview.summary.orphan_mcp_count,
        overview.summary.doctor_issue_count,
        overview.summary.trash_batch_count,
    );
    Ok(())
}

fn execute_restore(
    ctx: &CleanerContext,
    batch_id: Option<String>,
    purge: Option<String>,
    do_purge_all: bool,
    prune: bool,
    json: bool,
) -> Result<()> {
    if prune {
        let cfg = load_config(ctx);
        let report = prune_trash(ctx, cfg.trash_max_age_days, cfg.trash_max_size_mb, None)?;
        if json {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            println!(
                "Pruned {} expired/over-quota trash batch(es), freed {}.",
                report.pruned_batches,
                format_bytes(report.freed_bytes)
            );
        }
        return Ok(());
    }
    if do_purge_all {
        let count = purge_all(ctx)?;
        if json {
            println!("{}", serde_json::json!({ "purgedBatches": count }));
        } else {
            println!("Purged {count} trash batch(es).");
        }
        return Ok(());
    }
    if let Some(pid) = purge {
        purge_batch(ctx, &pid)?;
        if json {
            println!("{}", serde_json::json!({ "purged": pid }));
        } else {
            println!("Purged batch {pid}.");
        }
        return Ok(());
    }
    if let Some(id) = batch_id {
        let res = restore_batch(ctx, &id)?;
        if json {
            println!("{}", serde_json::to_string_pretty(&res)?);
        } else {
            println!("Restored {} item(s) from batch {id}.", res.restored);
            for fail in res.failed {
                eprintln!("{} {fail}", "Failed:".red());
            }
        }
    } else {
        let batches = list_batches(ctx);
        if json {
            println!("{}", serde_json::to_string_pretty(&batches)?);
            return Ok(());
        }
        if batches.is_empty() {
            println!("Trash is empty.");
            return Ok(());
        }
        let mut table = Table::new();
        table.load_preset(UTF8_FULL_CONDENSED);
        table.set_header(vec!["Batch ID", "Items", "Total Size"]);
        for b in batches {
            table.add_row(vec![
                b.batch_id,
                b.items.len().to_string(),
                format_bytes(b.total_bytes),
            ]);
        }
        println!("{table}");
    }
    Ok(())
}

fn execute_config(
    ctx: &CleanerContext,
    action: Option<ConfigAction>,
    root_json: bool,
) -> Result<()> {
    match action {
        None => {
            let cfg = load_config(ctx);
            if root_json {
                println!("{}", serde_json::to_string_pretty(&cfg)?);
            } else {
                println!("{}", format_config_toml(&cfg)?);
            }
        }
        Some(ConfigAction::Show { json }) => {
            let cfg = load_config(ctx);
            if json || root_json {
                println!("{}", serde_json::to_string_pretty(&cfg)?);
            } else {
                println!("{}", format_config_toml(&cfg)?);
            }
        }
        Some(ConfigAction::Set {
            exempt_hours,
            cold_days,
            lang,
            trash_max_age_days,
            trash_max_size_mb,
            auto_prune_trash,
            backup_max_count,
            json,
        }) => {
            let mut cfg = load_config(ctx);
            if let Some(h) = exempt_hours {
                cfg.exempt_hours = h;
            }
            if let Some(d) = cold_days {
                cfg.cold_threshold_days = d;
            }
            if let Some(l) = lang {
                cfg.lang = parse_lang(&l);
            }
            if let Some(days) = trash_max_age_days {
                cfg.trash_max_age_days = days;
            }
            if let Some(mb) = trash_max_size_mb {
                cfg.trash_max_size_mb = mb;
            }
            if let Some(auto) = auto_prune_trash {
                cfg.auto_prune_trash = auto;
            }
            if let Some(cnt) = backup_max_count {
                cfg.backup_max_count = cnt;
            }
            save_config(ctx, &cfg)?;
            if json || root_json {
                println!("{}", serde_json::to_string_pretty(&cfg)?);
            } else {
                println!(
                    "Saved config to {}",
                    cleaner_core::config::config_path(ctx).display()
                );
            }
        }
        Some(ConfigAction::Ignore { action }) => match action {
            IgnoreAction::List { json } => {
                let cfg = load_config(ctx);
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg.ignored_paths)?);
                } else if cfg.ignored_paths.is_empty() {
                    println!("No ignored paths configured.");
                } else {
                    for p in &cfg.ignored_paths {
                        println!("{p}");
                    }
                }
            }
            IgnoreAction::Add { pattern, json } => {
                let cfg = add_ignored_path(ctx, &pattern)?;
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg)?);
                } else {
                    println!("Added ignored path: {pattern}");
                }
            }
            IgnoreAction::Remove { pattern, json } => {
                let cfg = remove_ignored_path(ctx, &pattern)?;
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg)?);
                } else {
                    println!("Removed ignored path: {pattern}");
                }
            }
        },
        Some(ConfigAction::IgnoreAgent { action }) => match action {
            IgnoreAction::List { json } => {
                let cfg = load_config(ctx);
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg.ignored_agents)?);
                } else if cfg.ignored_agents.is_empty() {
                    println!("No ignored agents configured.");
                } else {
                    for a in &cfg.ignored_agents {
                        println!("{a}");
                    }
                }
            }
            IgnoreAction::Add { pattern, json } => {
                let mut cfg = load_config(ctx);
                let norm = pattern.trim().to_ascii_lowercase();
                if !norm.is_empty() && !cfg.ignored_agents.contains(&norm) {
                    cfg.ignored_agents.push(norm.clone());
                }
                save_config(ctx, &cfg)?;
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg)?);
                } else {
                    println!("Added ignored agent: {norm}");
                }
            }
            IgnoreAction::Remove { pattern, json } => {
                let mut cfg = load_config(ctx);
                let norm = pattern.trim().to_ascii_lowercase();
                cfg.ignored_agents.retain(|a| a != &norm);
                save_config(ctx, &cfg)?;
                if json || root_json {
                    println!("{}", serde_json::to_string_pretty(&cfg)?);
                } else {
                    println!("Removed ignored agent: {norm}");
                }
            }
        },
    }
    Ok(())
}

fn execute_backups(
    ctx: &CleanerContext,
    action: Option<BackupsAction>,
    root_json: bool,
) -> Result<()> {
    match action {
        None | Some(BackupsAction::List { json: false }) if !root_json => {
            let backups = list_backups(ctx);
            if backups.is_empty() {
                println!("No config backups found.");
                return Ok(());
            }
            let mut table = Table::new();
            table.load_preset(UTF8_FULL_CONDENSED);
            table.set_header(vec!["Backup ID", "Original Path", "Size"]);
            for b in backups {
                table.add_row(vec![b.id, b.original_path, format_bytes(b.size_bytes)]);
            }
            println!("{table}");
        }
        None => {
            let backups = list_backups(ctx);
            println!("{}", serde_json::to_string_pretty(&backups)?);
        }
        Some(BackupsAction::List { json }) => {
            let backups = list_backups(ctx);
            if json || root_json {
                println!("{}", serde_json::to_string_pretty(&backups)?);
            }
        }
        Some(BackupsAction::Restore { backup_id, json }) => {
            let report = restore_backup(ctx, &backup_id)?;
            if json || root_json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("Restored backup {} -> {}", report.id, report.original_path);
            }
        }
        Some(BackupsAction::Delete { backup_id, json }) => {
            delete_backup(ctx, &backup_id)?;
            if json || root_json {
                println!("{}", serde_json::json!({ "deleted": backup_id }));
            } else {
                println!("Deleted backup {backup_id}.");
            }
        }
        Some(BackupsAction::Prune { keep, json }) => {
            let keep_count = keep.unwrap_or_else(|| load_config(ctx).backup_max_count as usize);
            let report = prune_backups(ctx, keep_count)?;
            if json || root_json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "Pruned {} backup(s), freed {}.",
                    report.pruned_count,
                    format_bytes(report.freed_bytes)
                );
            }
        }
    }
    Ok(())
}

fn run_interactive(
    ctx: &CleanerContext,
    older_than: Option<&str>,
    lang: Option<&str>,
) -> Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return execute_overview(ctx, older_than, lang, false);
    }

    let exempt_hours = resolve_exempt_hours(ctx, older_than)?;
    let parsed_lang = resolve_lang(ctx, lang);

    loop {
        let overview = get_overview(
            ctx,
            &ScanOptions {
                exempt_hours: Some(exempt_hours),
                agent_filter: None,
                lang: Some(parsed_lang),
            },
        );

        println!();
        println!(
            "{} {}",
            "Agent Cleaner".cyan().bold(),
            format!("v{}", env!("CARGO_PKG_VERSION")).dimmed()
        );
        println!(
            "{}: {} | {}: {} | {}: {} | {}: {} | {}: {} | {}: {} ({}: {}h)",
            parsed_lang.tr("总占用", "Total disk"),
            format_bytes(overview.summary.total_disk_usage_bytes)
                .cyan()
                .bold(),
            parsed_lang.tr("可释放", "Reclaimable"),
            format_bytes(overview.summary.total_reclaimable_bytes)
                .yellow()
                .bold(),
            parsed_lang.tr("安全推荐", "Recommended"),
            format_bytes(overview.summary.recommended_bytes)
                .green()
                .bold(),
            parsed_lang.tr("孤儿 MCP", "Orphan MCPs"),
            overview.summary.orphan_mcp_count,
            parsed_lang.tr("配置问题", "Doctor issues"),
            overview.summary.doctor_issue_count,
            parsed_lang.tr("回收站批次", "Trash batches"),
            overview.summary.trash_batch_count,
            parsed_lang.tr("豁免窗口", "Exempt window"),
            exempt_hours
        );
        println!();

        let menu_items = [
            "🚀 一键清理安全推荐项 (Clean Recommended)",
            "🧹 交互式勾选清理项 (Interactive Clean)",
            "🔍 查看各工具磁盘占用明细 (Scan Details)",
            "🩺 诊断与修复配置文件 (Config Doctor)",
            "🔌 审计与查杀孤儿 MCP 进程 (MCP Audit & Kill)",
            "♻️  回收站管理与恢复 (Trash & Restore)",
            "🚪 退出 (Exit)",
        ];

        let selection = Select::new()
            .with_prompt("请选择操作 (Select an action)")
            .items(&menu_items)
            .default(0)
            .interact()?;

        println!();

        match selection {
            0 => {
                execute_clean(ctx, false, false, true, true, older_than, None, lang, false)?;
            }
            1 => {
                execute_clean(
                    ctx, false, false, false, false, older_than, None, lang, false,
                )?;
            }
            2 => {
                execute_scan(ctx, false, false, older_than, None, lang)?;
            }
            3 => {
                execute_doctor(ctx, false, None, false)?;
                let has_fixable = run_all_doctors(ctx)
                    .iter()
                    .flat_map(|r| &r.issues)
                    .any(|i| i.auto_fixable);
                if has_fixable
                    && Confirm::new()
                        .with_prompt(
                            "检测到可自动修复的配置问题，是否立即修复？（保留注释并自动备份）",
                        )
                        .default(true)
                        .interact()?
                {
                    execute_doctor(ctx, true, None, false)?;
                }
            }
            4 => {
                execute_mcp(ctx, true, None, false)?;
            }
            5 => {
                execute_restore(ctx, None, None, false, false, false)?;
                let batches = list_batches(ctx);
                if !batches.is_empty() {
                    let trash_actions = [
                        "↩️  还原指定批次 (Restore a batch)",
                        "🗑️  彻底删除指定批次 (Purge a batch)",
                        "🔥 清空全部回收站 (Purge ALL batches)",
                        "⬅️  返回主菜单 (Back)",
                    ];
                    let action = Select::new()
                        .with_prompt("回收站操作 (Trash action)")
                        .items(&trash_actions)
                        .default(0)
                        .interact()?;
                    match action {
                        0 => {
                            let mut labels: Vec<String> = batches
                                .iter()
                                .map(|b| {
                                    format!(
                                        "{} ({} items, {})",
                                        b.batch_id,
                                        b.items.len(),
                                        format_bytes(b.total_bytes)
                                    )
                                })
                                .collect();
                            labels.push("⬅️  取消 (Cancel)".to_string());
                            let picked = Select::new()
                                .with_prompt("选择要还原的批次 (Select batch to restore)")
                                .items(&labels)
                                .default(0)
                                .interact()?;
                            if picked < batches.len() {
                                execute_restore(
                                    ctx,
                                    Some(batches[picked].batch_id.clone()),
                                    None,
                                    false,
                                    false,
                                    false,
                                )?;
                            }
                        }
                        1 => {
                            let mut labels: Vec<String> = batches
                                .iter()
                                .map(|b| {
                                    format!(
                                        "{} ({} items, {})",
                                        b.batch_id,
                                        b.items.len(),
                                        format_bytes(b.total_bytes)
                                    )
                                })
                                .collect();
                            labels.push("⬅️  取消 (Cancel)".to_string());
                            let picked = Select::new()
                                .with_prompt(
                                    "选择要彻底删除的批次 (Select batch to purge permanently)",
                                )
                                .items(&labels)
                                .default(labels.len() - 1)
                                .interact()?;
                            if picked < batches.len()
                                && Confirm::new()
                                    .with_prompt(format!(
                                        "确认永久删除批次 {}？该操作不可恢复！",
                                        batches[picked].batch_id
                                    ))
                                    .default(false)
                                    .interact()?
                            {
                                execute_restore(
                                    ctx,
                                    None,
                                    Some(batches[picked].batch_id.clone()),
                                    false,
                                    false,
                                    false,
                                )?;
                            }
                        }
                        2 if Confirm::new()
                            .with_prompt("确认清空全部回收站？所有备份将永久删除，不可恢复！")
                            .default(false)
                            .interact()? =>
                        {
                            execute_restore(ctx, None, None, true, false, false)?;
                        }
                        _ => {}
                    }
                }
            }
            _ => break,
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_no_args_as_interactive_default() {
        let cli = Cli::try_parse_from(["ac"]).expect("bare `ac` should parse");
        assert!(cli.command.is_none());
    }

    #[test]
    fn parses_interactive_subcommand_and_alias() {
        let cli = Cli::try_parse_from(["ac", "interactive", "--older-than", "48h", "--lang", "en"])
            .expect("`ac interactive` should parse");
        match cli.command {
            Some(Commands::Interactive { older_than, lang }) => {
                assert_eq!(older_than.as_deref(), Some("48h"));
                assert_eq!(lang.as_deref(), Some("en"));
            }
            _ => panic!("expected Interactive command"),
        }

        let alias_cli = Cli::try_parse_from(["ac", "ui"]).expect("`ac ui` should parse");
        assert!(matches!(
            alias_cli.command,
            Some(Commands::Interactive { .. })
        ));
    }

    #[test]
    fn parses_existing_subcommands_compatibly() {
        assert!(matches!(
            Cli::try_parse_from(["ac", "scan", "--json"])
                .unwrap()
                .command,
            Some(Commands::Scan { json: true, .. })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "clean", "--only-recommended", "--yes"])
                .unwrap()
                .command,
            Some(Commands::Clean {
                only_recommended: true,
                yes: true,
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "doctor", "--fix"])
                .unwrap()
                .command,
            Some(Commands::Doctor { fix: true, .. })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "mcp", "--kill", "--pid", "42"])
                .unwrap()
                .command,
            Some(Commands::Mcp {
                kill: true,
                pid: Some(42),
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "overview", "--json"])
                .unwrap()
                .command,
            Some(Commands::Overview { json: true, .. })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "restore", "batch-1"])
                .unwrap()
                .command,
            Some(Commands::Restore {
                batch_id: Some(_),
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "mcp-server"]).unwrap().command,
            Some(Commands::McpServer)
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "restore", "--prune", "--json"])
                .unwrap()
                .command,
            Some(Commands::Restore {
                prune: true,
                json: true,
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "config", "ignore", "add", "~/.claude/projects/vip"])
                .unwrap()
                .command,
            Some(Commands::Config {
                action: Some(ConfigAction::Ignore {
                    action: IgnoreAction::Add { .. }
                }),
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "backups", "prune", "--keep", "10"])
                .unwrap()
                .command,
            Some(Commands::Backups {
                action: Some(BackupsAction::Prune { keep: Some(10), .. }),
                ..
            })
        ));
    }

    #[test]
    fn parse_hours_handles_supported_units() {
        assert_eq!(parse_hours("24h").unwrap(), 24);
        assert_eq!(parse_hours("7d").unwrap(), 168);
        assert_eq!(parse_hours("12").unwrap(), 12);
        assert!(parse_hours("bad").is_err());
        assert!(matches!(
            Cli::try_parse_from(["ac", "doctor", "--fix", "--ids", "claude:dead_mcp:foo"])
                .unwrap()
                .command,
            Some(Commands::Doctor {
                fix: true,
                ids: Some(_),
                ..
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["ac", "scan", "--json", "--progress-json"])
                .unwrap()
                .command,
            Some(Commands::Scan {
                json: true,
                progress_json: true,
                ..
            })
        ));
    }
}
