//! Web Inspector control (same approach as Delight): wry's open_devtools is a
//! no-op in release, so on macOS we drive WKWebView's private `_inspector`
//! directly. The webview is made inspectable at startup (lib.rs).

/// Show/hide/toggle the WKWebView Web Inspector.
#[cfg(target_os = "macos")]
fn inspector(app: &tauri::AppHandle, action: i32) {
    use objc2::runtime::AnyObject;
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.with_webview(move |wv| {
        let obj: *mut AnyObject = wv.inner().cast();
        unsafe {
            let _: () = objc2::msg_send![obj, setInspectable: true];
            let insp: *mut AnyObject = objc2::msg_send![obj, _inspector];
            if insp.is_null() {
                return;
            }
            let visible: bool = objc2::msg_send![insp, isVisible];
            // action: 0 = toggle, 1 = force close
            if visible || action == 1 {
                let _: () = objc2::msg_send![insp, close];
            } else {
                let _: () = objc2::msg_send![insp, show];
            }
        }
    });
}

/// Toggle the Web Inspector. The frontend gates this behind a setting.
#[tauri::command]
pub fn toggle_devtools(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    inspector(&app, 0);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Close the Web Inspector (used when the setting is switched off).
#[tauri::command]
pub fn close_devtools(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    inspector(&app, 1);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
