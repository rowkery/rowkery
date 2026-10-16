//! "Connect an agent": adds Rowkery's MCP server (`<this executable> --mcp`)
//! to Claude Code or Claude Desktop in one click, after the sheet has shown
//! exactly what will run.
//!
//! - Claude Code: its own `claude mcp add --scope user rowkery -- <exe> --mcp`.
//!   An app opened from the Dock doesn't get the terminal's PATH, so the PATH
//!   comes from the user's login shell (`$SHELL -ilc`), and `claude` (and the
//!   `node` an npm install needs) are found on it. Whether it is already added
//!   is read from Claude Code's `~/.claude.json` (user-scope `mcpServers`).
//! - Claude Desktop: has no CLI, so Rowkery writes `mcpServers.rowkery` into
//!   `claude_desktop_config.json` itself, keeping every other key and their
//!   order, through a temporary file and a rename. A file that isn't valid
//!   JSON is never overwritten.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The server's name in each client's config.
const NAME: &str = "rowkery";
/// Prints the login shell's PATH after this marker, so rc-file noise is skipped.
const PATH_MARKER: &str = "__ROWKERY_PATH__";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    ClaudeCode,
    ClaudeDesktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// The client isn't installed (Claude Code: no `claude` on the login PATH).
    Missing,
    /// Installed, no `rowkery` server yet: Run adds it.
    Ready,
    /// Already runs this executable with `--mcp`.
    Connected,
    /// Has a `rowkery` server pointing elsewhere: Run replaces it.
    Other,
    /// Claude Desktop's config isn't valid JSON; Rowkery won't touch it.
    Unreadable,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectCheck {
    pub client: Client,
    pub state: State,
    /// What Run does, shown verbatim in the sheet's terminal block: the
    /// shell command(s) for Claude Code, the file and entry for Claude Desktop.
    pub preview: String,
    /// The same as one copyable line (Claude Code) or JSON entry (Desktop).
    pub copy: String,
    /// The `rowkery` command the client has now, when it has one.
    pub existing: Option<String>,
    /// Claude Desktop's config file, `~` for the home directory.
    pub config_file: Option<String>,
    /// Why the config can't be read (Unreadable).
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectRun {
    pub ok: bool,
    /// The client's own output (Claude Code), or what Rowkery changed.
    pub output: String,
    pub check: ConnectCheck,
}

/// Where things are; one value so tests can point it at a temp directory.
#[derive(Debug, Clone)]
pub struct Env {
    pub exe: String,
    pub home: PathBuf,
    /// Claude Code's config dir override (`CLAUDE_CONFIG_DIR`).
    pub claude_config_dir: Option<PathBuf>,
    /// The PATH to look for `claude` on; None reads it from the login shell.
    pub path: Option<String>,
    /// Claude Desktop's config file.
    pub desktop_config: PathBuf,
    /// Places whose existence means Claude Desktop is installed.
    pub desktop_markers: Vec<PathBuf>,
}

impl Env {
    pub fn current() -> Result<Self, String> {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or("No home directory")?;
        let (desktop_config, desktop_markers) = desktop_paths(&home);
        Ok(Self {
            exe,
            claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            home,
            path: None,
            desktop_config,
            desktop_markers,
        })
    }

    fn tilde(&self, p: &Path) -> String {
        match p.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.to_string_lossy()),
            Err(_) => p.to_string_lossy().into_owned(),
        }
    }

    fn claude_json(&self) -> PathBuf {
        match &self.claude_config_dir {
            Some(dir) => dir.join(".claude.json"),
            None => self.home.join(".claude.json"),
        }
    }
}

fn desktop_paths(home: &Path) -> (PathBuf, Vec<PathBuf>) {
    #[cfg(target_os = "macos")]
    {
        let dir = home.join("Library/Application Support/Claude");
        (
            dir.join("claude_desktop_config.json"),
            vec![
                PathBuf::from("/Applications/Claude.app"),
                home.join("Applications/Claude.app"),
                dir,
            ],
        )
    }
    #[cfg(target_os = "windows")]
    {
        let dir = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Claude");
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        (
            dir.join("claude_desktop_config.json"),
            vec![local.join("AnthropicClaude"), dir],
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = home.join(".config/Claude");
        (dir.join("claude_desktop_config.json"), vec![dir])
    }
}

/// `'…'` for a POSIX shell, only when needed.
fn sh_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:@%".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn add_line(exe: &str) -> String {
    format!(
        "claude mcp add --scope user {NAME} -- {} --mcp",
        sh_quote(exe)
    )
}

fn remove_line() -> String {
    format!("claude mcp remove --scope user {NAME}")
}

/// `command arg…` of a config's `mcpServers.rowkery`, and whether it is this app.
fn server_entry(config: &Value, exe: &str) -> Option<(String, bool)> {
    let entry = config.get("mcpServers")?.get(NAME)?;
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
    let args: Vec<&str> = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut shown = command.to_string();
    for a in &args {
        shown.push(' ');
        shown.push_str(a);
    }
    Some((shown, command == exe && args == ["--mcp"]))
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{} isn't valid JSON ({e})", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

fn desktop_entry_json(exe: &str) -> String {
    let command = serde_json::to_string(exe).unwrap_or_default();
    format!("\"{NAME}\": {{\n  \"command\": {command},\n  \"args\": [\"--mcp\"]\n}}")
}

pub fn check(client: Client, env: &Env) -> ConnectCheck {
    match client {
        Client::ClaudeCode => check_code(env, find_claude(env).is_some()),
        Client::ClaudeDesktop => check_desktop(env),
    }
}

fn check_code(env: &Env, installed: bool) -> ConnectCheck {
    let existing = read_json(&env.claude_json())
        .ok()
        .flatten()
        .and_then(|c| server_entry(&c, &env.exe));
    let add = add_line(&env.exe);
    let (state, preview) = match (&existing, installed) {
        (_, false) => (State::Missing, add.clone()),
        (Some((_, true)), _) => (State::Connected, add.clone()),
        (Some(_), _) => (State::Other, format!("{}\n{add}", remove_line())),
        (None, _) => (State::Ready, add.clone()),
    };
    ConnectCheck {
        client: Client::ClaudeCode,
        state,
        preview,
        copy: add,
        existing: existing.map(|(s, _)| s),
        config_file: None,
        problem: None,
    }
}

fn check_desktop(env: &Env) -> ConnectCheck {
    let file = env.tilde(&env.desktop_config);
    let entry = desktop_entry_json(&env.exe);
    let indented: String = entry
        .lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = ConnectCheck {
        client: Client::ClaudeDesktop,
        state: State::Ready,
        preview: format!("{file}\n  \"mcpServers\": {{\n{indented}\n  }}"),
        copy: format!("{{\n  \"mcpServers\": {{\n{indented}\n  }}\n}}"),
        existing: None,
        config_file: Some(file),
        problem: None,
    };
    let installed = env.desktop_config.exists() || env.desktop_markers.iter().any(|p| p.exists());
    match read_json(&env.desktop_config) {
        Err(e) => {
            out.state = State::Unreadable;
            out.problem = Some(e);
        }
        Ok(config) => {
            let existing = config.as_ref().and_then(|c| server_entry(c, &env.exe));
            out.state = match (&existing, installed) {
                (_, false) => State::Missing,
                (Some((_, true)), _) => State::Connected,
                (Some(_), _) => State::Other,
                (None, _) => State::Ready,
            };
            out.existing = existing.map(|(s, _)| s);
        }
    }
    out
}

pub fn run(client: Client, env: &Env) -> ConnectRun {
    let (ok, output) = match client {
        Client::ClaudeCode => run_code(env),
        Client::ClaudeDesktop => match write_desktop(env) {
            Ok(msg) => (true, msg),
            Err(e) => (false, e),
        },
    };
    ConnectRun {
        ok,
        output,
        check: check(client, env),
    }
}

fn run_code(env: &Env) -> (bool, String) {
    let Some((claude, path)) = find_claude(env) else {
        return (false, "claude: command not found".into());
    };
    let mut output = String::new();
    let replacing = matches!(check_code(env, true).state, State::Other);
    if replacing {
        match run_claude(&claude, &path, &["mcp", "remove", "--scope", "user", NAME]) {
            Ok((true, out)) => output.push_str(&out),
            Ok((false, out)) => return (false, out),
            Err(e) => return (false, e),
        }
    }
    let args = [
        "mcp", "add", "--scope", "user", NAME, "--", &env.exe, "--mcp",
    ];
    match run_claude(&claude, &path, &args) {
        Ok((ok, out)) => {
            if !output.is_empty() && !out.is_empty() {
                output.push('\n');
            }
            output.push_str(&out);
            (ok, output)
        }
        Err(e) => (false, e),
    }
}

/// Runs `claude` with the login PATH; (exit 0, stdout + stderr).
fn run_claude(claude: &Path, path: &str, args: &[&str]) -> Result<(bool, String), String> {
    let child = Command::new(claude)
        .args(args)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", claude.display()))?;
    let (status, stdout, stderr) = wait_output(child, Duration::from_secs(30))
        .ok_or("Claude Code didn't finish within 30 seconds")?;
    let mut out = stdout.trim_end().to_string();
    let err = stderr.trim_end();
    if !err.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(err);
    }
    if !status && out.is_empty() {
        out = "Claude Code exited with an error".into();
    }
    Ok((status, out))
}

/// Waits up to `limit`, then kills the child; None when it timed out.
fn wait_output(mut child: std::process::Child, limit: Duration) -> Option<(bool, String, String)> {
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some((
        status.success(),
        out_t.join().unwrap_or_default(),
        err_t.join().unwrap_or_default(),
    ))
}

/// `claude` and the PATH to run it with: the login shell's PATH, plus the
/// places Claude Code's installers use.
fn find_claude(env: &Env) -> Option<(PathBuf, String)> {
    let mut path = env.path.clone().or_else(login_path).unwrap_or_default();
    for extra in [
        env.home.join(".local/bin"),
        env.home.join(".claude/local"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ] {
        let extra = extra.to_string_lossy().into_owned();
        if !std::env::split_paths(&path).any(|p| p.to_string_lossy() == extra) {
            if !path.is_empty() {
                path.push(if cfg!(windows) { ';' } else { ':' });
            }
            path.push_str(&extra);
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
    };
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| is_executable(p))
        .map(|p| (p, path))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The interactive login shell's PATH (what a new Terminal window gets).
fn login_path() -> Option<String> {
    if cfg!(windows) {
        return std::env::var("PATH").ok();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = Command::new(shell)
        .args(["-ilc", &format!("printf '\\n{PATH_MARKER}%s\\n' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let (_, out, _) = wait_output(child, Duration::from_secs(5))?;
    out.lines()
        .find_map(|l| l.strip_prefix(PATH_MARKER))
        .map(str::to_string)
        .or_else(|| std::env::var("PATH").ok())
}

/// A config value; `mcpServers` stays an ordered map when written back.
#[derive(Serialize)]
#[serde(untagged)]
enum Node {
    Plain(Value),
    Ordered(IndexMap<String, Value>),
}

fn write_desktop(env: &Env) -> Result<String, String> {
    let file = &env.desktop_config;
    // The top level and `mcpServers` keep their key order (serde_json's own
    // map sorts keys, and its order feature would change every other crate).
    type Ordered = IndexMap<String, Value>;
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Couldn't read {}: {e}", file.display())),
    };
    let config: Ordered = if text.trim().is_empty() {
        Ordered::new()
    } else {
        serde_json::from_str(&text)
            .map_err(|e| format!("{} isn't a JSON object ({e})", file.display()))?
    };
    let mut servers: Ordered = match config.get("mcpServers") {
        None => Ordered::new(),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|_| format!("mcpServers in {} isn't a JSON object", file.display()))?,
    };
    let replaced = servers.contains_key(NAME);
    servers.insert(
        NAME.into(),
        serde_json::json!({ "command": env.exe, "args": ["--mcp"] }),
    );
    let mut out: IndexMap<String, Node> = config
        .into_iter()
        .map(|(k, v)| (k, Node::Plain(v)))
        .collect();
    out.insert("mcpServers".into(), Node::Ordered(servers));
    let config = out;
    let mut text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    text.push('\n');
    let dir = file.parent().ok_or("No config directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let tmp = dir.join(".claude_desktop_config.json.rowkery");
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't save {}: {e}", file.display())
    })?;
    Ok(format!(
        "{} {NAME} in {}",
        if replaced { "Replaced" } else { "Added" },
        env.tilde(file)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(dir: &Path) -> Env {
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        Env {
            exe: "/Applications/Rowkery.app/Contents/MacOS/Rowkery".into(),
            claude_config_dir: None,
            path: Some(dir.join("bin").to_string_lossy().into_owned()),
            desktop_config: home.join("Claude/claude_desktop_config.json"),
            desktop_markers: vec![home.join("Claude")],
            home,
        }
    }

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rowkery-mcp-connect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(sh_quote("/usr/bin/x"), "/usr/bin/x");
        assert_eq!(sh_quote("/A B/it's"), "'/A B/it'\\''s'");
        assert_eq!(
            add_line("/Applications/Rowkery.app/Contents/MacOS/Rowkery"),
            "claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp"
        );
    }

    #[test]
    fn desktop_missing_ready_connected_other() {
        let dir = tmp();
        let mut e = env(&dir);
        e.desktop_markers = vec![dir.join("nope")];
        assert_eq!(check_desktop(&e).state, State::Missing);

        let e = env(&dir);
        std::fs::create_dir_all(e.desktop_config.parent().unwrap()).unwrap();
        assert_eq!(check_desktop(&e).state, State::Ready);

        // Other keys and their order survive; the entry is added.
        std::fs::write(
            &e.desktop_config,
            r#"{"zeta":1,"mcpServers":{"other":{"command":"x"}},"alpha":[1,2]}"#,
        )
        .unwrap();
        let r = run(Client::ClaudeDesktop, &e);
        assert!(r.ok, "{}", r.output);
        assert!(r.output.starts_with("Added rowkery in ~/"), "{}", r.output);
        assert_eq!(r.check.state, State::Connected);
        let text = std::fs::read_to_string(&e.desktop_config).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["rowkery"]["args"][0], "--mcp");
        let at = |k: &str| text.find(k).unwrap();
        assert!(
            at("zeta") < at("mcpServers") && at("mcpServers") < at("alpha"),
            "{text}"
        );
        assert!(at("\"other\"") < at("\"rowkery\""), "{text}");

        // Another copy of Rowkery reads as Other and is replaced.
        let mut moved = e.clone();
        moved.exe = "/Users/x/Downloads/Rowkery.app/Contents/MacOS/Rowkery".into();
        let c = check_desktop(&moved);
        assert_eq!(c.state, State::Other);
        assert_eq!(
            c.existing.as_deref(),
            Some("/Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp")
        );
        let r = run(Client::ClaudeDesktop, &moved);
        assert!(r.ok && r.output.starts_with("Replaced"), "{}", r.output);
        assert_eq!(r.check.state, State::Connected);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn desktop_never_overwrites_invalid_json() {
        let dir = tmp();
        let e = env(&dir);
        std::fs::create_dir_all(e.desktop_config.parent().unwrap()).unwrap();
        std::fs::write(&e.desktop_config, "{ not json").unwrap();
        let c = check_desktop(&e);
        assert_eq!(c.state, State::Unreadable);
        assert!(c.problem.unwrap().contains("isn't valid JSON"));
        let r = run(Client::ClaudeDesktop, &e);
        assert!(!r.ok);
        assert_eq!(
            std::fs::read_to_string(&e.desktop_config).unwrap(),
            "{ not json"
        );
        // Valid JSON of the wrong shape is refused too.
        std::fs::write(&e.desktop_config, r#"{"mcpServers":[1]}"#).unwrap();
        let r = run(Client::ClaudeDesktop, &e);
        assert!(
            !r.ok && r.output.contains("isn't a JSON object"),
            "{}",
            r.output
        );
        assert_eq!(
            std::fs::read_to_string(&e.desktop_config).unwrap(),
            r#"{"mcpServers":[1]}"#
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_runs_add_with_the_login_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        let mut e = env(&dir);
        e.home = dir.join("home");
        // No `claude` anywhere on the PATH (and none in this fake home).
        e.path = Some(dir.join("bin").to_string_lossy().into_owned());
        if find_claude(&e).is_none() {
            assert_eq!(check(Client::ClaudeCode, &e).state, State::Missing);
        }

        // A fake `claude` that records its args and writes ~/.claude.json.
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = bin.join("claude");
        let claude_json = e.home.join(".claude.json");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$@\" >> '{log}'\nif [ \"$2\" = add ]; then printf '%s' '{{\"mcpServers\":{{\"rowkery\":{{\"type\":\"stdio\",\"command\":\"{exe}\",\"args\":[\"--mcp\"]}}}}}}' > '{cj}'; echo 'Added stdio MCP server rowkery to user config'; fi\n",
                log = dir.join("log").display(),
                exe = e.exe,
                cj = claude_json.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Another copy is registered: Run removes it first.
        std::fs::write(
            &claude_json,
            r#"{"mcpServers":{"rowkery":{"command":"/old/Rowkery","args":["--mcp"]}}}"#,
        )
        .unwrap();
        let c = check(Client::ClaudeCode, &e);
        assert_eq!(c.state, State::Other);
        assert!(c
            .preview
            .starts_with("claude mcp remove --scope user rowkery\n"));
        let r = run(Client::ClaudeCode, &e);
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("Added stdio MCP server"), "{}", r.output);
        assert_eq!(r.check.state, State::Connected);
        let log = std::fs::read_to_string(dir.join("log")).unwrap();
        assert_eq!(
            log,
            format!(
                "mcp remove --scope user rowkery\nmcp add --scope user rowkery -- {} --mcp\n",
                e.exe
            )
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_failure_keeps_its_message() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        let e = env(&dir);
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = bin.join("claude");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'Error: EACCES: permission denied' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let r = run(Client::ClaudeCode, &e);
        assert!(!r.ok);
        assert_eq!(r.output, "Error: EACCES: permission denied");
        assert_eq!(r.check.state, State::Ready);
        std::fs::remove_dir_all(dir).ok();
    }
}
