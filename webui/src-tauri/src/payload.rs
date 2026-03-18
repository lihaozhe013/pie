//! Locate, verify, and unpack the portable payload.

use crate::Reporter;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub sha256: String,
    /// `<version>-<sha12>`; derived when an older manifest omits it.
    #[serde(default)]
    pub key: Option<String>,
}

pub struct Payload {
    /// Directory that contains `bin/pie.js`.
    pub dir: PathBuf,
    /// Payload version, compared against running server records.
    pub version: String,
}

pub fn prepare(app: &tauri::AppHandle, report: Reporter<'_>) -> Result<Payload, String> {
    let source = locate(app)?;

    if source.is_dir() {
        if !source.join("bin").join("pie.js").is_file() {
            return Err(format!(
                "{} does not contain bin/pie.js.",
                source.display()
            ));
        }
        return Ok(Payload {
            version: portable_version(&source).unwrap_or_else(|| "dev".to_string()),
            dir: source,
        });
    }

    let manifest = read_manifest(&source);
    if let Some(manifest) = manifest.as_ref() {
        report("Verifying the server payload\u{2026}", false);
        let digest = sha256(&source)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if !digest.eq_ignore_ascii_case(&manifest.sha256) {
            return Err(format!(
                "The server payload is corrupt (checksum mismatch):\n{}",
                source.display()
            ));
        }
    }

    let runtime = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No writable app data directory: {error}"))?
        .join("runtime");
    let (key, version) = match manifest.as_ref() {
        Some(manifest) => {
            let key = manifest
                .key
                .clone()
                .unwrap_or_else(|| format!("{}-{}", manifest.version, short(&manifest.sha256)));
            (sanitize_key(&key)?, manifest.version.clone())
        }
        None => {
            let stamp = fs::metadata(&source)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            (format!("dev-{stamp}"), "dev".to_string())
        }
    };

    let app_dir = runtime.join(&key).join("pie");
    if app_dir.join("bin").join("pie.js").is_file() {
        cleanup(&runtime, &key);
        return Ok(Payload {
            dir: app_dir,
            version,
        });
    }

    report("Unpacking the server payload\u{2026}", false);
    extract(&source, &runtime, &key)?;
    if !app_dir.join("bin").join("pie.js").is_file() {
        return Err(format!(
            "The unpacked payload is incomplete: {} has no bin/pie.js.",
            app_dir.display()
        ));
    }
    cleanup(&runtime, &key);
    Ok(Payload {
        dir: app_dir,
        version,
    })
}

fn locate(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();

    if let Some(value) = std::env::var_os("PIE_DESKTOP_PAYLOAD") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Ok(path);
        }
        tried.push(path);
    }

    // Bundled apps (macOS, Windows) and hand-made archives place the payload
    // beside the resources or the binary.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    for root in roots {
        for name in ["payload.tar.gz", "payload"] {
            let path = root.join(name);
            if path.exists() {
                return Ok(path);
            }
            tried.push(path);
        }
    }

    Err(format!(
        "The Pie server payload was not found. Looked for:\n{}",
        tried
            .iter()
            .map(|path| format!("  {}", path.display()))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

fn read_manifest(archive: &Path) -> Option<Manifest> {
    let file = archive.parent()?.join("payload.json");
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

fn portable_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("PORTABLE.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

fn short(sha256: &str) -> String {
    sha256.chars().take(12).collect()
}

fn sanitize_key(key: &str) -> Result<String, String> {
    if key.is_empty()
        || !key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '+')
        })
    {
        return Err(format!("Unusable payload key: {key}"));
    }
    Ok(key.to_string())
}

fn sha256(path: &Path) -> std::io::Result<String> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Archive entries may only be relative paths without `..`.
pub fn is_safe_entry(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn extract(archive: &Path, runtime: &Path, key: &str) -> Result<(), String> {
    fs::create_dir_all(runtime)
        .map_err(|error| format!("Could not create {}: {error}", runtime.display()))?;
    let partial = runtime.join(format!(".{key}.partial"));
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;

    let result = (|| -> Result<(), String> {
        let file = File::open(archive)
            .map_err(|error| format!("Could not read {}: {error}", archive.display()))?;
        let decoder = flate2::read::GzDecoder::new(BufReader::new(file));
        let mut tar = tar::Archive::new(decoder);
        let entries = tar
            .entries()
            .map_err(|error| format!("Could not read the payload archive: {error}"))?;
        for entry in entries {
            let mut entry =
                entry.map_err(|error| format!("Could not read the payload archive: {error}"))?;
            let path = entry
                .path()
                .map_err(|error| format!("Could not read a payload entry: {error}"))?
                .into_owned();
            if !is_safe_entry(&path) {
                return Err(format!(
                    "The payload archive contains an unsafe path: {}",
                    path.display()
                ));
            }
            entry
                .unpack_in(&partial)
                .map_err(|error| format!("Could not unpack {}: {error}", path.display()))?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&partial);
        return Err(error);
    }

    let target = runtime.join(key);
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Could not replace {}: {error}", target.display()))?;
    }
    fs::rename(&partial, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&partial);
        format!(
            "Could not finish unpacking into {}: {error}",
            target.display()
        )
    })
}

/// Keep only the current payload. An older directory can belong to a server the
/// shell adopted, so failures are ignored rather than reported.
fn cleanup(runtime: &Path, key: &str) {
    let Ok(entries) = fs::read_dir(runtime) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == key || name.starts_with(&format!(".{key}.partial")) {
            continue;
        }
        let _ = fs::remove_dir_all(entry.path());
    }
}
