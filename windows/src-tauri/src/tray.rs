// Notification-area icon: Open, Move to other display, Hover to show, Settings, Pause, Quit.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Coucou", true, None::<&str>)?;
    let swap = MenuItem::with_id(app, "swap_display", "Move to other display", true, None::<&str>)?;
    let hover_on = app.state::<crate::Shared>().settings.lock().unwrap().hover_to_show;
    let hover = CheckMenuItem::with_id(app, "hover_to_show", "Hover to show", true, hover_on, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &swap, &hover, &sep1, &settings, &pause, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("coucou")
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(move |app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "swap_display" => crate::swap_display(app),
            // The menu has already flipped the tick; the setting follows it.
            "hover_to_show" => crate::set_hover_to_show(app, hover.is_checked().unwrap_or(false)),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
