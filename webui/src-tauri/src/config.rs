//! The hand-edited shell settings file. Nothing in the UI writes it, so a broken
//! file only ever falls back to defaults instead of blocking startup.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Default, Deserialize)]
pub struct DesktopConfig {
    /// Node.js binary to use instead of the discovered one.
    #[serde(rename = "nodePath")]
    pub node_path: Option<String>,
    /// Preferred server port; the shell still falls back when it is taken.
    pub port: Option<u16>,
}

impl DesktopConfig {
    pub fn node_path(&self) -> Option<PathBuf> {
        let value = self.node_path.as_deref()?.trim();
        if value.is_empty() {
            return None;
        }
        Some(PathBuf::from(value))
    }
}

pub fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("desktop.json"))
}

pub fn read(app: &tauri::AppHandle) -> DesktopConfig {
    path(app).map(|file| read_file(&file)).unwrap_or_default()
}

pub fn read_file(file: &Path) -> DesktopConfig {
    let Ok(text) = std::fs::read_to_string(file) else {
        return DesktopConfig::default();
    };
    match serde_json::from_str(&text) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[pie-desktop] ignoring {}: {error}", file.display());
            DesktopConfig::default()
        }
    }
}
