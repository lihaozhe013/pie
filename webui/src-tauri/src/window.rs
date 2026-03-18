//! The window, its navigation guard, and the status text it shows.

use crate::Shared;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Routes `window.open` and `target="_blank"` links through the navigation
/// handler, so the system browser opens them instead of a webview that cannot
/// create windows. Runs before every page's own scripts.
const INJECTED_SCRIPT: &str = r#"
(() => {
  const handoff = (target) => {
    try {
      window.location.assign(new URL(String(target), window.location.href).href);
    } catch (error) {
      console.error('Pie could not open', target, error);
    }
    return null;
  };
  window.open = (url) => handoff(url === undefined || url === null ? 'about:blank' : url);
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[target]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    handoff(href);
  }, true);
})();
"#;

#[derive(Debug, PartialEq, Eq)]
pub enum NavAction {
    /// Keep the navigation inside the window.
    Allow,
    /// Open it in the system browser and leave the window where it is.
    External,
    /// Refuse it entirely.
    Block,
}

pub fn create_main(
    app: &AppHandle,
    origin: Arc<Mutex<Option<Url>>>,
    shared: Arc<Shared>,
) -> tauri::Result<WebviewWindow> {
    let navigation_origin = origin;
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Pie")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 620.0)
        .center()
        // HTML5 drag and drop for attachments; Tauri's own drop handler would
        // swallow the events the composer listens for.
        .disable_drag_drop_handler()
        .initialization_script(INJECTED_SCRIPT)
        .on_navigation(move |url| {
            let current = navigation_origin
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            match classify(url, current.as_ref()) {
                NavAction::Allow => true,
                NavAction::External => {
                    let _ = crate::browser::open(url.as_str());
                    false
                }
                NavAction::Block => false,
            }
        })
        .build()?;

    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            crate::begin_close(&close_app, &shared);
        }
    });

    Ok(window)
}

/// Loopback pages of the running server stay in the window; API paths, external
/// links, and OAuth pages belong to the system browser.
pub fn classify(url: &Url, origin: Option<&Url>) -> NavAction {
    if is_app_origin(url) {
        return NavAction::Allow;
    }
    match url.scheme() {
        "http" | "https" => match origin {
            Some(origin) if same_origin(url, origin) => {
                if url.path() == "/api" || url.path().starts_with("/api/") {
                    NavAction::External
                } else {
                    NavAction::Allow
                }
            }
            _ => NavAction::External,
        },
        _ => NavAction::Block,
    }
}

fn is_app_origin(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub fn navigate(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| format!("{url} is not a URL: {error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is missing".to_string())?;
    window
        .navigate(parsed)
        .map_err(|error| format!("could not load {url}: {error}"))
}

/// Progress on the splash page, or an overlay on a loaded page.
pub fn set_status(app: &AppHandle, message: &str, error: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(status_script(message, error));
    }
}

fn status_script(message: &str, error: bool) -> String {
    let json = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  const message = {json};
  if (window.__pie && typeof window.__pie.status === 'function') {{
    window.__pie.status(message, {error});
    return;
  }}
  const id = 'pie-desktop-status';
  let box = document.getElementById(id);
  if (!box) {{
    box = document.createElement('div');
    box.id = id;
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:24px;right:24px;bottom:24px;z-index:2147483647;padding:14px 18px;border-radius:12px;background:#1b1b1f;color:#f4f4f5;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45);white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.appendChild(box);
  }}
  box.textContent = message;
}})();"#
    )
}
