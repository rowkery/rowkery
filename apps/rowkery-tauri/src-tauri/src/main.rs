// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Rowkery --mcp`: the MCP server for Claude Code on stdio, no window.
    // Same executable as the app, so macOS hands it the app's keychain items.
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        std::process::exit(rowkery_mcp::run_stdio());
    }
    // First, so every latency mark is measured from here.
    let timings = rowkery_tauri_lib::timings::Timings::start();
    rowkery_tauri_lib::run(timings)
}
