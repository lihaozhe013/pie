//! Open a URL in the user's browser. The shell has no IPC, so the webview cannot
//! ask for this itself; the navigation guard decides instead.

use std::process::Command;

pub fn open(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("{url} is not a URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to open {}", parsed.scheme()));
    }

    let mut command = opener(url);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::node_locator::quiet(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open {url}: {error}"))
}

#[cfg(target_os = "macos")]
fn opener(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(windows)]
fn opener(url: &str) -> Command {
    // `start` is a cmd built-in; the empty argument is the window title.
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", url]);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn opener(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}
