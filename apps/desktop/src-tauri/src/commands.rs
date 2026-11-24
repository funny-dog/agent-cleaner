use cleaner_core::doctor::{fix_all_doctors, run_all_doctors};
use cleaner_core::get_overview as core_overview;
use cleaner_core::mcp_auditor::{audit_mcp as core_audit_mcp, kill_orphan_process};
use cleaner_core::recommendation::DEFAULT_EXEMPT_HOURS;
use cleaner_core::scanner::{clean as core_clean, scan_all as core_scan_all};
use cleaner_core::trash::{list_batches, purge_all, purge_batch, restore_batch};
use cleaner_core::types::{
    CleanOptions, CleanRecommendation, CleanReport, CleanerContext, DoctorFixReport, DoctorReport,
    KillProcessResult, McpAuditReport, OverviewReport, RestoreReport, ScanOptions, ScanResult,
    TrashManifest,
};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::AppHandle;

use crate::tray::{open_dashboard_window, update_tray_summary};

#[derive(Default)]
pub struct OverviewCache(pub Mutex<Option<(u64, OverviewReport)>>);

fn ctx() -> CleanerContext {
    CleanerContext::default()
}

fn recompute_summary(report: &mut OverviewReport) {
    report.summary.total_disk_usage_bytes =
        report.agents.iter().map(|a| a.disk_usage_bytes).sum();
    report.summary.total_reclaimable_bytes = report.agents.iter().map(|a| a.total_bytes).sum();
    report.summary.recommended_bytes = report
        .agents
        .iter()
        .flat_map(|a| &a.items)
        .filter(|i| i.recommendation == CleanRecommendation::Recommended)
        .map(|i| i.size_bytes)
        .sum();
    report.summary.orphan_mcp_count = report.mcp.orphan_processes.len();
    report.summary.doctor_issue_count = report.doctors.iter().map(|d| d.issues.len()).sum();
}

fn apply_clean_to_overview(report: &mut OverviewReport, clean_report: &CleanReport) {
    let failed_prefixes: Vec<String> = clean_report
        .errors
        .iter()
        .filter_map(|e| e.split(':').next().map(|p| p.trim().to_string()))
        .collect();
    let succeeded_ids: HashSet<&str> = clean_report
        .items
        .iter()
        .filter(|item| !failed_prefixes.iter().any(|fp| fp == &item.path))
        .map(|item| item.id.as_str())
        .collect();

    if !succeeded_ids.is_empty() {
        for agent in &mut report.agents {
            let mut removed_bytes = 0u64;
            agent.items.retain(|item| {
                if succeeded_ids.contains(item.id.as_str()) {
                    removed_bytes = removed_bytes.saturating_add(item.size_bytes);
                    false
                } else {
                    true
                }
            });
            agent.total_bytes = agent.total_bytes.saturating_sub(removed_bytes);
            agent.disk_usage_bytes = agent.disk_usage_bytes.saturating_sub(removed_bytes);
        }
        recompute_summary(report);
    }

    if clean_report.batch_id.is_some() {
        report.summary.trash_batch_count += 1;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_overview(
    app: AppHandle,
    cache: tauri::State<'_, OverviewCache>,
    options: Option<ScanOptions>,
    force: Option<bool>,
) -> Result<OverviewReport, String> {
    let opts = options.unwrap_or_default();
    let cache_hours = opts.exempt_hours.unwrap_or(DEFAULT_EXEMPT_HOURS);
    let force_refresh = force.unwrap_or(false);
    if !force_refresh {
        if let Ok(guard) = cache.0.lock() {
            if let Some((cached_hours, cached_report)) = guard.as_ref() {
                if *cached_hours == cache_hours {
                    update_tray_summary(
                        &app,
                        cached_report.summary.total_reclaimable_bytes,
                        cached_report.summary.orphan_mcp_count,
                    );
                    return Ok(cached_report.clone());
                }
            }
        }
    }

    let report = tokio::task::spawn_blocking(move || core_overview(&ctx(), &opts))
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache.0.lock() {
        *guard = Some((cache_hours, report.clone()));
    }
    update_tray_summary(
        &app,
        report.summary.total_reclaimable_bytes,
        report.summary.orphan_mcp_count,
    );
    Ok(report)
}

#[tauri::command]
#[specta::specta]
pub async fn scan(options: Option<ScanOptions>) -> Result<Vec<ScanResult>, String> {
    let opts = options.unwrap_or_default();
    tokio::task::spawn_blocking(move || core_scan_all(&ctx(), &opts))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn clean(
    app: AppHandle,
    cache: tauri::State<'_, OverviewCache>,
    options: CleanOptions,
) -> Result<CleanReport, String> {
    let report = tokio::task::spawn_blocking(move || core_clean(&ctx(), &options))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    if !report.dry_run {
        if let Ok(mut guard) = cache.0.lock() {
            if let Some((_, ov)) = guard.as_mut() {
                apply_clean_to_overview(ov, &report);
                update_tray_summary(
                    &app,
                    ov.summary.total_reclaimable_bytes,
                    ov.summary.orphan_mcp_count,
                );
            }
        }
    }

    Ok(report)
}

#[tauri::command]
#[specta::specta]
pub async fn list_trash() -> Result<Vec<TrashManifest>, String> {
    tokio::task::spawn_blocking(move || list_batches(&ctx()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn restore_trash_batch(
    cache: tauri::State<'_, OverviewCache>,
    batch_id: String,
) -> Result<RestoreReport, String> {
    let res = tokio::task::spawn_blocking(move || restore_batch(&ctx(), &batch_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if res.restored > 0 {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = None;
        }
    }
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn purge_trash_batch(
    cache: tauri::State<'_, OverviewCache>,
    batch_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || purge_batch(&ctx(), &batch_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache.0.lock() {
        if let Some((_, ov)) = guard.as_mut() {
            ov.summary.trash_batch_count = ov.summary.trash_batch_count.saturating_sub(1);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn purge_all_trash(cache: tauri::State<'_, OverviewCache>) -> Result<u32, String> {
    let count = tokio::task::spawn_blocking(move || purge_all(&ctx()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache.0.lock() {
        if let Some((_, ov)) = guard.as_mut() {
            ov.summary.trash_batch_count = 0;
        }
    }
    Ok(count as u32)
}

#[tauri::command]
#[specta::specta]
pub async fn run_doctor() -> Result<Vec<DoctorReport>, String> {
    tokio::task::spawn_blocking(move || run_all_doctors(&ctx()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn fix_doctors(
    cache: tauri::State<'_, OverviewCache>,
) -> Result<DoctorFixReport, String> {
    let res = tokio::task::spawn_blocking(move || fix_all_doctors(&ctx()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache.0.lock() {
        if let Some((_, ov)) = guard.as_mut() {
            ov.doctors = res.reports.clone();
            recompute_summary(ov);
        }
    }
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn audit_mcp() -> Result<McpAuditReport, String> {
    tokio::task::spawn_blocking(move || core_audit_mcp(&ctx()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn kill_orphan_mcp(
    app: AppHandle,
    cache: tauri::State<'_, OverviewCache>,
    pid: u32,
) -> Result<KillProcessResult, String> {
    let res = tokio::task::spawn_blocking(move || kill_orphan_process(pid))
        .await
        .map_err(|e| e.to_string())?;
    if res.success {
        if let Ok(mut guard) = cache.0.lock() {
            if let Some((_, ov)) = guard.as_mut() {
                ov.mcp.orphan_processes.retain(|p| p.pid != pid);
                recompute_summary(ov);
                update_tray_summary(
                    &app,
                    ov.summary.total_reclaimable_bytes,
                    ov.summary.orphan_mcp_count,
                );
            }
        }
    }
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn open_dashboard(app: AppHandle) -> Result<(), String> {
    open_dashboard_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn hide_tray_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("tray") {
        let _ = win.hide();
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    #[specta(type = f64)]
    pub total_bytes: u64,
    #[specta(type = f64)]
    pub available_bytes: u64,
}

/// Disk space of the volume that holds the user's home directory.
#[tauri::command]
#[specta::specta]
pub fn get_disk_space() -> Result<DiskSpace, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "home directory not found".to_string())?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| home.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| DiskSpace {
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
        })
        .ok_or_else(|| "disk not found".to_string())
}

#[cfg(test)]
mod disk_space_tests {
    use super::get_disk_space;

    #[test]
    fn reports_sane_disk_space() {
        let d = get_disk_space().expect("disk space");
        assert!(d.total_bytes > 0);
        assert!(d.available_bytes <= d.total_bytes);
    }
}
