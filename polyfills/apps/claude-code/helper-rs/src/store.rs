//! Private, atomic per-view stores, compatible with Playwright storageState.
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const STORE_SAVE_MS: u64 = 20_000;
pub const STORE_SOON_MS: u64 = 1_000;
pub const SCRIPT: &str = include_str!("../js/storage.js");

/// Playwright's storageState cookie representation, including CHIPS.
pub fn cookie_from_cdp(cookie: &Value) -> Value {
    let mut out = serde_json::json!({});
    for key in ["name","value","domain","path","expires","httpOnly","secure"] {
        if let Some(v) = cookie.get(key) { out[key] = v.clone(); }
    }
    out["sameSite"] = cookie.get("sameSite").cloned().unwrap_or(serde_json::json!("Lax"));
    if cookie["partitionKey"].is_object() {
        out["partitionKey"] = cookie["partitionKey"]["topLevelSite"].clone();
        out["_crHasCrossSiteAncestor"] = cookie["partitionKey"]["hasCrossSiteAncestor"].clone();
    }
    out
}

pub fn cookie_to_cdp(cookie: &Value) -> Value {
    let mut out = serde_json::json!({});
    for key in ["name","value","url","domain","path","expires","httpOnly","secure","sameSite"] {
        if let Some(v) = cookie.get(key) { out[key] = v.clone(); }
    }
    if let Some(site) = cookie["partitionKey"].as_str() {
        out["partitionKey"] = serde_json::json!({"topLevelSite":site,
            "hasCrossSiteAncestor":cookie["_crHasCrossSiteAncestor"].as_bool().unwrap_or(true)});
    } else if cookie["partitionKey"].is_object() {
        // Also accept an early Rust-port file with CDP's cookie structure.
        out["partitionKey"] = cookie["partitionKey"].clone();
    }
    out
}

pub fn file_name(server: &str, view: &str) -> String {
    format!("{}.json", &hex::encode(Sha256::digest(format!("{server}\n{view}")))[..32])
}

pub fn private_folder(folder: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder)?;
    let stat = fs::symlink_metadata(folder)?;
    if !stat.is_dir() || stat.file_type().is_symlink() { bail!("not a folder"); }
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: getuid has no preconditions.
        if stat.uid() != unsafe { libc::getuid() } { bail!("owned by someone else"); }
        if stat.mode() & 0o077 != 0 { fs::set_permissions(folder, fs::Permissions::from_mode(0o700))?; }
    }
    Ok(())
}

/// Marks a file the person saved from an app as downloaded from the
/// internet, the way browsers do, so the system treats it as such when it
/// is opened: macOS's `com.apple.quarantine`
/// attribute, which Gatekeeper reads, and Windows' `Zone.Identifier` stream
/// (Mark of the Web, zone 3: the internet). Linux has no such mark.
pub fn mark_downloaded(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let seconds = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
        // flags;time (hex);the agent that saved it; 0081 is a download not yet opened.
        let value = format!("0081;{seconds:08x};mcp-apps-cli;");
        let file = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: both strings are NUL-terminated, and the value's pointer and length match.
        let done = unsafe { libc::setxattr(file.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
        if done != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        fs::write(stream, "[ZoneTransfer]\r\nZoneId=3\r\n")?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = path;
    Ok(())
}

pub fn root() -> Option<PathBuf> {
    let wanted = std::env::var("MCP_APPS_CLI_STORAGE_DIR").unwrap_or_default();
    if wanted == "off" { return None; }
    let path = if !wanted.is_empty() { PathBuf::from(wanted) }
    else if let Ok(data) = std::env::var("CLAUDE_PLUGIN_DATA") { PathBuf::from(data).join("views") }
    else { crate::tmp::home()?.join(".cache").join("mcp-apps-cli").join("views") };
    match private_folder(&path) {
        Ok(()) => Some(path),
        Err(e) => { crate::out::log(format!("view stores off: {}: {e}", path.display())); None }
    }
}

pub fn read(path: &Path) -> Option<Value> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() { return None; }
    let mut data = String::new();
    file.read_to_string(&mut data).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn write(path: &Path, state: &Value) -> Result<()> {
    let empty = state["cookies"].as_array().is_none_or(Vec::is_empty) &&
        state["origins"].as_array().into_iter().flatten().all(|o|
            o["localStorage"].as_array().is_none_or(Vec::is_empty) && o["indexedDB"].as_array().is_none_or(Vec::is_empty));
    if empty { let _ = fs::remove_file(path); return Ok(()); }
    let temp = path.with_extension(format!("json.{}.tmp", crate::tmp::random_hex(8)?));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(state)?)?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

pub fn prune(root: &Path) {
    let oldest = SystemTime::now() - Duration::from_secs(30 * 86400);
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") &&
                fs::symlink_metadata(&path).ok().is_some_and(|m| m.is_file() && m.modified().is_ok_and(|t| t < oldest)) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn names_match_node_and_cannot_escape() {
        assert_eq!(file_name("server", "view"), "4c0382c6eaf5993c7bb0c0ed906a8e9b.json");
        assert_ne!(file_name("a", "x"), file_name("b", "x"));
        assert_eq!(file_name("../../", "/tmp/hack").len(), 37);
    }
    #[test]
    fn cookies_round_trip_node_storage_state() {
        let cookie = json!({"name":"sid","value":"1","domain":"example.com","path":"/","expires":-1,
            "httpOnly":true,"secure":true,"size":4,"session":true,
            "partitionKey":{"topLevelSite":"https://example.com","hasCrossSiteAncestor":false}});
        let saved = cookie_from_cdp(&cookie);
        assert_eq!(saved["partitionKey"],"https://example.com");
        assert_eq!(saved["sameSite"],"Lax");
        assert!(saved.get("session").is_none());
        let restored = cookie_to_cdp(&saved);
        assert_eq!(restored["partitionKey"],cookie["partitionKey"]);
        assert!(restored.get("_crHasCrossSiteAncestor").is_none());
        assert_eq!(restored["expires"],-1);
    }
    #[test]
    fn saved_downloads_are_marked_as_downloaded() {
        let root = std::env::temp_dir().join(format!("rust-download-test-{}", crate::tmp::random_hex(8).unwrap()));
        private_folder(&root).unwrap();
        let file = root.join("report.command");
        fs::write(&file, "#!/bin/sh\necho hi\n").unwrap();
        mark_downloaded(&file).unwrap();
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
            let mut value = [0u8; 256];
            // SAFETY: the buffer's pointer and length match.
            let n = unsafe { libc::getxattr(path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
            assert!(n > 0, "no quarantine attribute");
            let value = String::from_utf8_lossy(&value[..n as usize]).to_string();
            assert!(value.starts_with("0081;") && value.ends_with(";mcp-apps-cli;"), "{value}");
        }
        #[cfg(windows)]
        {
            let mut stream = file.as_os_str().to_owned();
            stream.push(":Zone.Identifier");
            assert!(fs::read_to_string(stream).unwrap().contains("ZoneId=3"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_private_stores() {
        let root = std::env::temp_dir().join(format!("rust-store-test-{}", crate::tmp::random_hex(8).unwrap()));
        private_folder(&root).unwrap();
        let file = root.join(file_name("server", "view"));
        let state = json!({"cookies":[],"origins":[{"origin":"http://example.com","localStorage":[{"name":"n","value":"1"}]}]});
        write(&file, &state).unwrap();
        assert_eq!(read(&file), Some(state));
        #[cfg(unix)] {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            let link = root.join("link"); symlink(&file, &link).unwrap();
            assert!(read(&link).is_none());
            assert!(private_folder(&link).is_err());
        }
        write(&file, &json!({"cookies":[],"origins":[]})).unwrap();
        assert!(!file.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
