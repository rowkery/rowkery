//! The MCP server without the app around it, for testing on machines that
//! can't build the Tauri shell: `cargo run -p rowkery-mcp --example stdio`.
//! The real entry point is `Rowkery --mcp`.

fn main() {
    std::process::exit(rowkery_mcp::run_stdio());
}
