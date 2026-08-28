// LLM Aggregator — Tauri shell.
//
// The Node gateway (server/index.js) is launched by Tauri's dev/build pipeline
// (see beforeDevCommand / beforeBuildCommand in tauri.conf.json). The webview
// simply points at http://localhost:8787/ where the gateway serves the panel.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LLM Aggregator");
}
