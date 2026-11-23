//! Chrome for Testing's headless shell, fetched for the person where no
//! Chromium browser is installed and they said yes (the mod asks first): the
//! current Stable, named by Google's own version list and downloaded from
//! Google's own storage (both hosts pinned, HTTPS only), unzipped into the
//! plugin's data folder (`browsers/`). It doesn't update itself, so while it's
//! the one in use the helper looks for a newer Stable at most once a day and
//! fetches it for the next launch.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;

use crate::out::log;

const VERSIONS_URL: &str = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const DOWNLOAD_HOST: &str = "storage.googleapis.com";
/// A download larger than this is refused (the shell's zip is about 100–130 MB).
const MAX_BYTES: u64 = 400 * 1024 * 1024;
/// How often a fetched shell in use is checked against the current Stable.
const CHECK_EVERY_S: u64 = 24 * 60 * 60;

/// Where fetched shells are kept: the plugin's data folder, else the helper's cache.
pub fn dir() -> Option<PathBuf> {
    if let Ok(data) = std::env::var("CLAUDE_PLUGIN_DATA") {
        return Some(PathBuf::from(data).join("browsers"));
    }
    Some(crate::tmp::home()?.join(".cache").join("mcp-apps-cli").join("browsers"))
}

/// Chrome for Testing's name for this machine, if it builds the shell for it.
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("mac-arm64"),
        ("macos", "x86_64") => Some("mac-x64"),
        ("linux", "x86_64") => Some("linux64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win64"),
        _ => None,
    }
}

/// A version as Chrome for Testing writes one: four numbers, dot-separated.
/// Nothing else names a folder (a tampered list's "../.ssh" would).
pub fn is_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The current Stable's version and its shell's download for `platform`:
/// only Chrome for Testing's own bucket and path for that version and
/// platform, over HTTPS (Google's storage host serves every public bucket).
pub fn pick(versions: &Value, platform: &str) -> Option<(String, String)> {
    let stable = &versions["channels"]["Stable"];
    let version = stable["version"].as_str()?.to_string();
    if !is_version(&version) { return None; }
    let url = stable["downloads"]["chrome-headless-shell"].as_array()?
        .iter()
        .find(|d| d["platform"] == platform)?["url"].as_str()?.to_string();
    let parsed = url::Url::parse(&url).ok()?;
    let path = format!("/chrome-for-testing-public/{version}/{platform}/chrome-headless-shell-{platform}.zip");
    (parsed.scheme() == "https" && parsed.host_str() == Some(DOWNLOAD_HOST) && parsed.port().is_none()
        && parsed.path() == path && parsed.query().is_none() && parsed.fragment().is_none())
        .then_some((version, url))
}

/// The shell's binary inside a version's folder.
pub fn binary_in(version_dir: &Path, platform: &str) -> PathBuf {
    let name = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    version_dir.join(format!("chrome-headless-shell-{platform}")).join(name)
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build()?)
}

async fn current_stable(platform: &str) -> Result<(String, String)> {
    let text = client()?.get(VERSIONS_URL).send().await?.error_for_status()?.text().await?;
    let versions: Value = serde_json::from_str(&text).context("Chrome for Testing's version list")?;
    pick(&versions, platform).ok_or_else(|| anyhow!("no headless shell for {platform} in Chrome for Testing's Stable"))
}

/// Fetches the current Stable's shell unless it's already here; its binary and version.
pub async fn fetch() -> Result<(PathBuf, String)> {
    let platform = platform().ok_or_else(|| anyhow!("Chrome for Testing has no headless shell for this machine"))?;
    let root = dir().ok_or_else(|| anyhow!("no folder to keep a browser in"))?;
    crate::store::private_folder(&root)?;
    let (version, url) = current_stable(platform).await?;
    // pick() took only a version of numbers; checked again where it names folders.
    if !is_version(&version) { bail!("Chrome for Testing's list names an odd version"); }
    let target = root.join(&version);
    let binary = binary_in(&target, platform);
    if binary.is_file() { return Ok((binary, version)); }
    log(format!("fetching Chrome for Testing's headless shell {version} for app views"));
    let zip = root.join(format!(".download-{version}.zip"));
    let unpacked = root.join(format!(".unpack-{version}"));
    let result = async {
        let mut response = client()?.get(&url).send().await?.error_for_status()?;
        if response.content_length().is_some_and(|n| n > MAX_BYTES) { bail!("the download is larger than expected"); }
        let mut file = tokio::fs::File::create(&zip).await?;
        let mut got: u64 = 0;
        while let Some(chunk) = response.chunk().await? {
            got += chunk.len() as u64;
            if got > MAX_BYTES { bail!("the download is larger than expected"); }
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        }
        tokio::io::AsyncWriteExt::flush(&mut file).await?;
        drop(file);
        let _ = std::fs::remove_dir_all(&unpacked);
        std::fs::create_dir_all(&unpacked)?;
        // The system's own unzip (tar on Windows); neither writes outside the folder.
        let status = if cfg!(windows) {
            std::process::Command::new("tar").arg("-xf").arg(&zip).arg("-C").arg(&unpacked).status()?
        } else {
            std::process::Command::new("unzip").arg("-q").arg("-o").arg(&zip).arg("-d").arg(&unpacked).status()?
        };
        if !status.success() { bail!("unpacking the download failed"); }
        if !binary_in(&unpacked, platform).is_file() { bail!("the download doesn't hold the headless shell"); }
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&unpacked, &target)?;
        if crate::chrome::shell_major(&binary).is_none() { bail!("the fetched headless shell doesn't run"); }
        Ok(())
    }.await;
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_dir_all(&unpacked);
    result?;
    // Older ones go.
    for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name != version && !name.starts_with('.') && entry.path().is_dir() { let _ = std::fs::remove_dir_all(entry.path()); }
    }
    Ok((binary, version))
}

/// While a fetched shell is the one in use: at most daily, a newer Stable is
/// fetched for the next launch (the person said yes to keeping it current).
pub fn keep_current(in_use: &Path) {
    let Some(root) = dir() else { return };
    if !in_use.starts_with(&root) { return; }
    let stamp = root.join(".checked");
    let fresh = std::fs::metadata(&stamp).and_then(|m| m.modified()).ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age.as_secs() < CHECK_EVERY_S);
    if fresh { return; }
    let _ = std::fs::write(&stamp, b"");
    tokio::spawn(async move {
        if let Err(error) = fetch().await { log(format!("keeping the headless shell current: {error:#}")); }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-headless-shell-mac-arm64.zip";

    fn list(version: &str, url: &str) -> Value {
        serde_json::json!({"channels": {"Stable": {"version": version, "downloads": {"chrome-headless-shell": [
            {"platform": "mac-arm64", "url": url},
            {"platform": "linux64", "url": "https://storage.googleapis.com/x/linux64.zip"},
        ]}}}})
    }

    #[test]
    fn only_chrome_for_testings_own_download_over_https_is_taken() {
        assert_eq!(pick(&list("158.0.8127.36", GOOD), "mac-arm64").unwrap().0, "158.0.8127.36");
        let refused = |url: &str| pick(&list("158.0.8127.36", url), "mac-arm64").is_none();
        assert!(refused(&GOOD.replace("https:", "http:")), "not HTTPS");
        assert!(refused("https://example.com/chrome-for-testing-public/158.0.8127.36/mac-arm64/chrome-headless-shell-mac-arm64.zip"), "not Google's storage");
        assert!(refused(&GOOD.replace("storage.googleapis.com", "storage.googleapis.com.example.com")), "a look-alike host");
        assert!(refused(&GOOD.replace("chrome-for-testing-public", "someone-elses-bucket")), "another bucket on the same host");
        assert!(refused(&GOOD.replace("/158.0.8127.36/", "/157.0.1.2/")), "another version's file");
        assert!(refused(&GOOD.replace("mac-arm64.zip", "mac-x64.zip")), "another platform's file");
        assert!(refused(&format!("{GOOD}?x=1")), "with a query");
        assert!(refused(&GOOD.replace("storage.googleapis.com", "storage.googleapis.com:8443")), "another port");
        assert!(pick(&list("158.0.8127.36", "https://storage.googleapis.com/x/linux64.zip"), "linux64").is_none(), "the bucket's root");
        assert!(pick(&list("158.0.8127.36", GOOD), "win64").is_none(), "no build for that platform");
    }

    #[test]
    fn a_version_that_isnt_four_numbers_never_names_a_folder() {
        for bad in ["../../.ssh", "/etc", "158.0.8127", "158.0.8127.36.1", "158.0.8127.x", "", "158..8127.36", "158.0.8127.36/../.."] {
            assert!(!is_version(bad), "{bad}");
            assert!(pick(&list(bad, GOOD), "mac-arm64").is_none(), "{bad}");
        }
        assert!(is_version("158.0.8127.36"));
    }
}
