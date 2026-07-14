//! Web Inspector control. Two implementations behind one pair of commands:
//! on macOS, wry's open_devtools can't toggle and WKWebView needs the private
//! `_inspector` (made inspectable at startup — see lib.rs); everywhere else,
//! Tauri's own devtools API does the job (kept in release by the `devtools`
//! Cargo feature).

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

/// Non-macOS (WebView2 / WebKitGTK): Tauri's own devtools API works here, and the
/// `devtools` Cargo feature keeps it available in release too — no private API
/// needed. `is_devtools_open` lets us toggle rather than only open.
#[cfg(not(target_os = "macos"))]
fn inspector(app: &tauri::AppHandle, action: i32) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    // action: 0 = toggle, 1 = force close
    if w.is_devtools_open() || action == 1 {
        w.close_devtools();
    } else {
        w.open_devtools();
    }
}

/// Toggle the Web Inspector. The frontend gates this behind a setting.
#[tauri::command]
pub fn toggle_devtools(app: tauri::AppHandle) {
    inspector(&app, 0);
}

/// Close the Web Inspector (used when the setting is switched off).
#[tauri::command]
pub fn close_devtools(app: tauri::AppHandle) {
    inspector(&app, 1);
}
