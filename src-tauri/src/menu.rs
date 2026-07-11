//! Custom app menu. The default Tauri menu binds Cmd+W to "Close Window" and
//! Cmd+T is reserved for tabs — Buffers handles both in the webview, so we
//! install a menu without conflicting key equivalents. Custom items emit a
//! "menu" event with the command id; the frontend routes it through the same
//! handlers as the (rebindable) keyboard shortcuts.

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
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
