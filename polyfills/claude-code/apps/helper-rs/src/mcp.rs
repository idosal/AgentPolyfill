//! The helper's own MCP connections (rmcp): it reads each server's tools and
//! UI resources, and calls app-only tools, which Claude Code doesn't
//! register. It says it renders MCP Apps, so servers that check offer them.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use rmcp::ServiceExt;
use rmcp::model::{ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::Args;
use crate::config;

type Client = Arc<RunningService<RoleClient, ClientConfig>>;

pub struct Clients {
    args: Args,
    cwd: PathBuf,
    open: Mutex<HashMap<String, Client>>,
    discovered: Mutex<HashMap<String, Value>>,
}

impl Clients {
    pub fn new(args: Args, cwd: PathBuf) -> Self {
        Self { args, cwd, open: Mutex::new(HashMap::new()), discovered: Mutex::new(HashMap::new()) }
    }

    /// The connection to `server`, made the first time it's asked for.
    pub async fn client(&self, server: &str) -> Result<Client> {
        let mut open = self.open.lock().await;
        if let Some(client) = open.get(server) {
            return Ok(client.clone());
        }
        let raw = config::load(&self.args, &self.cwd)
            .remove(server)
            .ok_or_else(|| anyhow!("no config found for MCP server \"{server}\""))?;
        let config = config::expand_env(&raw);
        let client = Arc::new(connect(&config, &self.cwd).await.with_context(|| format!("connecting to {server}"))?);
        open.insert(server.to_string(), client.clone());
        Ok(client)
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
        let client = self.client(server).await?;
        let tools = client.list_all_tools().await.map_err(|e| anyhow!("{e}"))?;
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
        });
        self.discovered.lock().await.insert(server.to_string(), found.clone());
        Ok(found)
    }

    pub async fn close_all(&self) {
        let open: Vec<Client> = self.open.lock().await.drain().map(|(_, c)| c).collect();
        for client in open {
            if let Ok(client) = Arc::try_unwrap(client) {
                let _ = client.cancel().await;
            }
        }
    }

    pub fn server_url(&self, server: &str) -> Option<String> {
        config::load(&self.args, &self.cwd).get(server).map(config::expand_env)
            .and_then(|v| v["url"].as_str().map(str::to_string))
    }

    pub async fn call_tool(&self, server: &str, params: Value) -> Result<Value> {
        Ok(serde_json::to_value(self.client(server).await?.call_tool(serde_json::from_value(params)?).await?)?)
    }

    pub async fn read_resource(&self, server: &str, params: Value) -> Result<Value> {
        Ok(serde_json::to_value(self.client(server).await?.read_resource(serde_json::from_value(params)?).await?)?)
    }

    pub async fn list_resources(&self, server: &str, params: Value) -> Result<Value> {
        Ok(serde_json::to_value(self.client(server).await?.list_resources(serde_json::from_value(params)?).await?)?)
    }

    pub async fn list_resource_templates(&self, server: &str, params: Value) -> Result<Value> {
        Ok(serde_json::to_value(self.client(server).await?.list_resource_templates(serde_json::from_value(params)?).await?)?)
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

fn client_info() -> ClientConfig {
    let mut capabilities = ClientCapabilities::default();
    let mut ui = serde_json::Map::new();
    ui.insert("mimeTypes".into(), json!(["text/html;profile=mcp-app"]));
    capabilities.extensions = Some(BTreeMap::from([("io.modelcontextprotocol/ui".to_string(), ui)]));
    ClientConfig::new(capabilities, Implementation::new("mcp-apps-cli", "0.1.0"))
}

async fn connect(config: &Value, cwd: &PathBuf) -> Result<RunningService<RoleClient, ClientConfig>> {
    let url = config.get("url").and_then(Value::as_str);
    let kind = config.get("type").and_then(Value::as_str).unwrap_or(if url.is_some() { "http" } else { "stdio" });
    match kind {
        "http" => {
            let url = url.ok_or_else(|| anyhow!("an http server needs a url"))?;
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
            transport_config.custom_headers = headers(config).into_iter().filter_map(|(k, v)| Some((k?, v))).collect();
            let transport = StreamableHttpClientTransport::with_client(reqwest::Client::new(), transport_config);
            Ok(client_info().serve(transport).await?)
        }
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
            Ok(client_info().serve(transport).await?)
        }
    }
}
