//! Import/export: one-shot file reads and writes. Buffers has no concept of an
//! "attached" file — import copies contents in, export copies contents out,
//! and the buffer stays its own entity. Paths always come from a native
//! open/save dialog the user drove, never from app logic.

use std::fs;

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&path, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
