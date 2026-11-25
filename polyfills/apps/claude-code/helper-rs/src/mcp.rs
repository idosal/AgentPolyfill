//! The helper's own MCP connections (rmcp): it reads each server's tools and
//! UI resources, and calls app-only tools, which Claude Code doesn't
//! register. It says it renders MCP Apps, so servers that check offer them.
//! It speaks revision 2026-07-28 to a server that serves it and the 2025
//! handshake to one that doesn't (`lifecycle`, from 0.1.5).
//!
//! Each request it writes to a server goes on a yes from Claude Code asked
//! for that request (from 0.1.3): the mod's answer to the app's own request
//! just before, or a check asked now (`verdict.rs`). A yes older than the
//! server's last revocation is refused, and a revocation cancels what is in
//! flight to the server and closes the connection (model/AppsViews.tla,
//! FixAtSend and FixRevoke).

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use rmcp::ServiceExt;
use rmcp::model::{ClientCapabilities, ClientConfig, Implementation, ProtocolVersion};
use rmcp::service::{ClientLifecycleMode, ClientServiceExt, RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, watch};

use crate::Args;
use crate::config;
use crate::out::emit;

type Client = Arc<RunningService<RoleClient, ClientConfig>>;

/// Asks whether Claude Code uses a server now: the epoch of its yes, or None.
pub type Asker = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<u64>> + Send>> + Send + Sync>;

/// Per server: the newest revocation the mod sent (its epoch, 0 for none),
/// and how many requests to it are in flight.
struct Gate {
    revoked: watch::Sender<u64>,
    busy: usize,
}

pub struct Clients {
    args: Args,
    cwd: PathBuf,
    open: Mutex<HashMap<String, (Client, &'static str)>>,
    discovered: Mutex<HashMap<String, Value>>,
    gates: std::sync::Mutex<HashMap<String, Gate>>,
    ask: Asker,
}

/// One request in flight to a server: counted while it lasts, and the mod
/// told when the helper starts and stops waiting on the server ("busy").
struct InFlight<'a> {
    clients: &'a Clients,
    server: String,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let idle = {
            let mut gates = self.clients.gates.lock().unwrap();
            let gate = gates.get_mut(&self.server).expect("a gate for a request in flight");
            gate.busy -= 1;
            gate.busy == 0
        };
        if idle {
            emit(&json!({"type": "busy", "server": self.server, "busy": false}));
        }
    }
}

impl Clients {
    pub fn new(args: Args, cwd: PathBuf) -> Self {
        Self::with_asker(args, cwd, Arc::new(|server: String| Box::pin(async move { crate::verdict::ask(&server).await })))
    }

    pub fn with_asker(args: Args, cwd: PathBuf, ask: Asker) -> Self {
        Self {
            args,
            cwd,
            open: Mutex::new(HashMap::new()),
            discovered: Mutex::new(HashMap::new()),
            gates: std::sync::Mutex::new(HashMap::new()),
            ask,
        }
    }

    /// The newest revocation the mod sent for `server` (0: none).
    pub fn revocation(&self, server: &str) -> u64 {
        self.gates.lock().unwrap().get(server).map_or(0, |gate| *gate.revoked.borrow())
    }

    /// Claude Code's yes for one request to `server`: `given` (the mod's
    /// answer to the app's own request, just before) or asked now. Refused if
    /// older than the server's last revocation.
    async fn admit(&self, server: &str, given: Option<u64>) -> Result<u64> {
        let epoch = match given {
            Some(epoch) => epoch,
            None => (self.ask)(server.to_string()).await.ok_or_else(|| anyhow!("Claude Code is not using MCP server \"{server}\" now"))?,
        };
        if epoch < self.revocation(server) {
            bail!("Claude Code stopped using MCP server \"{server}\"");
        }
        Ok(epoch)
    }

    /// Runs `work`, one request to `server` on the yes of `epoch`, unless or
    /// until a revocation newer than that yes comes: then it is dropped (with
    /// the connection it was on, see `revoke`) and fails.
    async fn guarded<T>(&self, server: &str, epoch: u64, work: impl Future<Output = Result<T>>) -> Result<T> {
        let (mut revoked, first) = {
            let mut gates = self.gates.lock().unwrap();
            let gate = gates.entry(server.to_string()).or_insert_with(|| Gate { revoked: watch::Sender::new(0), busy: 0 });
            gate.busy += 1;
            (gate.revoked.subscribe(), gate.busy == 1)
        };
        let _in_flight = InFlight { clients: self, server: server.to_string() };
        if first {
            emit(&json!({"type": "busy", "server": server, "busy": true}));
        }
        if *revoked.borrow_and_update() > epoch {
            bail!("Claude Code stopped using MCP server \"{server}\"");
        }
        tokio::select! {
            result = work => result,
            _ = revoked.wait_for(|newest| *newest > epoch) => Err(anyhow!("Claude Code stopped using MCP server \"{server}\"")),
        }
    }

    /// The mod's word that Claude Code stopped using `server` (/revoke, with
    /// the mod's count of noes for it): what is in flight to it fails at once,
    /// its connection closes (a stdio server the helper started is stopped;
    /// over streamable HTTP, rmcp ends the session with its DELETE), and a yes
    /// older than `epoch` is refused from now on. Its tools, read before, are
    /// kept: they are what open views of it are drawn by, and keeping them
    /// sends nothing. An older revocation than one already had changes nothing.
    pub async fn revoke(&self, server: &str, epoch: u64) -> bool {
        let newer = {
            let mut gates = self.gates.lock().unwrap();
            let gate = gates.entry(server.to_string()).or_insert_with(|| Gate { revoked: watch::Sender::new(0), busy: 0 });
            gate.revoked.send_if_modified(|newest| {
                let newer = epoch > *newest;
                if newer {
                    *newest = epoch;
                }
                newer
            })
        };
        if !newer {
            return false;
        }
        // Its requests in flight are woken first, so one connecting (which
        // holds this lock) lets go of it.
        let closed = self.open.lock().await.remove(server);
        if let Some((client, _)) = closed {
            client.cancellation_token().cancel();
        }
        true
    }

    /// The entry Claude Code would use for `server`, or why none is used
    /// (see config.rs): nothing is started, sent or expanded before this.
    fn entry(&self, server: &str) -> Result<config::Entry> {
        config::resolve(&self.args, &self.cwd, server).map_err(|why| anyhow!("not using MCP server \"{server}\": {why}"))
    }

    /// The connection to `server`, and the scope its config came from. One
    /// made now (its handshake is a request too) goes on a yes of its own,
    /// `given` if there is one: used up then.
    async fn client_and_scope(&self, server: &str, given: &mut Option<u64>) -> Result<(Client, &'static str)> {
        if let Some(found) = self.open.lock().await.get(server) {
            return Ok(found.clone());
        }
        // The config gate first: a name it refuses is never asked about.
        let entry = self.entry(server)?;
        let epoch = self.admit(server, given.take()).await?;
        self.guarded(server, epoch, async {
            let mut open = self.open.lock().await;
            if let Some(found) = open.get(server) {
                return Ok(found.clone());
            }
            if self.revocation(server) > epoch {
                bail!("Claude Code stopped using MCP server \"{server}\"");
            }
            let client = Arc::new(connect(&entry.config, &self.cwd).await.with_context(|| format!("connecting to {server}"))?);
            open.insert(server.to_string(), (client.clone(), entry.scope));
            Ok((client, entry.scope))
        })
        .await
    }

    /// One request to `server` (`op` on its connection), on a yes of its own:
    /// `given` if the connection was there already, else asked now.
    async fn request<T, F, Fut>(&self, server: &str, given: Option<u64>, op: F) -> Result<(T, &'static str)>
    where
        F: FnOnce(Client) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let mut given = given;
        let (client, scope) = self.client_and_scope(server, &mut given).await?;
        let epoch = self.admit(server, given).await?;
        Ok((self.guarded(server, epoch, op(client)).await?, scope))
    }

    /// The server's tools, as the mod and the views need them: those with a
    /// UI (`_meta.ui.resourceUri`), each tool's visibility, the app-only and
    /// structured ones, and every definition (the host context's toolInfo).
    pub async fn discover(&self, server: &str, refresh: bool) -> Result<Value> {
        if !refresh {
            if let Some(found) = self.discovered.lock().await.get(server) {
                return Ok(found.clone());
            }
        }
        let (tools, scope) = self.request(server, None, |client| async move { client.list_all_tools().await.map_err(|e| anyhow!("{e}")) }).await?;
        let mut with_ui = Map::new();
        let mut visibility = Map::new();
        let mut definitions = Map::new();
        let mut structured = Vec::new();
        let mut app_only = Vec::new();
        for tool in tools {
            let definition = serde_json::to_value(&tool)?;
            let name = tool.name.to_string();
            let meta = definition.get("_meta");
            let ui = meta.and_then(|m| m.get("ui"));
            let resource_uri = ui.and_then(|u| u.get("resourceUri")).or_else(|| meta.and_then(|m| m.get("ui/resourceUri")));
            let seen = ui.and_then(|u| u.get("visibility")).filter(|v| v.is_array());
            if let Some(uri) = resource_uri.and_then(Value::as_str) {
                let mut entry = json!({ "resourceUri": uri });
                if let Some(v) = seen {
                    entry["visibility"] = v.clone();
                }
                with_ui.insert(name.clone(), entry);
            }
            if let Some(v) = seen {
                visibility.insert(name.clone(), v.clone());
                if !v.as_array().is_some_and(|a| a.iter().any(|x| x == "model")) {
                    app_only.push(name.clone());
                }
            }
            if tool.output_schema.is_some() {
                structured.push(name.clone());
            }
            definitions.insert(name, definition);
        }
        let found = json!({
            "tools": with_ui,
            "structured": structured,
            "appOnly": app_only,
            "visibility": visibility,
            "definitions": definitions,
            // Where its config came from: command line, local, project or user.
            "scope": scope,
        });
        self.discovered.lock().await.insert(server.to_string(), found.clone());
        Ok(found)
    }

    pub async fn close_all(&self) {
        let open: Vec<Client> = self.open.lock().await.drain().map(|(_, (c, _))| c).collect();
        for client in open {
            if let Ok(client) = Arc::try_unwrap(client) {
                let _ = client.cancel().await;
            }
        }
    }

    /// The url of a server the helper may use; none for a local (stdio) one or one it may not.
    pub fn server_url(&self, server: &str) -> Option<String> {
        self.entry(server).ok().and_then(|e| e.config["url"].as_str().map(str::to_string))
    }

    /// Whether a server's views may reach this machine's network: one that
    /// runs here (stdio) or at a local address; never one the helper may not use.
    pub fn local_network(&self, server: &str) -> bool {
        match self.entry(server) {
            Ok(entry) => entry.config["url"].as_str().map_or(config::kind(&entry.config) == "stdio", crate::policy::local_server),
            Err(_) => false,
        }
    }

    // `given`: the epoch of the mod's yes to the app's own request just
    // before (ui/allow-tool, ui/allow-read); none: asked now.

    pub async fn call_tool(&self, server: &str, params: Value, given: Option<u64>) -> Result<Value> {
        let params = serde_json::from_value(params)?;
        let (result, _) = self.request(server, given, |client| async move { Ok(client.call_tool(params).await?) }).await?;
        Ok(serde_json::to_value(result)?)
    }

    pub async fn read_resource(&self, server: &str, params: Value, given: Option<u64>) -> Result<Value> {
        let params = serde_json::from_value(params)?;
        let (result, _) = self.request(server, given, |client| async move { Ok(client.read_resource(params).await?) }).await?;
        Ok(serde_json::to_value(result)?)
    }

    pub async fn list_resources(&self, server: &str, params: Value, given: Option<u64>) -> Result<Value> {
        let params = serde_json::from_value(params)?;
        let (result, _) = self.request(server, given, |client| async move { Ok(client.list_resources(params).await?) }).await?;
        Ok(serde_json::to_value(result)?)
    }

    pub async fn list_resource_templates(&self, server: &str, params: Value, given: Option<u64>) -> Result<Value> {
        let params = serde_json::from_value(params)?;
        let (result, _) = self.request(server, given, |client| async move { Ok(client.list_resource_templates(params).await?) }).await?;
        Ok(serde_json::to_value(result)?)
    }
}

/// The server's `headers` (for its HTTP requests), those that are valid.
fn headers(config: &Value) -> http::HeaderMap {
    let mut map = http::HeaderMap::new();
    if let Some(Value::Object(headers)) = config.get("headers") {
        for (name, value) in headers {
            if let (Ok(name), Some(Ok(value))) =
                (http::HeaderName::from_bytes(name.as_bytes()), value.as_str().map(http::HeaderValue::from_str))
            {
                map.insert(name, value);
            }
        }
    }
    map
}

/// Who the helper is and that it renders MCP Apps: in `initialize` (2025
/// revisions) or in each request's `_meta` (2026-07-28). The version it puts
/// in `initialize` is the newest that has the handshake: 2026-07-28 has none,
/// and a server that serves only that revision refuses an `initialize` that
/// names it (issue #5).
fn client_info() -> ClientConfig {
    let mut capabilities = ClientCapabilities::default();
    let mut ui = serde_json::Map::new();
    ui.insert("mimeTypes".into(), json!(["text/html;profile=mcp-app"]));
    capabilities.extensions = Some(BTreeMap::from([("io.modelcontextprotocol/ui".to_string(), ui)]));
    let mut info = ClientConfig::new(capabilities, Implementation::new("mcp-apps-cli", "0.1.5"));
    info.protocol_version = ProtocolVersion::LATEST_WITH_INITIALIZE;
    info
}

/// How a connection starts over stdio and streamable HTTP: `server/discover`
/// at 2026-07-28, which a server of that revision answers (no `initialize`
/// follows; each request then names the revision in its `_meta`, and over
/// HTTP in its MCP-Protocol-Version header). A server that doesn't know it
/// (one of the 2025 revisions answers with an error) gets the 2025 handshake
/// instead, `initialize` at 2025-11-25, which it may answer with an older
/// revision it serves. rmcp does both: its `Auto` mode, as the 2026-07-28
/// revision's backward-compatibility section describes. A server that
/// answers neither within 10 seconds also gets the handshake.
fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::LATEST_WITH_INITIALIZE),
    }
}

async fn connect(config: &Value, cwd: &PathBuf) -> Result<RunningService<RoleClient, ClientConfig>> {
    let url = config.get("url").and_then(Value::as_str);
    match config::kind(config) {
        "http" => {
            let url = url.ok_or_else(|| anyhow!("an http server needs a url"))?;
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
            transport_config.custom_headers = headers(config).into_iter().filter_map(|(k, v)| Some((k?, v))).collect();
            // rmcp's own client follows a redirect only within the server's
            // origin, and only a 307 or 308: one to another host would carry
            // the server's headers there, outside the browser's protections
            // (security review, A3).
            let transport = StreamableHttpClientTransport::from_config(transport_config);
            Ok(client_info().serve_with_lifecycle(transport, lifecycle()).await?)
        }
        // The HTTP+SSE transport is the 2024-11-05 revision's (replaced in
        // 2025-03-26): a server that offers it speaks a 2025 revision, so it
        // gets the handshake, at 2025-11-25.
        "sse" => {
            let url = url.ok_or_else(|| anyhow!("an sse server needs a url"))?;
            Ok(client_info().serve(crate::sse::connect(url, headers(config)).await?).await?)
        }
        _ => {
            let command = config.get("command").and_then(Value::as_str).ok_or_else(|| anyhow!("a stdio server needs a command"))?;
            let args: Vec<String> = config
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let env: Vec<(String, String)> = config
                .get("env")
                .and_then(Value::as_object)
                .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
                .unwrap_or_default();
            let dir = config.get("cwd").and_then(Value::as_str).map(PathBuf::from).unwrap_or_else(|| cwd.clone());
            #[cfg(windows)]
            let command = crate::win::find_program(command, env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.as_str()))
                .unwrap_or_else(|| command.into());
            let command = tokio::process::Command::new(command).configure(|cmd| {
                cmd.args(&args).envs(env.iter().cloned()).current_dir(&dir);
                // No console window of its own for each server.
                #[cfg(windows)]
                cmd.creation_flags(crate::win::NO_WINDOW);
            });
            let (transport, _stderr) = TokioChildProcess::builder(command).stderr(std::process::Stdio::null()).spawn()?;
            Ok(client_info().serve_with_lifecycle(transport, lifecycle()).await?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    type Heads = Arc<StdMutex<Vec<String>>>;

    /// A local server: each request's head is kept (its body read and
    /// dropped), and `answer` gives the response to its request line.
    fn serve(answer: impl Fn(&str) -> String + Send + 'static) -> (String, Heads) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let heads: Heads = Arc::new(StdMutex::new(Vec::new()));
        let seen = heads.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|n| n == 1) {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let length = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                let mut body = vec![0u8; length];
                let _ = stream.read_exact(&mut body);
                seen.lock().unwrap().push(head.clone());
                let _ = stream.write_all(answer(head.lines().next().unwrap_or("")).as_bytes());
            }
        });
        (origin, heads)
    }

    fn redirect(status: u16, to: &str) -> String {
        format!("HTTP/1.1 {status} Redirect\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    }

    const FAIL: &str = "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
    const KEY: &str = "synthetic-key-3e1";

    fn key_header() -> http::HeaderMap {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-api-key", http::HeaderValue::from_static(KEY));
        headers
    }

    fn sent(heads: &Heads) -> Vec<String> {
        heads.lock().unwrap().clone()
    }

    // The security review's A3: a server that answers with a redirect to
    // another origin (127.0.0.1 here, a LAN address or another site there)
    // gets nothing sent there, its headers least of all.
    #[tokio::test]
    async fn streamable_http_follows_no_redirect_to_another_origin() {
        let cwd = std::env::temp_dir();
        for status in [307u16, 308] {
            let (other, elsewhere) = serve(|_| FAIL.to_string());
            let target = format!("{other}/mcp");
            let (origin, _) = serve(move |_| redirect(status, &target));
            let config = json!({"type": "http", "url": format!("{origin}/mcp"), "headers": {"x-api-key": KEY}});
            let connected = tokio::time::timeout(Duration::from_secs(20), connect(&config, &cwd)).await;
            assert!(!matches!(connected, Ok(Ok(_))), "{status}: connected through a redirect");
            assert!(sent(&elsewhere).is_empty(), "{status}: the other origin was sent {:?}", sent(&elsewhere));
        }
        // Within the server's own origin a 307 is followed, its headers with it.
        let (origin, heads) = serve(|line| if line.contains("/mcp2") { FAIL.to_string() } else { redirect(307, "/mcp2") });
        let config = json!({"type": "http", "url": format!("{origin}/mcp"), "headers": {"x-api-key": KEY}});
        let _ = tokio::time::timeout(Duration::from_secs(20), connect(&config, &cwd)).await;
        assert!(
            sent(&heads).iter().any(|h| h.starts_with("POST /mcp2") && h.to_ascii_lowercase().contains(&format!("x-api-key: {KEY}"))),
            "the same-origin redirect wasn't followed: {:?}",
            sent(&heads)
        );
    }

    #[tokio::test]
    async fn sse_follows_no_redirect_for_its_stream_or_its_posts() {
        for status in [307u16, 308] {
            let (other, elsewhere) = serve(|_| FAIL.to_string());
            let target = format!("{other}/sse");
            let (origin, _) = serve(move |_| redirect(status, &target));
            let opened = tokio::time::timeout(Duration::from_secs(20), crate::sse::connect(&format!("{origin}/sse"), key_header())).await;
            assert!(!matches!(opened, Ok(Ok(_))), "{status}: the event stream opened through a redirect");
            assert!(sent(&elsewhere).is_empty(), "{status}: the other origin was sent {:?}", sent(&elsewhere));
        }
        // The stream opens and names its endpoint; a message POSTed there is
        // answered with a redirect elsewhere, which isn't followed.
        let (other, elsewhere) = serve(|_| FAIL.to_string());
        let target = format!("{other}/messages");
        let (origin, heads) = serve(move |line| {
            if line.starts_with("GET") {
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\nevent: endpoint\ndata: /messages\n\n".to_string()
            } else {
                redirect(307, &target)
            }
        });
        let mut stream = tokio::time::timeout(Duration::from_secs(20), crate::sse::connect(&format!("{origin}/sse"), key_header()))
            .await
            .expect("the event stream timed out")
            .expect("the event stream didn't open");
        stream.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n").await.unwrap();
        for _ in 0..200 {
            if sent(&heads).iter().any(|h| h.starts_with("POST /messages")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(sent(&heads).iter().any(|h| h.starts_with("POST /messages")), "the message was never posted: {:?}", sent(&heads));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(sent(&elsewhere).is_empty(), "the other origin was sent {:?}", sent(&elsewhere));
    }
}
