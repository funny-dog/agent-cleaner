use crate::commands::OverviewCache;
use crate::tray::update_tray_summary;
use cleaner_core::get_overview;
use cleaner_core::recommendation::DEFAULT_EXEMPT_HOURS;
use cleaner_core::types::{CleanerContext, ScanOptions};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn start_background_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let period = Duration::from_secs(60 * 60);
        // Skip immediate tick at t=0 so background patrol does not collide with initial UI scan.
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            interval.tick().await;
            let res = tokio::task::spawn_blocking(|| {
                let ctx = CleanerContext::default();
                get_overview(&ctx, &ScanOptions::default())
            })
            .await;

            if let Ok(overview) = res {
                if let Ok(mut guard) = app.state::<OverviewCache>().0.lock() {
                    *guard = Some((DEFAULT_EXEMPT_HOURS, overview.clone()));
                }
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
