use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use cleaner_core::doctor::{fix_all_doctors, run_all_doctors};
use cleaner_core::get_overview;
use cleaner_core::mcp_auditor::{audit_mcp, kill_orphan_process};
use cleaner_core::mcp_server::run_stdio_server;
use cleaner_core::scanner::{clean, scan_all};
use cleaner_core::trash::{list_batches, purge_all, purge_batch, restore_batch};
use cleaner_core::types::{
    CleanOptions, CleanRecommendation, CleanerContext, IssueSeverity, Language, ScanOptions,
};
use comfy_table::{presets::UTF8_FULL_CONDENSED, Table};
use dialoguer::{Confirm, MultiSelect};
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
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Concurrently scan AI agent disk usage, orphan sessions, and caches
    Scan {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
        /// Protect files modified within N hours (e.g. 24h, 48h)
        #[arg(long, default_value = "24h")]
        older_than: String,
        /// Filter to a specific agent (claude, opencode, codex, dsh, gemini, ...)
        #[arg(long)]
        agent: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en)
        #[arg(long, default_value = "zh")]
        lang: String,
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
        /// Exempt files modified within N hours (e.g. 24h, 48h)
        #[arg(long, default_value = "24h")]
        older_than: String,
        /// Comma-separated item IDs to clean
        #[arg(long)]
        ids: Option<String>,
        /// Language for descriptions and recommendation reasons (zh | en)
        #[arg(long, default_value = "zh")]
        lang: String,
    },
    /// Diagnose agent configs for syntax errors and dead MCP links
    Doctor {
        /// Auto-fix repairable issues while preserving comments (backs up first)
        #[arg(long)]
        fix: bool,
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
        /// Protect files modified within N hours (e.g. 24h, 48h)
        #[arg(long, default_value = "24h")]
        older_than: String,
        /// Language for descriptions and recommendation reasons (zh | en)
        #[arg(long, default_value = "zh")]
        lang: String,
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
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
    /// Run stdio JSON-RPC 2.0 MCP server for AI agents
    McpServer,
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
        Commands::Scan {
            json,
            older_than,
            agent,
            lang,
        } => {
            let exempt_hours = parse_hours(&older_than)?;
            let agent_filter = agent.map(|a| vec![a]);
            let parsed_lang = parse_lang(&lang);
            let results = scan_all(
                &ctx,
                &ScanOptions {
                    exempt_hours: Some(exempt_hours),
                    agent_filter,
                    lang: Some(parsed_lang),
                },
            );
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
        }

        Commands::Clean {
            dry_run,
            json,
            yes,
            only_recommended,
            older_than,
            ids,
            lang,
        } => {
            let exempt_hours = parse_hours(&older_than)?;
            let parsed_lang = parse_lang(&lang);
            let mut selected_ids = ids.map(|s| {
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
            });

            if !yes && !json && selected_ids.is_none() && !only_recommended {
                let results = scan_all(
                    &ctx,
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
                selected_ids = Some(chosen.into_iter().map(|idx| selectable[idx].id.clone()).collect());
            }

            let report = clean(
                &ctx,
                &CleanOptions {
                    exempt_hours: Some(exempt_hours),
                    dry_run,
                    agent_filter: None,
                    selected_ids,
                    only_recommended,
                    lang: Some(parsed_lang),
                },
            )?;

            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
                return Ok(());
            }

            if dry_run {
                println!(
                    "{} Would move {} item(s), freeing {}",
                    "[DRY-RUN]".yellow().bold(),
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
                    println!("Restore anytime with: {}", format!("ac restore {batch}").yellow());
                }
            }
            for err in report.errors {
                eprintln!("{} {err}", "Error:".red());
            }
        }

        Commands::Doctor { fix, json } => {
            if fix {
                let res = fix_all_doctors(&ctx)?;
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
                let reports = run_all_doctors(&ctx);
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
        }

        Commands::Mcp { kill, pid, json } => {
            let report = audit_mcp(&ctx);
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
                "MCP entries: {} | Dead links: {} | Cross-agent duplicates: {} | Orphan PPID=1 procs: {} | Cold caches: {}",
                report.entries.len(),
                report.dead_links.len(),
                report.duplicates.len(),
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
        }

        Commands::Overview {
            older_than,
            lang,
            json,
        } => {
            let exempt_hours = parse_hours(&older_than)?;
            let parsed_lang = parse_lang(&lang);
            let overview = get_overview(
                &ctx,
                &ScanOptions {
                    exempt_hours: Some(exempt_hours),
                    agent_filter: None,
                    lang: Some(parsed_lang),
                },
            );
            let trash = list_batches(&ctx);
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
                format_bytes(overview.summary.total_disk_usage_bytes).cyan().bold(),
                format_bytes(overview.summary.total_reclaimable_bytes).yellow().bold(),
                format_bytes(overview.summary.recommended_bytes).green().bold(),
                overview.summary.orphan_mcp_count,
                overview.summary.doctor_issue_count,
                overview.summary.trash_batch_count,
            );
        }

        Commands::Restore {
            batch_id,
            purge,
            purge_all: do_purge_all,
            json,
        } => {
            if do_purge_all {
                let count = purge_all(&ctx)?;
                if json {
                    println!("{}", serde_json::json!({ "purgedBatches": count }));
                } else {
                    println!("Purged {count} trash batch(es).");
                }
                return Ok(());
            }
            if let Some(pid) = purge {
                purge_batch(&ctx, &pid)?;
                if json {
                    println!("{}", serde_json::json!({ "purged": pid }));
                } else {
                    println!("Purged batch {pid}.");
                }
                return Ok(());
            }
            if let Some(id) = batch_id {
                let res = restore_batch(&ctx, &id)?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    println!("Restored {} item(s) from batch {id}.", res.restored);
                    for fail in res.failed {
                        eprintln!("{} {fail}", "Failed:".red());
                    }
                }
            } else {
                let batches = list_batches(&ctx);
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
        }

        Commands::McpServer => {
            run_stdio_server(&ctx)?;
        }
    }

    Ok(())
}
