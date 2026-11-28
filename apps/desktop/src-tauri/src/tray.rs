use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const MAIN_TRAY_ID: &str = "main-tray";

fn format_compact_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
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

pub fn update_tray_summary(app: &AppHandle, reclaimable_bytes: u64, orphan_mcp_count: usize) {
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        let size_str = format_compact_bytes(reclaimable_bytes);
        let title = if orphan_mcp_count > 0 {
            format!("{size_str} · {orphan_mcp_count} MCP")
        } else {
            size_str
        };
        let _ = tray.set_title(Some(&title));
        let _ = tray.set_tooltip(Some(&title));
    }
}

pub fn open_dashboard_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("dashboard") {
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }

    // Create dashboard WebView on demand; closing it destroys the WebView to free RAM.
    WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("index.html".into()))
        .title("Agent Cleaner")
        .inner_size(1040.0, 700.0)
        .min_inner_size(860.0, 580.0)
        .center()
        .build()?;
    Ok(())
}

fn toggle_tray_popover(app: &AppHandle, click_pos: Option<PhysicalPosition<f64>>) {
    if let Some(win) = app.get_webview_window("tray") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        if let Some(pos) = click_pos {
            let x = (pos.x - 180.0).max(16.0) as i32;
            #[cfg(windows)]
            let y = (pos.y - 450.0).max(16.0) as i32;
            #[cfg(not(windows))]
            let y = (pos.y + 10.0).max(24.0) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let mut builder =
        WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html?view=tray".into()))
            .title("Agent Cleaner Tray")
            .inner_size(360.0, 440.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false);

    if let Some(pos) = click_pos {
        let x = (pos.x - 180.0).max(16.0);
        #[cfg(windows)]
        let y = (pos.y - 450.0).max(16.0);
        #[cfg(not(windows))]
        let y = (pos.y + 10.0).max(24.0);
        builder = builder.position(x, y);
    }

    if let Ok(win) = builder.build() {
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                let _ = win_clone.hide();
            }
        });
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Agent Cleaner", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(MAIN_TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .title("Agent Cleaner")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_dashboard" => {
                let _ = open_dashboard_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                toggle_tray_popover(tray.app_handle(), Some(position));
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
