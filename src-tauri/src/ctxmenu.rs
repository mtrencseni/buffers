//! Right-click context menu, Windows. WebView2's default menu is Edge's, and
//! on editable text it drags in browser features that make no sense inside a
//! desktop app ("Send to your devices", web capture, …). The menu can't be
//! replaced wholesale without losing the native edit items — whose clipboard
//! and IME behavior we very much want — so instead ContextMenuRequested
//! filters it down to an allowlist: the edit commands, plus Inspect when the
//! user's "Developer mode" setting is on.
//!
//! The setting lives in the frontend (settings.json); it mirrors it here via
//! the `set_devmode` command at startup and whenever it changes. macOS's
//! WKWebView menu is comparatively sane and is left alone.

use std::sync::atomic::{AtomicBool, Ordering};

static DEVMODE: AtomicBool = AtomicBool::new(false);

/// Mirror of the frontend's "Developer mode" setting, read by the menu filter
/// (and anything else that wants it). Called at init and on every change.
#[tauri::command]
pub fn set_devmode(enabled: bool) {
    DEVMODE.store(enabled, Ordering::Relaxed);
}

/// Hook ContextMenuRequested on the window's WebView2 and prune every item
/// whose (locale-independent) Name isn't allowlisted. No-op off Windows.
#[cfg(target_os = "windows")]
pub fn install(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::take_pwstr;
        use webview2_com::ContextMenuRequestedEventHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
        use windows_core::Interface;

        let Ok(controller) = webview.controller().CoreWebView2() else { return };
        let Ok(core11) = controller.cast::<ICoreWebView2_11>() else { return };

        let handler = ContextMenuRequestedEventHandler::create(Box::new(|_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let Ok(items) = args.MenuItems() else { return Ok(()) };
            let mut count = 0u32;
            if items.Count(&mut count).is_err() {
                return Ok(());
            }
            let dev = DEVMODE.load(Ordering::Relaxed);
            // Backwards, so removal doesn't shift the indices still to visit.
            for i in (0..count).rev() {
                let Ok(item) = items.GetValueAtIndex(i) else { continue };
                let mut name_ptr = windows_core::PWSTR::null();
                if item.Name(&mut name_ptr).is_err() {
                    continue;
                }
                let name = take_pwstr(name_ptr);
                // The edit commands stay; Inspect only in Developer mode;
                // everything else (share, web capture, …) goes.
                let keep = matches!(
                    name.as_str(),
                    "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll" | "undo" | "redo"
                ) || (dev && name == "inspectElement");
                if !keep {
                    let _ = items.RemoveValueAtIndex(i);
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core11.add_ContextMenuRequested(&handler, &mut token);
    });
}

#[cfg(not(target_os = "windows"))]
pub fn install(_window: &tauri::WebviewWindow) {}
