//! The helper's own sign-in (OAuth) for a server that needs it: off unless the
//! person lists the server under "Own sign-in (OAuth)" in `/config` and runs
//! `signin <server>`.
//!
//! The helper's connection to a server is a second one (Claude Code gives a
//! plugin neither a tool's UI metadata nor its own connection), so Claude
//! Code's sign-in is not on it, and the helper never reads Claude Code's
//! stored credentials (docs/polyfill-contract.md, 6). What it can do, for a
//! server the person chose, is sign in itself, with the MCP authorization
//! spec's flow as rmcp implements it (protected resource metadata, dynamic
//! client registration, authorization code with PKCE, refresh). That is a
//! second grant, with its own life, so each step is the person's:
//!
//! - `mcp-apps-cli-helper signin <server>` says what that means, asks to
//!   continue (default no), opens the person's browser at the server's
//!   authorization page, takes the answer on a loopback address of its own,
//!   and keeps the tokens (and the client the server registered) in a file
//!   only the person can read (`folder`);
//! - `mcp-apps-cli-helper signout <server>` asks the server to revoke the
//!   tokens where it offers that (RFC 7009) and deletes the file;
//! - the mod tells the helper, with each request that names a server, whether
//!   the person listed it; only then does the helper's connection carry the
//!   token (refreshed by rmcp when it ends). Nothing is written to Claude
//!   Code's files.
//!
//! The helper uses it only for a server it may already use (config.rs), and
//! only over `https` or to a loopback address.

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use rmcp::transport::auth::{AuthClient, AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore, StoredCredentials};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// How long `signin` waits for the person to answer in the browser.
const WAIT: Duration = Duration::from_secs(300);

/// The one folder sign-ins are kept in: `$MCP_APPS_CLI_OAUTH_DIR` if it is
/// set (the tests use it), else `~/.cache/mcp-apps-cli/oauth`.
fn folder() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MCP_APPS_CLI_OAUTH_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    crate::tmp::home().map(|home| home.join(".cache").join("mcp-apps-cli").join("oauth"))
}

/// The file for one server at one url, so a token is never used for another url.
fn file(name: &str, url: &str) -> Option<PathBuf> {
    folder().map(|folder| folder.join(crate::store::file_name(name, url)))
}

/// The file a sign-in to one server at one url was kept in, if there is one.
fn kept_file(name: &str, url: &str) -> Option<PathBuf> {
    file(name, url).filter(|path| path.is_file())
}

/// The tokens of one server, in a file only the person can read.
struct FileStore {
    path: PathBuf,
}

fn failed(error: impl std::fmt::Display) -> AuthError {
    AuthError::CredentialStoreError(error.to_string())
}

#[async_trait]
impl CredentialStore for FileStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        match crate::store::read(&self.path) {
            Some(value) => serde_json::from_value(value).map(Some).map_err(failed),
            None => Ok(None),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        crate::store::write_json(&self.path, &serde_json::to_value(&credentials).map_err(failed)?).map_err(failed)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(failed(e)),
            _ => Ok(()),
        }
    }
}

/// A url the helper may sign in to or send a token to: `https`, or an address
/// on this machine itself (a token never travels in the clear over a network).
pub fn allowed(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            || (u.scheme() == "http"
                && match u.host() {
                    Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost"),
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    None => false,
                })
    })
}

/// The client for `name` at `url`, carrying its token and refreshing it, if
/// the person signed in to it with `signin` (the caller has checked that they
/// listed the server).
pub async fn client(name: &str, url: &str) -> Result<Option<AuthClient<reqwest::Client>>> {
    if !allowed(url) {
        return Ok(None);
    }
    let Some(path) = kept_file(name, url) else { return Ok(None) };
    let mut manager = AuthorizationManager::new(url).await.map_err(|e| anyhow!("{e}"))?;
    manager.set_credential_store(FileStore { path });
    if !manager.initialize_from_store().await.map_err(|e| anyhow!("{e}"))? {
        return Ok(None);
    }
    // No redirect is followed: the token goes to the server's own url only.
    let http = reqwest::Client::builder().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).build()?;
    Ok(Some(AuthClient::new(http, manager)))
}

/// Signs in to `name` at `url`: `show` is given the address the person opens
/// (the CLI prints it and tries the browser). Returns when the tokens are kept.
pub async fn signin(name: &str, url: &str, show: impl FnOnce(&str)) -> Result<()> {
    if !allowed(url) {
        bail!("\"{name}\" is at {url}: the helper signs in only to an https address, or one on this machine");
    }
    let path = file(name, url).context("no folder to keep the sign-in in")?;
    crate::store::private_folder(path.parent().context("no folder to keep the sign-in in")?)?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());
    let mut manager = AuthorizationManager::new(url).await.map_err(|e| anyhow!("{e}"))?;
    manager.set_credential_store(FileStore { path });
    let found = manager.resolve_metadata().await.map_err(|e| anyhow!("the server's sign-in page was not found: {e}"))?;
    manager.set_metadata(found.metadata);
    let request = AuthorizationRequest::new(redirect.clone()).with_client_name("mcp-apps-cli");
    let session = AuthorizationSession::new(manager, request).await.map_err(|(_, e)| anyhow!("{e}"))?;
    show(&session.auth_url);
    let callback = tokio::time::timeout(WAIT, wait_for_callback(&listener)).await.map_err(|_| anyhow!("nobody answered in the browser"))??;
    session.handle_callback_url(&format!("http://127.0.0.1:{}{callback}", listener.local_addr()?.port())).await.map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

/// The request target (`/callback?code=…&state=…`) of the browser's return.
async fn wait_for_callback(listener: &TcpListener) -> Result<String> {
    loop {
        let (mut stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let mut head = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut head)).await.ok().and_then(Result::ok).unwrap_or(0);
        let text = String::from_utf8_lossy(&head[..n]).to_string();
        let target = text.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split_whitespace().next()).unwrap_or("").to_string();
        let ours = target.starts_with("/callback?");
        let body = if ours { "<!doctype html><title>Signed in</title><p>Signed in. You can close this tab." } else { "" };
        let status = if ours { "200 OK" } else { "404 Not Found" };
        let _ = stream
            .write_all(format!("HTTP/1.1 {status}\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .await;
        if ours {
            if target.contains("error=") {
                bail!("the server refused the sign-in: {target}");
            }
            return Ok(target);
        }
    }
}

/// The server `signin` or `signout` is about, and its url.
fn target(args: &crate::Args, words: &[String]) -> Result<(String, String)> {
    let name = words.get(2).filter(|w| !w.starts_with("--")).with_context(|| format!("usage: mcp-apps-cli-helper {} <server>", words[1]))?;
    let cwd = args.cwd.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let entry = crate::config::resolve(args, &cwd, name).map_err(|why| anyhow!("not using MCP server \"{name}\": {why}"))?;
    let url = entry.config["url"].as_str().context("only a server reached by a url needs sign-in")?.to_string();
    Ok((name.clone(), url))
}

/// What `signin` says before it opens the browser.
fn notice(name: &str, url: &str, path: &str) -> String {
    format!(
        "This signs the helper in to \"{name}\" ({url}) on its own.\n\
         It is not Claude Code's sign-in, which the helper never reads.\n\
         \n\
         \x20 - A second grant. The server registers \"mcp-apps-cli\" as a new client and\n\
         \x20   shows its own consent screen. Claude Code's `/mcp` neither lists this\n\
         \x20   grant nor clears it, and your organisation's MCP sign-in settings don't\n\
         \x20   apply to it.\n\
         \x20 - Kept on this machine. The access and refresh tokens go in one file only\n\
         \x20   you can read, not encrypted:\n\
         \x20   {path}\n\
         \x20   The helper refreshes them until you sign out.\n\
         \x20 - To end it: `mcp-apps-cli-helper signout {name}` deletes the file and asks\n\
         \x20   the server to revoke the tokens where it offers that. You can also remove\n\
         \x20   \"mcp-apps-cli\" from the server's list of connected apps.\n"
    )
}

/// `mcp-apps-cli-helper signin <server> [--yes] [--mcp-config …] [--cwd …]`
pub async fn cli(args: crate::Args, words: &[String]) -> Result<()> {
    let (name, url) = target(&args, words)?;
    let name = name.as_str();
    let path = file(name, &url).context("no folder to keep the sign-in in")?;
    let shown = path.display().to_string();
    println!("{}", notice(name, &url, &shown));
    // `--yes`, or `MCP_APPS_CLI_SIGNIN_YES=1` for someone who always wants it
    // (a terminal can't read /config): the text above is still shown.
    let assumed = words.iter().any(|w| w == "--yes") || std::env::var("MCP_APPS_CLI_SIGNIN_YES").is_ok_and(|v| !v.is_empty() && v != "0");
    if !assumed {
        if !std::io::stdin().is_terminal() {
            bail!("signin asks a question: run it in a terminal, or pass --yes (or set MCP_APPS_CLI_SIGNIN_YES=1)");
        }
        print!("Continue? [y/N] ");
        std::io::stdout().flush()?;
        let mut answer = String::new();
        std::io::stdin().lock().read_line(&mut answer)?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("Not signed in to {name}. Nothing was kept.");
            return Ok(());
        }
    }
    println!();
    signin(name, &url, |address| {
        println!("Open this address to sign in to {name}:\n{address}");
        if std::env::var_os("MCP_APPS_CLI_NO_BROWSER").is_none() {
            open_browser(address);
        }
    })
    .await?;
    println!("\nSigned in to {name}.\nTokens kept in {shown}\nSign out with: mcp-apps-cli-helper signout {name}");
    // From a terminal the helper can't read /config, so it can't know.
    println!("If \"{name}\" isn't listed under \"Own sign-in (OAuth)\" in /config yet, add it there: the next tool call then shows the app.");
    Ok(())
}

/// Asks the server to revoke the tokens in `path` (RFC 7009): what to say about it.
async fn revoke(name: &str, url: &str, path: &std::path::Path) -> String {
    let none = format!("{name} offers no way to revoke from here: remove \"mcp-apps-cli\" in its connected apps.");
    let Some(kept) = crate::store::read(path) else { return none };
    let attempt = async {
        let manager = AuthorizationManager::new(url).await.map_err(|e| anyhow!("{e}"))?;
        let found = manager.resolve_metadata().await.map_err(|e| anyhow!("{e}"))?;
        let Some(endpoint) = found.metadata.additional_fields.get("revocation_endpoint").and_then(|v| v.as_str()).map(str::to_string) else { return Ok(false) };
        if !allowed(&endpoint) {
            bail!("its revocation address is {endpoint}, not https");
        }
        let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build()?;
        let client_id = kept["client_id"].as_str().unwrap_or_default();
        for (hint, field) in [("refresh_token", "refresh_token"), ("access_token", "access_token")] {
            let Some(token) = kept["token_response"][field].as_str() else { continue };
            let body = url::form_urlencoded::Serializer::new(String::new()).append_pair("token", token).append_pair("token_type_hint", hint).append_pair("client_id", client_id).finish();
            let sent = http.post(&endpoint).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(body).send().await?;
            if !sent.status().is_success() {
                bail!("it answered {}", sent.status());
            }
        }
        Ok::<bool, anyhow::Error>(true)
    };
    match attempt.await {
        Ok(true) => format!("Asked {name} to revoke the tokens."),
        Ok(false) => none,
        Err(why) => format!("{name} did not revoke the tokens ({why}): remove \"mcp-apps-cli\" in its connected apps."),
    }
}

/// `mcp-apps-cli-helper signout <server> [--mcp-config …] [--cwd …]`
pub async fn signout(args: crate::Args, words: &[String]) -> Result<()> {
    let (name, url) = target(&args, words)?;
    let Some(path) = kept_file(&name, &url) else {
        println!("The helper is not signed in to {name}: nothing to delete.");
        return Ok(());
    };
    println!("{}", revoke(&name, &url, &path).await);
    std::fs::remove_file(&path).with_context(|| format!("deleting {}", path.display()))?;
    println!("Deleted {}", path.display());
    Ok(())
}

fn open_browser(address: &str) {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![address])
    } else if cfg!(windows) {
        ("rundll32", vec!["url.dll,FileProtocolHandler", address])
    } else {
        ("xdg-open", vec![address])
    };
    let _ = std::process::Command::new(program).args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

#[cfg(test)]
mod tests {
    use super::allowed;

    // A token goes only over https or to this machine itself, never in the
    // clear over a network.
    #[test]
    fn only_https_and_loopback_addresses_are_allowed() {
        for url in ["https://mcp.example.com/mcp", "http://localhost:3212/mcp", "http://127.0.0.1:8/mcp", "http://[::1]:9/mcp", "http://app.localhost/mcp"] {
            assert!(allowed(url), "{url}");
        }
        for url in ["http://10.1.2.3/mcp", "http://192.168.1.5/mcp", "http://box.local:1/mcp", "http://mcp.example.com/mcp", "http://127.0.0.1.example.com/mcp", "ftp://localhost/mcp", "not a url"] {
            assert!(!allowed(url), "{url}");
        }
    }
}
