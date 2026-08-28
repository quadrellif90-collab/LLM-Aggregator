// LLM Aggregator — Tauri shell.
//
// In release builds the Node gateway (server/index.js) is launched as a child
// process from the bundled resources, so the webview can reach
// http://localhost:8787/ where the gateway serves the control panel.
// In dev the gateway is started by `beforeDevCommand` instead.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::api::path::resource_dir;

#[cfg(not(debug_assertions))]
fn main() {
    if let Some(res) = resource_dir() {
        let _ = std::process::Command::new("node")
            .arg("server/index.js")
            .current_dir(&res)
            .spawn();
    }

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LLM Aggregator");
}

#[cfg(debug_assertions)]
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LLM Aggregator");
}
