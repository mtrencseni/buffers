//! Persistence: two JSON files in the app's own config dir.
//! - settings.json     — app settings (schema lives in the frontend)
//! - .buffers.json     — every open buffer (hot exit, Sublime-style)
//! Both are written atomically (write-then-rename) so a crash mid-write can
//! never corrupt them. Buffers itself only ever writes to these two files —
//! plus paths the user explicitly picks in an export dialog (files.rs).

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn config_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn load(app: &tauri::AppHandle, name: &str) -> Result<Value, String> {
    let p = config_path(app, name)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or(Value::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

fn save(app: &tauri::AppHandle, name: &str, value: &Value) -> Result<(), String> {
    let p = config_path(app, name)?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_state(app: tauri::AppHandle) -> Result<Value, String> {
    load(&app, "settings.json")
}

#[tauri::command]
pub fn save_state(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    save(&app, "settings.json", &state)
}

#[tauri::command]
pub fn load_buffers(app: tauri::AppHandle) -> Result<Value, String> {
    load(&app, ".buffers.json")
}

#[tauri::command]
pub fn save_buffers(app: tauri::AppHandle, buffers: Value) -> Result<(), String> {
    save(&app, ".buffers.json", &buffers)
}
