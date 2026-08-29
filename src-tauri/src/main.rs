// LLM Aggregator — Tauri 2 shell.
//
// Release: spawn the Node gateway (server/index.js) from the bundled resources
// with CREATE_NO_WINDOW (no console), then poll TCP 127.0.0.1:9090 until it is
// ready, then reveal the window (which points at the gateway's panel URL).
// Dev: the gateway is started by `beforeDevCommand` instead.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::time::Duration;
use tauri::Manager;

const PORT: u16 = 9090;

#[cfg(not(debug_assertions))]
fn spawn_gateway(res: &std::path::Path) {
    use std::process::Command;
    let mut cmd = Command::new("node");
    cmd.arg("server/index.js");
    cmd.current_dir(res);
    cmd.env("AGG_PORT", PORT.to_string());
    cmd.env("AGG_DIR", res.to_string_lossy().to_string());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Err(e) = cmd.spawn() {
        eprintln!("failed to spawn gateway: {e}");
    }
}

fn server_ready() -> bool {
    TcpStream::connect(("127.0.0.1", PORT)).is_ok()
}

#[cfg(not(debug_assertions))]
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("no main window");
            if let Ok(res) = app.path().resource_dir() {
                spawn_gateway(&res);
            }
            std::thread::spawn(move || {
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(500));
                    if server_ready() {
                        let _ = window.show();
                        return;
                    }
                }
                let _ = window.show();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LLM Aggregator");
}

#[cfg(debug_assertions)]
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LLM Aggregator");
}
