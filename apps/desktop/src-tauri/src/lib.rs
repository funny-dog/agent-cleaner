mod commands;
mod scheduler;
mod tray;

use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder, ErrorHandlingMode};

pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .error_handling(ErrorHandlingMode::Result)
        .commands(collect_commands![
            commands::get_overview,
            commands::scan,
            commands::clean,
            commands::list_trash,
            commands::restore_trash_batch,
            commands::purge_trash_batch,
            commands::purge_all_trash,
            commands::run_doctor,
            commands::fix_doctors,
            commands::audit_mcp,
            commands::kill_orphan_mcp,
            commands::open_dashboard,
            commands::hide_tray_window,
        ])
}

pub fn export_bindings_to_disk() {
    specta_builder()
        .export(Typescript::default(), "../src/bindings.ts")
        .expect("Failed to export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    {
        let _ = builder.export(Typescript::default(), "../src/bindings.ts");
    }

    tauri::Builder::default()
        .manage(commands::OverviewCache::default())
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            scheduler::start_background_scheduler(app.handle().clone());

            // Open dashboard on first launch unless launched in tray-only mode
            let tray_only = std::env::args().any(|a| a == "--tray");
            if !tray_only {
                let _ = tray::open_dashboard_window(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Keep background tray resident even when all windows are closed
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn generate_typescript_bindings() {
        super::export_bindings_to_disk();
    }
}
