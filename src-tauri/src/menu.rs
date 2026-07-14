//! Custom app menu — **macOS only**.
//!
//! On macOS the menu lives in the global bar at the top of the screen, outside our
//! window, so it costs the design nothing. We install our own (rather than take
//! Tauri's default) because that one binds Cmd+W to "Close Window" and reserves
//! Cmd+T, both of which Buffers handles in the webview. Custom items carry no key
//! equivalents — they'd shadow the rebindable in-app shortcuts — and instead emit a
//! "menu" event with the command id, which the frontend routes through the same
//! handlers as the keyboard shortcuts.
//!
//! On Windows/Linux there is no global bar: the menu would be a Win32/GTK bar drawn
//! *inside* our window, in the OS's colors, which no API lets us theme — a grey
//! strip across the top of a Mariana-dark window. That breaks the "own design, not
//! native emulation" rule, so we install no menu at all and surface the same actions
//! in the in-app toolbar next to + (see `actionsEl` in main.ts). Nothing is lost:
//! every item was already a shortcut, and the webview handles cut/copy/paste itself.

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::Emitter;

    let app_menu = SubmenuBuilder::new(app, "Buffers")
        .about(Some(AboutMetadata::default()))
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_buf = MenuItemBuilder::with_id("menu:newTab", "New Buffer").build(app)?;
    let reopen = MenuItemBuilder::with_id("menu:reopenTab", "Reopen Closed Buffer").build(app)?;
    let import = MenuItemBuilder::with_id("menu:importFile", "Open / Import…").build(app)?;
    let export = MenuItemBuilder::with_id("menu:exportFile", "Save / Export…").build(app)?;
    let close_buf = MenuItemBuilder::with_id("menu:closeTab", "Close Buffer").build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_buf)
        .item(&reopen)
        .separator()
        .item(&import)
        .item(&export)
        .separator()
        .item(&close_buf)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let wrap = MenuItemBuilder::with_id("menu:toggleWrap", "Toggle Word Wrap").build(app)?;
    let view = SubmenuBuilder::new(app, "View").item(&wrap).build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.clone();
        if let Some(cmd) = id.strip_prefix("menu:") {
            let _ = app.emit("menu", cmd.to_string());
        }
    });
    Ok(())
}
