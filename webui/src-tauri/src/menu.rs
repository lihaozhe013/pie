//! The macOS application menu.
//!
//! Tauri's default menu is replaced so its About item opens the interface's own
//! About dialog instead of the native panel. The shell evaluates a DOM event in
//! the page; the page still cannot call Rust. Everything else matches the
//! default menu, so the standard editing shortcuts, Hide, and Quit keep working.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

/// The About item's id, handled by the menu event listener in `lib.rs`.
pub(crate) const ABOUT_MENU_ID: &str = "about";

/// Evaluated in the page when the About item is chosen. Keep in sync with
/// `SHOW_ABOUT_EVENT` in `lib/about-request.ts`.
pub(crate) const SHOW_ABOUT_SCRIPT: &str =
    "window.dispatchEvent(new CustomEvent('pie:show-about'))";

/// The default Tauri menu, with About wired to the page's dialog.
pub(crate) fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let name = app.package_info().name.clone();

    let about = MenuItem::with_id(
        app,
        ABOUT_MENU_ID,
        format!("About {name}"),
        true,
        None::<&str>,
    )?;

    let app_submenu = Submenu::with_items(
        app,
        name.as_str(),
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}
