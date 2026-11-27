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
//! separate grant, with its own life, so each step is the person's:
//!
//! - `mcp-apps-cli-helper signin <server>` shows a short consent page in the
//!   person's browser (served on a loopback address of its own, with a token
//!   against forged requests, stopped after the answer or a delay): what it
//!   means, where to keep the login (the macOS Keychain, or a file encrypted
//!   with a passphrase; a plain file is an advanced option), Accept or
//!   Refuse. Accept goes on to the server's own sign-in in the same tab and
//!   keeps the tokens. Without a browser (`--no-browser`), a y/N question in
//!   the terminal asks the same; `--yes` and `MCP_APPS_CLI_SIGNIN_YES=1` skip
//!   it (vault.rs for the stores, consent.rs for the page);
//! - `mcp-apps-cli-helper signout <server>` asks the server to revoke the
//!   tokens where it offers that (RFC 7009) and deletes them;
//! - the mod tells the helper, with each request that names a server, whether
//!   the person listed it; only then does the helper's connection carry the
//!   token (refreshed by rmcp when it ends). Nothing is written to Claude
//!   Code's files.
//!
//! The helper uses it only for a server it may already use (config.rs), and
//! only over `https` or to a loopback address.

use std::collections::HashMap;
use std::io::{BufRead, IsTerminal, Write};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use rmcp::transport::auth::{AuthClient, AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore, StoredCredentials};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::vault::{self, Kind, PASSPHRASE_ENV, Place};

/// How long `signin` waits for the person to answer, in the browser, at each step.
const WAIT: Duration = Duration::from_secs(300);

/// Where the detail is.
pub const MORE: &str = "https://github.com/idosal/AgentPolyfill/tree/main/polyfills/apps/claude-code#limits";

/// The tokens of one server.
struct TokenStore {
    place: Place,
}

fn failed(error: impl std::fmt::Display) -> AuthError {
    AuthError::CredentialStoreError(error.to_string())
}

#[async_trait]
impl CredentialStore for TokenStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        match self.place.read().map_err(failed)? {
            Some(value) => serde_json::from_value(value).map(Some).map_err(failed),
            None => Ok(None),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        self.place.write(&serde_json::to_value(&credentials).map_err(failed)?).map_err(failed)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.place.delete().map_err(failed)
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
    let Some(place) = vault::kept(name, url) else { return Ok(None) };
    let mut manager = AuthorizationManager::new(url).await.map_err(|e| anyhow!("{e}"))?;
    manager.set_credential_store(TokenStore { place });
    if !manager.initialize_from_store().await.map_err(|e| anyhow!("{e}"))? {
        return Ok(None);
    }
    // No redirect is followed: the token goes to the server's own url only.
    let http = reqwest::Client::builder().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).build()?;
    Ok(Some(AuthClient::new(http, manager)))
}

/// Starts the flow with the server: its metadata, a client registered, and
/// the address the person opens. The tokens go to `place` when it is done.
async fn begin(name: &str, url: &str, place: Place, redirect: &str) -> Result<AuthorizationSession> {
    let _ = name;
    let mut manager = AuthorizationManager::new(url).await.map_err(|e| anyhow!("{e}"))?;
    manager.set_credential_store(TokenStore { place });
    let found = manager.resolve_metadata().await.map_err(|e| anyhow!("the server's sign-in page was not found: {e}"))?;
    manager.set_metadata(found.metadata);
    let request = AuthorizationRequest::new(redirect.to_string()).with_client_name("mcp-apps-cli");
    AuthorizationSession::new(manager, request).await.map_err(|(_, e)| anyhow!("{e}"))
}

/// Makes the folder a file store needs.
fn prepare(place: &Place) -> Result<()> {
    if let Place::File(path) | Place::Encrypted(path, _) = place {
        crate::store::private_folder(path.parent().context("no folder to keep the sign-in in")?)?;
    }
    Ok(())
}

fn check_url(name: &str, url: &str) -> Result<()> {
    if !allowed(url) {
        bail!("\"{name}\" is at {url}: the helper signs in only to an https address, or one on this machine");
    }
    Ok(())
}

/// Signs in to `name` at `url` with the place already chosen: `show` is given
/// the address the person opens (the terminal path prints it and tries the
/// browser). Returns when the tokens are kept.
pub async fn signin(name: &str, url: &str, kind: Kind, show: impl FnOnce(&str)) -> Result<()> {
    check_url(name, url)?;
    let place = Place::of(kind, name, url, std::env::var(PASSPHRASE_ENV).ok()).context("no folder to keep the sign-in in")?;
    prepare(&place)?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let mut requests = listen(listener, port);
    let session = begin(name, url, place, &format!("http://127.0.0.1:{port}/callback")).await?;
    show(&session.auth_url);
    callback(&mut requests, port, session).await
}

/// The browser's return from the server's sign-in page.
async fn callback(requests: &mut Requests, port: u16, session: AuthorizationSession) -> Result<()> {
    let target = tokio::time::timeout(WAIT, wait_for_callback(requests)).await.map_err(|_| anyhow!("nobody answered in the browser"))??;
    session.handle_callback_url(&format!("http://127.0.0.1:{port}{target}")).await.map(|_| ()).map_err(|e| anyhow!("{e}"))
}

// ---- a small HTTP server, for the consent page and the sign-in's return ----

struct Http {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Http {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }
    fn query(&self, key: &str) -> Option<String> {
        let query = self.target.split_once('?')?.1;
        url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }
    fn form(&self) -> HashMap<String, String> {
        url::form_urlencoded::parse(self.body.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }
}

/// One request, read whole (headers and a body up to 64 KB), or none.
async fn read_http(stream: &mut TcpStream) -> Option<Http> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 || buf.len() > 65536 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let head = String::from_utf8_lossy(&buf[..end]).to_string();
        let mut lines = head.lines();
        let mut first = lines.next()?.split_whitespace();
        let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
        let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
        let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        if buf.len() >= end + 4 + length {
            let body = String::from_utf8_lossy(&buf[end + 4..end + 4 + length]).to_string();
            return Some(Http { method, target, headers, body });
        }
    }
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\ncache-control: no-store\r\n\
         content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'\r\nx-frame-options: DENY\r\nreferrer-policy: same-origin\r\n{extra}\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
}

/// The requests this server gets from this machine, to its own address (a
/// page on another site can't reach it by a name that points here). Each
/// connection is read on its own, so a browser's idle spare connection (they
/// open some ahead) never holds up the one that carries the request.
struct Requests {
    rx: tokio::sync::mpsc::UnboundedReceiver<(TcpStream, Http)>,
}

fn listen(listener: TcpListener, port: u16) -> Requests {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() {
                continue;
            }
            let tx = tx.clone();
            tokio::spawn(async move {
                let Some(request) = read_http(&mut stream).await else { return };
                let host = request.headers.get("host").map(String::as_str).unwrap_or("");
                if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
                    respond(&mut stream, "400 Bad Request", "", "").await;
                    return;
                }
                let _ = tx.send((stream, request));
            });
        }
    });
    Requests { rx }
}

impl Requests {
    async fn next(&mut self) -> Result<(TcpStream, Http)> {
        self.rx.recv().await.context("the local server stopped")
    }
}

/// The request target (`/callback?code=…&state=…`) of the browser's return.
async fn wait_for_callback(requests: &mut Requests) -> Result<String> {
    loop {
        let (mut stream, request) = requests.next().await?;
        let ours = request.method == "GET" && request.path() == "/callback";
        let body = if ours { crate::consent::done_page() } else { String::new() };
        respond(&mut stream, if ours { "200 OK" } else { "404 Not Found" }, "", &body).await;
        if ours {
            if request.target.contains("error=") {
                bail!("the server refused the sign-in: {}", request.target);
            }
            return Ok(request.target);
        }
    }
}

enum Answer {
    Refused,
    Accepted(Box<AuthorizationSession>, Place),
}

/// The consent page: served until the person accepts or refuses.
async fn wait_for_consent(requests: &mut Requests, port: u16, token: &str, name: &str, url: &str, about: &crate::about::About, place: &Place) -> Result<Answer> {
    let mut problem: Option<String> = None;
    loop {
        let (mut stream, request) = requests.next().await?;
        let origin_ok = request.headers.get("origin").is_none_or(|o| o == &format!("http://127.0.0.1:{port}") || o == &format!("http://localhost:{port}"));
        match (request.method.as_str(), request.path()) {
            ("GET", "/consent") if request.query("t").as_deref() == Some(token) => {
                respond(&mut stream, "200 OK", "", &crate::consent::page(name, url, about, place.kind(), token, problem.as_deref())).await;
            }
            ("POST", "/decision") if origin_ok && request.form().get("t").map(String::as_str) == Some(token) => {
                let form = request.form();
                if form.get("decision").map(String::as_str) != Some("accept") {
                    respond(&mut stream, "200 OK", "", &crate::consent::refused_page(name)).await;
                    return Ok(Answer::Refused);
                }
                match begin_prepared(name, url, place, port).await {
                    Ok(session) => {
                        let location = format!("location: {}\r\n", session.auth_url);
                        respond(&mut stream, "303 See Other", &location, "").await;
                        return Ok(Answer::Accepted(Box::new(session), place.clone()));
                    }
                    Err(why) => {
                        problem = Some(format!("{why:#}"));
                        respond(&mut stream, "200 OK", "", &crate::consent::page(name, url, about, place.kind(), token, problem.as_deref())).await;
                    }
                }
            }
            _ => respond(&mut stream, "404 Not Found", "", "").await,
        }
    }
}

/// The folder made, and the flow begun with the server.
async fn begin_prepared(name: &str, url: &str, place: &Place, port: u16) -> Result<AuthorizationSession> {
    prepare(place)?;
    begin(name, url, place.clone(), &format!("http://127.0.0.1:{port}/callback")).await
}

/// The browser path: consent page, then the server's own sign-in in the same
/// tab. `kind` is where the login is kept (the global setting, vault.rs);
/// `ready` is given the page's address. None: the person refused.
pub async fn signin_in_browser(name: &str, url: &str, kind: Kind, ready: impl FnOnce(&str)) -> Result<Option<Place>> {
    check_url(name, url)?;
    vault::usable(kind)?;
    // A page can't take a passphrase: an encrypted file's comes from the environment.
    let passphrase = std::env::var(PASSPHRASE_ENV).ok().filter(|p| !p.is_empty());
    if kind == Kind::Encrypted {
        match &passphrase {
            Some(p) => vault::check_passphrase(p)?,
            None => bail!("the logins are set to be kept in a file encrypted with a passphrase: set {PASSPHRASE_ENV} in the environment, or use another store (MCP_APPS_CLI_TOKEN_STORE)"),
        }
    }
    let place = Place::of(kind, name, url, passphrase).context("no folder to keep the sign-in in")?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = crate::tmp::random_hex(16)?;
    let mut requests = listen(listener, port);
    // What the server publishes about itself, for the page (what is missing is left out).
    let about = tokio::time::timeout(crate::about::BUDGET, crate::about::fetch(url)).await.unwrap_or_default();
    ready(&format!("http://127.0.0.1:{port}/consent?t={token}"));
    let answer = tokio::time::timeout(WAIT, wait_for_consent(&mut requests, port, &token, name, url, &about, &place)).await.map_err(|_| anyhow!("nobody answered in the browser"))??;
    match answer {
        Answer::Refused => Ok(None),
        Answer::Accepted(session, place) => {
            callback(&mut requests, port, *session).await?;
            Ok(Some(place))
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

/// What the terminal says before its y/N question (the fallback to the
/// consent page): plain words, one idea a line.
fn notice(name: &str, url: &str, place: &Place) -> String {
    format!(
        "Sign in to \"{name}\" ({url}) for this helper only (Claude Code's own sign-in is not used).\n\
         \x20 - What it does: gives the helper its own login to \"{name}\", kept in {}.\n\
         \x20 - What to know: Claude Code's `/mcp` and your organisation's MCP rules can't see or cancel it.\n\
         \x20 - To undo it: `mcp-apps-cli-helper signout {name}`\n\
         More: {MORE}\n",
        place.describe()
    )
}

fn flag(words: &[String], name: &str) -> bool {
    words.iter().any(|w| w == name)
}

/// The final lines of a sign-in that worked.
fn signed_in(name: &str, place: &Place) {
    println!("\nSigned in to {name}. The login is kept in the {}.", place.short());
    if matches!(place, Place::Encrypted(..)) {
        println!("When you start Claude Code, set {PASSPHRASE_ENV} in the environment: the helper can't ask for it.");
    }
    // From a terminal the helper can't read /config, so it can't know.
    println!("If \"{name}\" isn't under \"Own sign-in (OAuth)\" in /config, add it.");
}

/// `mcp-apps-cli-helper signin <server> [--yes] [--no-browser] [--token-store keychain|encrypted|file]`
pub async fn cli(args: crate::Args, words: &[String]) -> Result<()> {
    let (name, url) = target(&args, words)?;
    let name = name.as_str();
    let kind = vault::chosen(words)?;
    // `--yes`, or `MCP_APPS_CLI_SIGNIN_YES=1` for someone who always wants it
    // (a terminal can't read /config), and `--no-browser`: no consent page.
    let assumed = flag(words, "--yes") || std::env::var("MCP_APPS_CLI_SIGNIN_YES").is_ok_and(|v| !v.is_empty() && v != "0");
    if !assumed && !flag(words, "--no-browser") {
        let interactive = std::io::stdin().is_terminal();
        let place = signin_in_browser(name, &url, kind, |page| {
            if interactive {
                println!("Press Enter to review and approve in your browser\n(or open: {page})");
                let page = page.to_string();
                // Not a task: a read of the terminal that never ends must not hold the process.
                std::thread::spawn(move || {
                    let mut line = String::new();
                    if std::io::stdin().lock().read_line(&mut line).is_ok() && std::env::var_os("MCP_APPS_CLI_NO_BROWSER").is_none() {
                        open_browser(&page);
                    }
                });
            } else {
                println!("Review and approve in your browser: {page}");
                if std::env::var_os("MCP_APPS_CLI_NO_BROWSER").is_none() {
                    open_browser(page);
                }
            }
        })
        .await?;
        match place {
            Some(place) => signed_in(name, &place),
            None => println!("Not signed in to {name}."),
        }
        return Ok(());
    }
    // The terminal: the same question; the store is the global setting.
    vault::usable(kind)?;
    let mut passphrase = std::env::var(PASSPHRASE_ENV).ok().filter(|p| !p.is_empty());
    if kind == Kind::Encrypted && passphrase.is_none() {
        if !std::io::stdin().is_terminal() {
            bail!("a passphrase can't be asked for here: set {PASSPHRASE_ENV}");
        }
        let first = vault::prompt_passphrase("Passphrase (at least 8 characters): ")?;
        vault::check_passphrase(&first)?;
        if vault::prompt_passphrase("Again: ")? != first {
            bail!("the two passphrases differ");
        }
        passphrase = Some(first);
    }
    let place = Place::of(kind, name, &url, passphrase.clone()).context("no folder to keep the sign-in in")?;
    println!("{}", notice(name, &url, &place));
    if !assumed {
        if !std::io::stdin().is_terminal() {
            bail!("signin asks a question: run it in a terminal, or pass --yes (or set MCP_APPS_CLI_SIGNIN_YES=1)");
        }
        print!("Continue? [y/N] ");
        std::io::stdout().flush()?;
        let mut answer = String::new();
        std::io::stdin().lock().read_line(&mut answer)?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("Not signed in to {name}.");
            return Ok(());
        }
    }
    println!();
    // The passphrase is read from the environment inside `signin`.
    if let Some(p) = &passphrase {
        // SAFETY: nothing else runs yet that reads the environment.
        unsafe { std::env::set_var(PASSPHRASE_ENV, p) };
    }
    signin(name, &url, kind, |address| {
        println!("Open this address to sign in to {name}:\n{address}");
        if std::env::var_os("MCP_APPS_CLI_NO_BROWSER").is_none() {
            open_browser(address);
        }
    })
    .await?;
    signed_in(name, &place);
    Ok(())
}

/// Asks the server to revoke the tokens in `path` (RFC 7009): what to say about it.
async fn revoke(name: &str, url: &str, place: &Place) -> String {
    let none = format!("{name} offers no way to revoke from here: remove \"mcp-apps-cli\" in its connected apps.");
    let Ok(Some(kept)) = place.read() else { return none };
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
    let Some(place) = vault::kept(&name, &url) else {
        println!("Not signed in to {name}: nothing to delete.");
        return Ok(());
    };
    println!("{}", revoke(&name, &url, &place).await);
    place.delete().map_err(|why| anyhow!("deleting the tokens from {}: {why}", place.describe()))?;
    match &place {
        Place::File(path) | Place::Encrypted(path, _) => println!("Deleted {}", path.display()),
        Place::Keychain(_) => println!("Removed the tokens from the macOS Keychain."),
    }
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
