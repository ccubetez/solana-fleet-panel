#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, process::{Command, Stdio}, time::Duration};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static SERVER_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let res = app.path().resource_dir().expect("resource dir");
            let data = app.path().app_data_dir().expect("app data dir");
            fs::create_dir_all(&data)?;

            // node: unix — node/bin/node, windows — node/node.exe
            let (node, node_dir) = if cfg!(windows) {
                (res.join("node/node.exe"), res.join("node"))
            } else {
                (res.join("node/bin/node"), res.join("node/bin"))
            };
            let server = res.join("fleet-app/server.mjs");
            // наш node — первым в PATH: дочерний spawn('node', 4_fleet.mjs) резолвится в него же
            let sep = if cfg!(windows) { ";" } else { ":" };
            let path = format!("{}{}{}", node_dir.display(), sep, std::env::var("PATH").unwrap_or_default());

            let child = Command::new(&node)
                .arg(&server)
                .current_dir(&data) // все данные (wallets.json, логи) — в AppData/Application Support
                .env("PATH", path)
                .env("CLUSTER", "mainnet")
                .env("BIND_HOST", "127.0.0.1")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn fleet server");
            let _ = SERVER_PID.set(Mutex::new(Some(child.id())));

            // ждём порт и показываем окно
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..90 {
                    if std::net::TcpStream::connect("127.0.0.1:3777").is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                let pid = SERVER_PID.get()
                    .and_then(|m| m.lock().ok())
                    .and_then(|g| *g);
                #[cfg(windows)]
                if let Some(pid) = pid {
                    // /T — всё дерево (сервер + 4_fleet.mjs)
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
                }
                #[cfg(not(windows))]
                {
                    let _ = pid; // на unix гасим по уникальному пути ресурсов
                    let _ = Command::new("pkill").args(["-f", "fleet-app/server.mjs"]).status();
                    let _ = Command::new("pkill").args(["-f", "fleet-app/4_fleet.mjs"]).status();
                }
            }
        });
}
