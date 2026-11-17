use crate::recommendation::DEFAULT_EXEMPT_HOURS;
use crate::targets::all_targets;
use crate::targets::discovery::{
    custom_target_claimed_dirs, discover_unknown_agent_results, scan_custom_targets,
};
use crate::trash;
use crate::types::{
    CleanOptions, CleanRecommendation, CleanReport, CleanerContext, ScanItem, ScanOptions,
    ScanResult,
};
use anyhow::Result;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub fn scan_all(ctx: &CleanerContext, options: &ScanOptions) -> Vec<ScanResult> {
    let exempt_hours = options.exempt_hours.unwrap_or(DEFAULT_EXEMPT_HOURS);
    let lang = options.lang.unwrap_or_default();
    let targets = all_targets();

    let mut claimed_dirs: Vec<PathBuf> = targets
        .iter()
        .flat_map(|t| t.claimed_dirs(ctx))
        .collect();
    claimed_dirs.extend(custom_target_claimed_dirs(ctx));

    let filtered: Vec<_> = targets
        .into_iter()
        .filter(|t| {
            options
                .agent_filter
                .as_ref()
                .is_none_or(|f| f.is_empty() || f.iter().any(|a| a == t.id()))
        })
        .collect();

    let mut raw_results: Vec<ScanResult> = filtered
        .par_iter()
        .map(|target| target.scan(ctx, exempt_hours, lang))
        .filter(|r| r.disk_usage_bytes > 0 || !r.items.is_empty())
        .collect();

    raw_results.extend(scan_custom_targets(
        ctx,
        exempt_hours,
        lang,
        options.agent_filter.as_deref(),
    ));
    raw_results.extend(discover_unknown_agent_results(
        ctx,
        &claimed_dirs,
        exempt_hours,
        lang,
        options.agent_filter.as_deref(),
    ));

    // Merge results with the same agent ID (e.g. custom rules augmenting an existing agent).
    let mut merged: HashMap<String, ScanResult> = HashMap::new();
    for res in raw_results {
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
    results.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
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

    let batch_id = trash::begin_batch(ctx)?;
    let (manifest, errors) = trash::move_to_trash(ctx, &batch_id, &candidates)?;

    Ok(CleanReport {
        batch_id: Some(batch_id),
        dry_run: false,
        cleaned_count: manifest.items.len(),
        freed_bytes: manifest.total_bytes,
        items: candidates,
        errors,
    })
}
