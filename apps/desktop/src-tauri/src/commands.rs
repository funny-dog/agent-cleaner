use cleaner_core::doctor::{fix_all_doctors, run_all_doctors};
use cleaner_core::get_overview as core_overview;
use cleaner_core::mcp_auditor::{audit_mcp as core_audit_mcp, kill_orphan_process};
use cleaner_core::scanner::{clean as core_clean, scan_all as core_scan_all};
use cleaner_core::trash::{list_batches, purge_all, purge_batch, restore_batch};
use cleaner_core::types::{
    CleanOptions, CleanReport, CleanerContext, DoctorFixReport, DoctorReport, KillProcessResult,
    McpAuditReport, OverviewReport, RestoreReport, ScanOptions, ScanResult, TrashManifest,
};
use tauri::AppHandle;

use crate::tray::{open_dashboard_window, update_tray_summary};

fn ctx() -> CleanerContext {
    CleanerContext::default()
}

#[tauri::command]
#[specta::specta]
pub async fn get_overview(
    app: AppHandle,
    options: Option<ScanOptions>,
) -> Result<OverviewReport, String> {
    let opts = options.unwrap_or_default();
    let report = tokio::task::spawn_blocking(move || core_overview(&ctx(), &opts))
        .await
        .map_err(|e| e.to_string())?;
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
pub async fn clean(app: AppHandle, options: CleanOptions) -> Result<CleanReport, String> {
    let report = tokio::task::spawn_blocking(move || core_clean(&ctx(), &options))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    if !report.dry_run {
        // Refresh tray indicator after cleanup
        let app_clone = app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let overview = core_overview(&ctx(), &ScanOptions::default());
            update_tray_summary(
                &app_clone,
                overview.summary.total_reclaimable_bytes,
                overview.summary.orphan_mcp_count,
            );
        })
        .await;
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
pub async fn restore_trash_batch(batch_id: String) -> Result<RestoreReport, String> {
    tokio::task::spawn_blocking(move || restore_batch(&ctx(), &batch_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn purge_trash_batch(batch_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || purge_batch(&ctx(), &batch_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn purge_all_trash() -> Result<u32, String> {
    let count = tokio::task::spawn_blocking(move || purge_all(&ctx()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
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
pub async fn fix_doctors() -> Result<DoctorFixReport, String> {
    tokio::task::spawn_blocking(move || fix_all_doctors(&ctx()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
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
pub async fn kill_orphan_mcp(app: AppHandle, pid: u32) -> Result<KillProcessResult, String> {
    let res = tokio::task::spawn_blocking(move || kill_orphan_process(pid))
        .await
        .map_err(|e| e.to_string())?;
    let overview = tokio::task::spawn_blocking(move || core_overview(&ctx(), &ScanOptions::default()))
        .await
        .map_err(|e| e.to_string())?;
    update_tray_summary(
        &app,
        overview.summary.total_reclaimable_bytes,
        overview.summary.orphan_mcp_count,
    );
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
