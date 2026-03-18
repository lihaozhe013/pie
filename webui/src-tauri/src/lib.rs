//! Desktop shell for Pie.
//!
//! The shell owns one child process: the portable `bin/pie.js` launcher, which
//! serves the browser interface on loopback. The webview loads that URL, so the
//! window is the only desktop-specific part. There is no Tauri IPC: the webview
//! gets no capability, no commands, and no way back into Rust.

mod browser;
mod config;
mod http_probe;
#[cfg(target_os = "macos")]
mod menu;
mod node_locator;
mod payload;
mod server;
mod window;

use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};

/// Progress and failure text for the splash page and the runtime overlay.
pub(crate) type Reporter<'a> = &'a dyn Fn(&str, bool);

/// State shared by the launcher thread and the exit path.
pub(crate) struct Shared {
    inner: Mutex<SharedInner>,
}

#[derive(Default)]
struct SharedInner {
    shutting_down: bool,
    server: Option<server::Server>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(SharedInner::default()),
        })
    }

    /// The first caller owns the shutdown; later callers only wait for it.
    pub(crate) fn begin_shutdown(&self) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.shutting_down {
            return false;
        }
        inner.shutting_down = true;
        true
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shutting_down
    }

    pub(crate) fn put_server(&self, server: server::Server) {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .server = Some(server);
    }

    pub(crate) fn take_server(&self) -> Option<server::Server> {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .server
            .take()
    }

    /// A server we started that exited on its own. Adopted servers are not kept
    /// here, so this never reports a server the shell does not own.
    pub(crate) fn poll_exit(&self) -> Option<ExitStatus> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let server = inner.server.as_mut()?;
        server.poll_exit()
    }
}

struct DesktopState(Arc<Shared>);

pub fn run() {
    let shared = Shared::new();
    let startup_shared = shared.clone();
    let state = DesktopState(shared.clone());

    let builder = tauri::Builder::default()
        // Must be registered first: a second launch focuses the existing window
        // instead of starting a second server.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(state);

    // macOS replaces the default menu so About opens the page's own dialog. The
    // shell only evaluates a DOM event: the page gains nothing to call back.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::app_menu).on_menu_event(|app, event| {
        if event.id() == menu::ABOUT_MENU_ID {
            if let Some(window) = app.get_webview_window("main") {
                // A page that has not loaded yet ignores it.
                let _ = window.eval(menu::SHOW_ABOUT_SCRIPT);
            }
        }
    });

    let app = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            let origin: Arc<Mutex<Option<tauri::Url>>> = Arc::new(Mutex::new(None));
            window::create_main(&handle, origin.clone(), startup_shared.clone())?;
            std::thread::Builder::new()
                .name("pie-launcher".into())
                .spawn(move || launch(&handle, &startup_shared, &origin))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the Pie desktop shell");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // A code means the shell asked to exit, so the server is already
            // stopped or being stopped.
            if code.is_some() {
                return;
            }
            api.prevent_exit();
            let state = app_handle.state::<DesktopState>();
            if state.0.begin_shutdown() {
                shutdown_and_exit(app_handle, state.0.clone());
            }
        }
        // Fallback for an exit that did not pass through ExitRequested.
        RunEvent::Exit => {
            let state = app_handle.state::<DesktopState>();
            if let Some(mut server) = state.0.take_server() {
                server.stop();
            }
        }
        _ => {}
    });
}

fn launch(app: &AppHandle, shared: &Arc<Shared>, origin: &Arc<Mutex<Option<tauri::Url>>>) {
    let report = |message: &str, error: bool| window::set_status(app, message, error);
    match server::start(app, shared, origin, &report) {
        Ok(url) => {
            if let Err(error) = window::navigate(app, &url) {
                window::set_status(
                    app,
                    &format!("Could not open the Pie interface: {error}"),
                    true,
                );
            }
        }
        Err(message) => window::set_status(app, &message, true),
    }
}

/// Stop the server away from the UI thread, then end the app.
fn shutdown_and_exit(app: &AppHandle, shared: Arc<Shared>) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("pie-shutdown".into())
        .spawn(move || {
            if let Some(mut server) = shared.take_server() {
                server.stop();
            }
            app.exit(0);
        })
        .expect("could not start the Pie shutdown thread");
}

pub(crate) fn begin_close(app: &AppHandle, shared: &Arc<Shared>) {
    if shared.begin_shutdown() {
        shutdown_and_exit(app, shared.clone());
    }
}
