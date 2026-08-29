#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use log::{error, info};
use std::env;
use std::process::{Command, Stdio};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let server_script = if cfg!(debug_assertions) {
        std::env::current_dir()
            .unwrap_or_default()
            .join("server")
            .join("index.js")
    } else {
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .map(|p| p.join("server").join("index.js"))
            .unwrap_or_default()
    };

    let script_path = if server_script.exists() {
        server_script
    } else {
        std::path::PathBuf::from("server/index.js")
    };

    let port = env::var("AGG_PORT")
        .or_else(|_| env::var("MODELHUB_PORT").unwrap_or_else(|_| "9090".to_string()));

    info!("Starting LLM Aggregator gateway on port {}...", port);

    let child = Command::new("node")
        .arg(script_path)
        .env("AGG_PORT", &port)
        .env("RUST_BACKTRACE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match child {
        Ok(mut proc) => {
            if let Some(ref mut out) = proc.stdout {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    info!("[server] {}", line);
                }
            }
            if let Some(ref mut err) = proc.stderr {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    error!("[server:err] {}", line);
                }
            }

            let status = proc.wait().map(|s| s.code()).unwrap_or(1);
            std::process::exit(status);
        }
        Err(e) => {
            error!("Failed to spawn gateway process: {}", e);
            std::process::exit(1);
        }
    }
}
