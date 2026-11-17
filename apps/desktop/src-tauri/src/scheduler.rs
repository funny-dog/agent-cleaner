use crate::tray::update_tray_summary;
use cleaner_core::get_overview;
use cleaner_core::types::{CleanerContext, ScanOptions};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub fn start_background_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30 * 60));
        loop {
            interval.tick().await;
            let res = tokio::task::spawn_blocking(|| {
                let ctx = CleanerContext::default();
                get_overview(&ctx, &ScanOptions::default())
            })
            .await;

            if let Ok(overview) = res {
                update_tray_summary(
                    &app,
                    overview.summary.total_reclaimable_bytes,
                    overview.summary.orphan_mcp_count,
                );
                let _ = app.emit("cleaner://overview-updated", &overview);
            }
        }
    });
}
