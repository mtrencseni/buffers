mod devtools;
mod files;
mod menu;
mod remote;
mod store;

/// macOS: when the window is activated (e.g. Cmd-Tab), WKWebView doesn't
/// re-hit-test the cursor, so it can stay the inactive-window arrow even over the
/// editor until the mouse moves — a known wry/WebKit bug. The reliable workaround
/// (what a manual window resize or a devtools toggle does) is to force a
/// re-layout: nudge the window size by 1px and back so WebKit recomputes the
/// cursor for what's under the pointer. Invisible; only fires on focus-gained.
#[cfg(target_os = "macos")]
fn nudge_relayout(window: &tauri::Window) {
    let Ok(size) = window.inner_size() else { return };
    let bumped = tauri::PhysicalSize::new(size.width, size.height.saturating_add(1));
    if window.set_size(bumped).is_err() {
        return;
    }
    // ONE round-trip only. More cycles re-arm tracking no better but visibly
    // re-flow wrapped content on every focus — annoying. This single 1px bump
    // is enough to un-stick WebKit's cursor tracking (moving the mouse then works).
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let _ = win.set_size(size);
    });
}

/// The window starts hidden (`visible: false` in tauri.conf.json) and the frontend
/// calls this once it has fully rendered — otherwise the webview's default white
/// background is visible for the first few hundred ms while the page loads.
#[tauri::command]
fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// A file path passed on the command line at first launch (Delight's F4 → "open
/// this file in Buffers"). The frontend fetches it once on startup and imports it.
struct StartupFile(std::sync::Mutex<Option<String>>);

/// The first non-flag command-line argument, if it looks like a file to open.
fn file_arg(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1) // argv[0] is the executable
        .find(|a| !a.starts_with('-'))
        .cloned()
}

/// Return (and clear) the startup file path, if any. Called once by the frontend
/// on init; subsequent files arrive via the "open-file" event (single-instance).
#[tauri::command]
fn take_open_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

pub fn run() {
    tauri::Builder::default()
        // Must be the FIRST plugin. A second launch (e.g. Delight's F4) fires this
        // in the already-running instance: open its file and focus the window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(path) = file_arg(&argv) {
                let _ = app.emit("open-file", path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Remembers window size/position across launches (see first-run sizing below).
        // VISIBLE is excluded: restoring it would show the window during setup,
        // before the webview has painted — the white flash `visible: false` exists
        // to prevent. The frontend shows the window itself (show_main_window).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::VISIBLE),
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            store::load_state,
            store::save_state,
            store::load_buffers,
            store::save_buffers,
            store::load_remote_cache,
            store::save_remote_cache,
            files::read_file,
            files::write_file,
            devtools::toggle_devtools,
            devtools::close_devtools,
            remote::remote_push,
            remote::cloud_push,
            remote::cloud_delete,
            remote::remote_fetch,
            remote::remote_ping,
            remote::machine_hostname,
            show_main_window,
            take_open_file,
        ])
        .on_window_event(|window, event| match event {
            // The window-state plugin only persists on a clean exit; that never
            // happened for Buffers (no .window-state.json was written), so every
            // launch looked like a first run and re-centered at 80%. Save on
            // focus-loss (switch-away / quit) so the last move/resize sticks.
            tauri::WindowEvent::Focused(false) => {
                use tauri::Manager;
                use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                let _ = window.app_handle().save_window_state(StateFlags::all());
            }
            // On focus-gained, work around the WKWebView stale-cursor bug.
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Focused(true) => nudge_relayout(window),
            _ => {}
        })
        .setup(|app| {
            use tauri::Manager;
            menu::install(app.handle())?;

            // Stash a file path passed at first launch for the frontend to pick up.
            app.manage(StartupFile(std::sync::Mutex::new(file_arg(
                &std::env::args().collect::<Vec<_>>(),
            ))));

            // First launch (no saved window state yet): open at 80% of the
            // screen, centered. Later launches are restored by the plugin.
            let has_state = app
                .path()
                .app_config_dir()
                .map(|d| d.join(".window-state.json").exists())
                .unwrap_or(false);
            if !has_state {
                if let Some(win) = app.get_webview_window("main") {
                    let monitor = win
                        .current_monitor()
                        .ok()
                        .flatten()
                        .or(win.primary_monitor().ok().flatten());
                    if let Some(m) = monitor {
                        let sz = m.size();
                        let scale = m.scale_factor();
                        let w = sz.width as f64 * 0.8 / scale;
                        let h = sz.height as f64 * 0.8 / scale;
                        let _ = win.set_size(tauri::LogicalSize::new(w, h));
                        let _ = win.center();
                    }
                }
            }

            // Failsafe for the hidden start: if the frontend dies before it can
            // call show_main_window (JS error, asset failure), reveal the window
            // anyway after a beat — a broken page beats an invisible app.
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                });
            }

            // macOS 13.3+ requires WKWebView.isInspectable = true for the Web
            // Inspector to open; Tauri only sets it in debug, so force it here.
            #[cfg(target_os = "macos")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        let obj: *mut objc2::runtime::AnyObject = webview.inner().cast();
                        unsafe {
                            let _: () = objc2::msg_send![obj, setInspectable: true];
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Buffers");
}
