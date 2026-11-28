use crate::config::{is_agent_ignored, is_path_ignored, load_config};
use crate::targets::all_targets;
use crate::targets::discovery::{
    custom_target_claimed_dirs, discover_unknown_agent_results, scan_custom_targets,
};
use crate::trash;
use crate::types::{
    CleanOptions, CleanRecommendation, CleanReport, CleanerContext, ScanItem, ScanOptions,
    ScanProgress, ScanResult,
};
use anyhow::Result;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub fn scan_all(ctx: &CleanerContext, options: &ScanOptions) -> Vec<ScanResult> {
    scan_all_with_progress(ctx, options, |_| {})
}

pub fn scan_all_with_progress<F>(
    ctx: &CleanerContext,
    options: &ScanOptions,
    on_progress: F,
) -> Vec<ScanResult>
where
    F: FnMut(ScanProgress) + Send,
{
    let cfg = load_config(ctx);
    let exempt_hours = options.exempt_hours.unwrap_or(cfg.exempt_hours);
    let lang = options.lang.unwrap_or(cfg.lang);
    let targets = all_targets();

    let mut claimed_dirs: Vec<PathBuf> = targets.iter().flat_map(|t| t.claimed_dirs(ctx)).collect();
    claimed_dirs.extend(custom_target_claimed_dirs(ctx));

    let has_explicit_filter = options.agent_filter.as_ref().is_some_and(|f| !f.is_empty());

    let filtered: Vec<_> = targets
        .into_iter()
        .filter(|t| {
            if has_explicit_filter {
                options
                    .agent_filter
                    .as_ref()
                    .is_none_or(|f| f.iter().any(|a| a == t.id()))
            } else {
                !is_agent_ignored(t.id(), &cfg.ignored_agents)
            }
        })
        .collect();

    // Include 2 extra stages (custom targets + heuristic discovery) in total count.
    let total_stages = filtered.len() + 2;
    let completed_counter = AtomicUsize::new(0);
    let progress_cb = Mutex::new(on_progress);

    let mut raw_results: Vec<ScanResult> = filtered
        .par_iter()
        .map(|target| {
            let res = target.scan(ctx, exempt_hours, lang);
            let done = completed_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if let Ok(mut cb) = progress_cb.lock() {
                cb(ScanProgress {
                    completed: done,
                    total: total_stages,
                    agent: target.id().to_string(),
                    current_bytes: res.total_bytes,
                });
            }
            res
        })
        .filter(|r| r.disk_usage_bytes > 0 || !r.items.is_empty())
        .collect();

    let custom_results =
        scan_custom_targets(ctx, exempt_hours, lang, options.agent_filter.as_deref());
    let custom_bytes: u64 = custom_results.iter().map(|r| r.total_bytes).sum();
    raw_results.extend(custom_results);
    let done_custom = completed_counter.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut cb) = progress_cb.lock() {
        cb(ScanProgress {
            completed: done_custom,
            total: total_stages,
            agent: "custom".to_string(),
            current_bytes: custom_bytes,
        });
    }

    let discovered_results = discover_unknown_agent_results(
        ctx,
        &claimed_dirs,
        exempt_hours,
        lang,
        options.agent_filter.as_deref(),
    );
    let discovered_bytes: u64 = discovered_results.iter().map(|r| r.total_bytes).sum();
    raw_results.extend(discovered_results);
    let done_disc = completed_counter.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut cb) = progress_cb.lock() {
        cb(ScanProgress {
            completed: done_disc,
            total: total_stages,
            agent: "discovery".to_string(),
            current_bytes: discovered_bytes,
        });
    }

    // Merge results with the same agent ID (e.g. custom rules augmenting an existing agent).
    let mut merged: HashMap<String, ScanResult> = HashMap::new();
    for res in raw_results {
        if !has_explicit_filter && is_agent_ignored(&res.agent, &cfg.ignored_agents) {
            continue;
        }
        merged
            .entry(res.agent.clone())
            .and_modify(|existing| {
                let seen_ids: HashSet<String> =
                    existing.items.iter().map(|i| i.id.clone()).collect();
                for item in &res.items {
                    if !seen_ids.contains(&item.id) {
                        existing.total_bytes += item.size_bytes;
                        existing.items.push(item.clone());
                    }
                }
                existing.disk_usage_bytes += res.disk_usage_bytes;
            })
            .or_insert(res);
    }

    let mut results: Vec<ScanResult> = merged.into_values().collect();
    if !cfg.ignored_paths.is_empty() {
        let protected_reason = lang
            .tr(
                "命中用户忽略白名单，默认受保护",
                "Protected by user ignore list",
            )
            .to_string();
        for res in &mut results {
            for item in &mut res.items {
                if is_path_ignored(ctx, &item.path, &cfg.ignored_paths) {
                    item.recommendation = CleanRecommendation::Exempt;
                    item.recommendation_reason = protected_reason.clone();
                }
            }
        }
    }
    results.sort_by_key(|r| std::cmp::Reverse(r.total_bytes));
    results
}

pub fn clean(ctx: &CleanerContext, options: &CleanOptions) -> Result<CleanReport> {
    let scan_opts = ScanOptions {
        exempt_hours: options.exempt_hours,
        agent_filter: options.agent_filter.clone(),
        lang: options.lang,
    };
    let results = scan_all(ctx, &scan_opts);

    let selected_set: Option<HashSet<&str>> = options
        .selected_ids
        .as_ref()
        .filter(|ids| !ids.is_empty())
        .map(|ids| ids.iter().map(|s| s.as_str()).collect());

    let mut candidates: Vec<ScanItem> = Vec::new();
    for res in results {
        for item in res.items {
            if let Some(ref set) = selected_set {
                if !set.contains(item.id.as_str()) {
                    continue;
                }
            } else {
                // Without explicit IDs, never touch Exempt items.
                if item.recommendation == CleanRecommendation::Exempt {
                    continue;
                }
                if options.only_recommended
                    && item.recommendation != CleanRecommendation::Recommended
                {
                    continue;
                }
            }
            candidates.push(item);
        }
    }

    let freed_bytes: u64 = candidates.iter().map(|i| i.size_bytes).sum();

    if options.dry_run || candidates.is_empty() {
        return Ok(CleanReport {
            batch_id: None,
            dry_run: options.dry_run,
            cleaned_count: candidates.len(),
            freed_bytes,
            items: candidates,
            errors: Vec::new(),
        });
    }

    if options.permanent {
        let mut cleaned_count = 0usize;
        let mut actual_freed_bytes = 0u64;
        let mut errors = Vec::new();
        for item in &candidates {
            match crate::fs_safe::remove_path(std::path::Path::new(&item.path)) {
                Ok(()) => {
                    cleaned_count += 1;
                    actual_freed_bytes += item.size_bytes;
                }
                Err(err) => {
                    errors.push(format!("{}: {err}", item.path));
                }
            }
        }
        return Ok(CleanReport {
            batch_id: None,
            dry_run: false,
            cleaned_count,
            freed_bytes: actual_freed_bytes,
            items: candidates,
            errors,
        });
    }

    let batch_id = trash::begin_batch(ctx)?;
    let (manifest, errors) = trash::move_to_trash(ctx, &batch_id, &candidates)?;
    let cfg = load_config(ctx);
    if cfg.auto_prune_trash {
        let _ = trash::prune_trash(
            ctx,
            cfg.trash_max_age_days,
            cfg.trash_max_size_mb,
            Some(&batch_id),
        );
    }

    Ok(CleanReport {
        batch_id: Some(batch_id),
        dry_run: false,
        cleaned_count: manifest.items.len(),
        freed_bytes: manifest.total_bytes,
        items: candidates,
        errors,
    })
}
