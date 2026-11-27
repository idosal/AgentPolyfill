//! Where the helper's own sign-in keeps its tokens, for one server at one url:
//! the macOS Keychain (called directly), a file encrypted with a passphrase
//! (AES-256-GCM, a key from PBKDF2-HMAC-SHA256), or, only when asked, a file
//! only the person can read, not encrypted. macOS only for now: elsewhere only
//! the plain file is offered. There is no silent fall back from one to another.

use std::path::PathBuf;

use anyhow::{Result, bail};
use serde_json::Value;

/// The keychain item's service name; the account is one per server and url.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SERVICE: &str = "mcp-apps-cli";

/// The environment variable the passphrase of an encrypted file is read from
/// where nobody can be asked (a session's helper).
pub const PASSPHRASE_ENV: &str = "MCP_APPS_CLI_PASSPHRASE";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Keychain,
    Encrypted,
    File,
}

impl Kind {
    pub fn parse(word: &str) -> Result<Kind> {
        match word {
            "keychain" => Ok(Kind::Keychain),
            "encrypted" => Ok(Kind::Encrypted),
            "file" => Ok(Kind::File),
            other => bail!("--token-store is \"keychain\", \"encrypted\" or \"file\", not \"{other}\""),
        }
    }

    /// Whether this machine can keep tokens that way (the first two: macOS only for now).
    pub fn available(self) -> bool {
        self == Kind::File || cfg!(target_os = "macos")
    }
}

/// The store the person asked for, if they did: the flag wins over the environment.
pub fn asked(words: &[String]) -> Result<Option<Kind>> {
    let flag = words.iter().position(|w| w == "--token-store").and_then(|i| words.get(i + 1)).cloned();
    flag.or_else(|| std::env::var("MCP_APPS_CLI_TOKEN_STORE").ok().filter(|v| !v.is_empty())).map(|v| Kind::parse(&v)).transpose()
}

/// Where logins are kept: the same for every server, set once with `--token-store`
/// or `MCP_APPS_CLI_TOKEN_STORE`; else the Keychain where there is one, else a file.
pub fn chosen(words: &[String]) -> Result<Kind> {
    Ok(asked(words)?.unwrap_or(if Kind::Keychain.available() { Kind::Keychain } else { Kind::File }))
}

/// The folder for the files: `$MCP_APPS_CLI_OAUTH_DIR` if it is set (the
/// tests use it), else `~/.cache/mcp-apps-cli/oauth`.
fn folder() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MCP_APPS_CLI_OAUTH_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    crate::tmp::home().map(|home| home.join(".cache").join("mcp-apps-cli").join("oauth"))
}

#[derive(Clone, Debug)]
pub enum Place {
    Keychain(String),
    Encrypted(PathBuf, String),
    File(PathBuf),
}

impl Place {
    /// How this place keeps the login.
    pub fn kind(&self) -> Kind {
        match self {
            Place::Keychain(_) => Kind::Keychain,
            Place::Encrypted(..) => Kind::Encrypted,
            Place::File(_) => Kind::File,
        }
    }

    /// The place of `kind` for one server at one url; `passphrase` is for an encrypted file.
    pub fn of(kind: Kind, name: &str, url: &str, passphrase: Option<String>) -> Option<Place> {
        let account = crate::store::file_name(name, url);
        match kind {
            Kind::Keychain => Some(Place::Keychain(account)),
            Kind::Encrypted => folder().map(|f| Place::Encrypted(f.join(format!("{account}.enc")), passphrase.unwrap_or_default())),
            Kind::File => folder().map(|f| Place::File(f.join(account))),
        }
    }

    /// Where the tokens are, in words the person reads.
    pub fn describe(&self) -> String {
        match self {
            Place::Keychain(_) => "the macOS Keychain".to_string(),
            Place::Encrypted(path, _) => format!("a file encrypted with your passphrase: {}", path.display()),
            Place::File(path) => format!("a plain file, not encrypted: {}", path.display()),
        }
    }

    /// The same, short, for the line that says the sign-in is done.
    pub fn short(&self) -> &'static str {
        match self {
            Place::Keychain(_) => "macOS Keychain",
            Place::Encrypted(..) => "encrypted file",
            Place::File(_) => "plain file",
        }
    }

    pub fn read(&self) -> Result<Option<Value>> {
        match self {
            Place::File(path) => Ok(crate::store::read(path)),
            Place::Keychain(account) => match keychain_get(account)? {
                Some(text) => Ok(serde_json::from_str(&text).ok()),
                None => Ok(None),
            },
            Place::Encrypted(path, passphrase) => match crate::store::read(path) {
                None => Ok(None),
                Some(wrapped) => {
                    if passphrase.is_empty() {
                        bail!("this sign-in is in a file encrypted with a passphrase: set {PASSPHRASE_ENV} in the environment you start Claude Code from");
                    }
                    Ok(Some(open(&wrapped, passphrase)?))
                }
            },
        }
    }

    pub fn write(&self, value: &Value) -> Result<()> {
        match self {
            Place::File(path) => crate::store::write_json(path, value),
            Place::Keychain(account) => keychain_set(account, &value.to_string()),
            Place::Encrypted(path, passphrase) => crate::store::write_json(path, &seal(value, passphrase)?),
        }
    }

    pub fn delete(&self) -> Result<()> {
        match self {
            Place::File(path) | Place::Encrypted(path, _) => match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
            Place::Keychain(account) => keychain_delete(account),
        }
    }

    /// Whether tokens are kept here (an encrypted file counts without being opened).
    pub fn exists(&self) -> bool {
        match self {
            Place::File(path) | Place::Encrypted(path, _) => path.is_file(),
            Place::Keychain(_) => matches!(self.read(), Ok(Some(_))),
        }
    }
}

/// Where a sign-in to one server at one url is kept, if there is one: the
/// Keychain, then an encrypted file, then a plain file (unless only the file
/// store was asked for, as the tests do).
pub fn kept(name: &str, url: &str) -> Option<Place> {
    let passphrase = std::env::var(PASSPHRASE_ENV).ok();
    let file_only = std::env::var("MCP_APPS_CLI_TOKEN_STORE").is_ok_and(|v| v == "file");
    let kinds: &[Kind] = if file_only { &[Kind::File] } else { &[Kind::Keychain, Kind::Encrypted, Kind::File] };
    kinds.iter().filter(|k| k.available()).filter_map(|k| Place::of(*k, name, url, passphrase.clone())).find(Place::exists)
}

/// Refuses early, and says what to do, if `kind` can't be used here.
pub fn usable(kind: Kind) -> Result<()> {
    if !kind.available() {
        bail!("keeping the login safely (Keychain, encrypted file) is only done on macOS for now; Linux and Windows may follow. To keep it in a plain file instead, add `--token-store file`.");
    }
    if kind == Kind::Keychain {
        let probe = Place::Keychain(format!("probe-{}", std::process::id()));
        probe.write(&serde_json::json!("probe")).and_then(|()| probe.delete()).map_err(|why| {
            anyhow::anyhow!("the macOS Keychain isn't available here ({why}). Use `--token-store encrypted` (a file protected by a passphrase), or `--token-store file` (plain file, not encrypted).")
        })?;
    }
    Ok(())
}

/// A passphrase worth having: not a few letters.
pub fn check_passphrase(passphrase: &str) -> Result<()> {
    if passphrase.chars().count() < 8 {
        bail!("the passphrase needs at least 8 characters");
    }
    Ok(())
}

/// Reads a passphrase from the terminal without showing it.
#[cfg(unix)]
pub fn prompt_passphrase(text: &str) -> Result<String> {
    use std::io::{BufRead, Write};
    print!("{text}");
    std::io::stdout().flush()?;
    // SAFETY: plain termios calls on stdin; the old settings are put back.
    let saved = unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) == 0 {
            let mut quiet = t;
            quiet.c_lflag &= !libc::ECHO;
            libc::tcsetattr(0, libc::TCSANOW, &quiet);
            Some(t)
        } else {
            None
        }
    };
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line);
    if let Some(t) = saved {
        // SAFETY: restores what tcgetattr gave.
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &t) };
        println!();
    }
    read?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(not(unix))]
pub fn prompt_passphrase(_text: &str) -> Result<String> {
    bail!("a passphrase can't be typed here: set {PASSPHRASE_ENV}")
}

// ---- the encrypted file ----

#[cfg(target_os = "macos")]
const ROUNDS: u32 = 600_000;

#[cfg(target_os = "macos")]
fn random(n: usize) -> Result<Vec<u8>> {
    Ok(hex::decode(crate::tmp::random_hex(n)?)?)
}

#[cfg(target_os = "macos")]
fn derive(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    pbkdf2::pbkdf2_hmac_array::<sha2::Sha256, 32>(passphrase.as_bytes(), salt, ROUNDS)
}

/// The tokens, encrypted: `{"v":1,"salt","nonce","data"}`, each in base64.
#[cfg(target_os = "macos")]
fn seal(value: &Value, passphrase: &str) -> Result<Value> {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    let (salt, nonce) = (random(16)?, random(12)?);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&derive(passphrase, &salt)).map_err(|e| anyhow::anyhow!("{e}"))?;
    let nonce_value = aes_gcm::Nonce::try_from(nonce.as_slice()).map_err(|_| anyhow::anyhow!("nonce"))?;
    let data = cipher.encrypt(&nonce_value, value.to_string().as_bytes()).map_err(|_| anyhow::anyhow!("encrypting the tokens failed"))?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(serde_json::json!({"v": 1, "salt": b64.encode(salt), "nonce": b64.encode(nonce), "data": b64.encode(data)}))
}

#[cfg(target_os = "macos")]
fn open(wrapped: &Value, passphrase: &str) -> Result<Value> {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let field = |name: &str| -> Result<Vec<u8>> { Ok(b64.decode(wrapped[name].as_str().unwrap_or_default())?) };
    let (salt, nonce, data) = (field("salt")?, field("nonce")?, field("data")?);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&derive(passphrase, &salt)).map_err(|e| anyhow::anyhow!("{e}"))?;
    let nonce_value = aes_gcm::Nonce::try_from(nonce.as_slice()).map_err(|_| anyhow::anyhow!("the encrypted sign-in is damaged"))?;
    let plain = cipher.decrypt(&nonce_value, data.as_slice()).map_err(|_| anyhow::anyhow!("wrong passphrase (or the file is damaged)"))?;
    Ok(serde_json::from_slice(&plain)?)
}

#[cfg(not(target_os = "macos"))]
fn seal(_: &Value, _: &str) -> Result<Value> {
    bail!("encrypted files are only done on macOS for now")
}

#[cfg(not(target_os = "macos"))]
fn open(_: &Value, _: &str) -> Result<Value> {
    bail!("encrypted files are only done on macOS for now")
}

// ---- the macOS Keychain, called directly (Security.framework) ----

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    pub const NOT_FOUND: i32 = -25300;
    pub const DUPLICATE: i32 = -25299;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        pub fn SecKeychainAddGenericPassword(keychain: *const c_void, service_len: u32, service: *const c_char, account_len: u32, account: *const c_char, password_len: u32, password: *const c_void, item: *mut *const c_void) -> i32;
        pub fn SecKeychainFindGenericPassword(keychain: *const c_void, service_len: u32, service: *const c_char, account_len: u32, account: *const c_char, password_len: *mut u32, password: *mut *mut c_void, item: *mut *const c_void) -> i32;
        pub fn SecKeychainItemModifyAttributesAndData(item: *const c_void, attributes: *const c_void, length: u32, data: *const c_void) -> i32;
        pub fn SecKeychainItemDelete(item: *const c_void) -> i32;
        pub fn SecKeychainItemFreeContent(attributes: *const c_void, data: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFRelease(item: *const c_void);
    }
}

#[cfg(target_os = "macos")]
fn status(what: &str, code: i32) -> Result<()> {
    if code == 0 { Ok(()) } else { bail!("the Keychain refused to {what} (error {code})") }
}

/// The item for `account`: its password (if asked) and a reference to release.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn keychain_find(account: &str, want_password: bool) -> Result<Option<(Option<String>, *const std::ffi::c_void)>> {
    use std::ffi::c_void;
    let (mut length, mut data, mut item): (u32, *mut c_void, *const c_void) = (0, std::ptr::null_mut(), std::ptr::null());
    // SAFETY: lengths match the buffers; outputs are released below.
    let code = unsafe {
        mac::SecKeychainFindGenericPassword(std::ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr().cast(), account.len() as u32, account.as_ptr().cast(), &mut length, &mut data, &mut item)
    };
    if code == mac::NOT_FOUND {
        return Ok(None);
    }
    status("read the tokens", code)?;
    let password = want_password.then(|| {
        // SAFETY: the Keychain returned `length` bytes at `data`.
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) }).to_string()
    });
    // SAFETY: frees what the find call allocated.
    unsafe { mac::SecKeychainItemFreeContent(std::ptr::null(), data) };
    Ok(Some((password, item)))
}

#[cfg(target_os = "macos")]
fn keychain_get(account: &str) -> Result<Option<String>> {
    match keychain_find(account, true)? {
        Some((password, item)) => {
            // SAFETY: the item reference is ours to release.
            unsafe { mac::CFRelease(item) };
            Ok(password)
        }
        None => Ok(None),
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn keychain_set(account: &str, secret: &str) -> Result<()> {
    // SAFETY: lengths match the buffers.
    let code = unsafe {
        mac::SecKeychainAddGenericPassword(std::ptr::null(), SERVICE.len() as u32, SERVICE.as_ptr().cast(), account.len() as u32, account.as_ptr().cast(), secret.len() as u32, secret.as_ptr().cast(), std::ptr::null_mut())
    };
    if code != mac::DUPLICATE {
        return status("keep the tokens", code);
    }
    let Some((_, item)) = keychain_find(account, false)? else { bail!("the Keychain item went away") };
    // SAFETY: `item` is a live reference; released after.
    let code = unsafe { mac::SecKeychainItemModifyAttributesAndData(item, std::ptr::null(), secret.len() as u32, secret.as_ptr().cast()) };
    unsafe { mac::CFRelease(item) };
    status("update the tokens", code)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn keychain_delete(account: &str) -> Result<()> {
    let Some((_, item)) = keychain_find(account, false)? else { return Ok(()) };
    // SAFETY: `item` is a live reference; released after.
    let code = unsafe { mac::SecKeychainItemDelete(item) };
    unsafe { mac::CFRelease(item) };
    status("delete the tokens", code)
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(_: &str) -> Result<Option<String>> {
    bail!("the Keychain is only used on macOS")
}
#[cfg(not(target_os = "macos"))]
fn keychain_set(_: &str, _: &str) -> Result<()> {
    bail!("the Keychain is only used on macOS")
}
#[cfg(not(target_os = "macos"))]
fn keychain_delete(_: &str) -> Result<()> {
    bail!("the Keychain is only used on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The store the person asked for: nothing unless they say; the flag wins; anything else is refused.
    #[test]
    fn the_token_store_is_asked_for_by_flag_or_environment() {
        let words = |text: &str| text.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        // SAFETY: the only test that sets it.
        unsafe { std::env::remove_var("MCP_APPS_CLI_TOKEN_STORE") };
        assert_eq!(asked(&words("h signin demo")).unwrap(), None);
        assert_eq!(asked(&words("h signin demo --token-store keychain")).unwrap(), Some(Kind::Keychain));
        assert_eq!(asked(&words("h signin demo --token-store encrypted")).unwrap(), Some(Kind::Encrypted));
        assert_eq!(asked(&words("h signin demo --token-store file")).unwrap(), Some(Kind::File));
        assert!(asked(&words("h signin demo --token-store usb")).is_err());
        unsafe { std::env::set_var("MCP_APPS_CLI_TOKEN_STORE", "file") };
        assert_eq!(asked(&words("h signin demo")).unwrap(), Some(Kind::File));
        assert_eq!(asked(&words("h signin demo --token-store keychain")).unwrap(), Some(Kind::Keychain));
        unsafe { std::env::remove_var("MCP_APPS_CLI_TOKEN_STORE") };
    }

    #[test]
    fn a_short_passphrase_is_refused() {
        assert!(check_passphrase("short").is_err());
        assert!(check_passphrase("long enough").is_ok());
    }

    // The encrypted file: round trip, a wrong passphrase, and nothing readable in the file.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_encrypted_file_opens_only_with_its_passphrase() {
        let dir = std::env::temp_dir().join(format!("mcp-apps-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::store::private_folder(&dir).unwrap();
        let path = dir.join("one.enc");
        let value = serde_json::json!({"client_id": "c", "token_response": {"access_token": "SECRET-TOKEN-VALUE", "refresh_token": "r"}});
        let place = Place::Encrypted(path.clone(), "correct horse".to_string());
        place.write(&value).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("SECRET-TOKEN-VALUE") && !on_disk.contains("client_id"), "{on_disk}");
        assert_eq!(place.read().unwrap(), Some(value.clone()));
        let wrong = Place::Encrypted(path.clone(), "battery staple".to_string()).read().unwrap_err().to_string();
        assert!(wrong.contains("wrong passphrase"), "{wrong}");
        let none = Place::Encrypted(path.clone(), String::new()).read().unwrap_err().to_string();
        assert!(none.contains(PASSPHRASE_ENV), "{none}");
        // Two writes of the same tokens don't give the same file (fresh salt and nonce).
        place.write(&value).unwrap();
        assert_ne!(std::fs::read_to_string(&path).unwrap(), on_disk);
        place.delete().unwrap();
        assert!(!place.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Uses the login Keychain of the machine it runs on, so it only runs when asked: `cargo test -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "uses the macOS Keychain"]
    fn tokens_round_trip_through_the_macos_keychain() {
        let place = Place::of(Kind::Keychain, "demo", &format!("https://example.com/{}", std::process::id()), None).unwrap();
        assert!(!place.exists());
        let value = serde_json::json!({"client_id": "c", "token_response": {"access_token": "a".repeat(3000), "refresh_token": "r"}});
        place.write(&value).expect("the Keychain keeps the tokens");
        assert_eq!(place.read().unwrap(), Some(value));
        // Written again: updated, not refused as a duplicate.
        let again = serde_json::json!({"client_id": "d"});
        place.write(&again).unwrap();
        assert_eq!(place.read().unwrap(), Some(again));
        place.delete().unwrap();
        assert!(!place.exists());
        place.delete().expect("deleting what is gone is not an error");
    }
}
