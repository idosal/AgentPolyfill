//! What a server says about itself, for the consent page: read from what the
//! server publishes, with no guessing. Three places, each optional:
//!
//! - the answer to an unauthenticated `initialize`: when the server replies
//!   (many OAuth servers answer 401 until sign-in), its `serverInfo` (MCP's
//!   Implementation: `title`, `description`, `websiteUrl`, `icons`);
//! - the OAuth protected resource metadata (RFC 9728), found from the 401's
//!   `WWW-Authenticate` header or the well-known address: `resource_name`,
//!   `resource_documentation`, `resource_policy_uri`, `resource_tos_uri`,
//!   `scopes_supported`;
//! - the authorization server's metadata (RFC 8414), only for its
//!   `scopes_supported` when the resource names none.
//!
//! A field the server does not publish stays empty and the page leaves it
//! out. An icon is downloaded here (https or this machine, small, an image
//! type) and embedded as a `data:` URL, so the page itself loads nothing
//! from elsewhere. Every request is short, follows no redirect, sends no
//! credential, and a failure only means less is shown.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};

/// The most an answer or an icon may weigh.
const LIMIT: usize = 256 * 1024;
/// How long the whole lookup may take before the page is shown with what it has.
pub const BUDGET: Duration = Duration::from_secs(8);

#[derive(Debug, Default, Clone, PartialEq)]
pub struct About {
    pub title: Option<String>,
    pub description: Option<String>,
    /// http(s) only.
    pub website: Option<String>,
    /// A `data:` URL of an image type the page can show.
    pub icon: Option<String>,
    pub docs: Option<String>,
    pub policy: Option<String>,
    pub terms: Option<String>,
    pub scopes: Vec<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    let s = value.get(key)?.as_str()?.trim();
    (!s.is_empty() && s.len() <= 600 && !s.chars().any(char::is_control)).then(|| s.to_string())
}

/// A link to show: http(s) only (never `javascript:` or `data:`).
fn link(value: &Value, key: &str) -> Option<String> {
    let s = text(value, key)?;
    url::Url::parse(&s).ok().filter(|u| matches!(u.scheme(), "http" | "https")).map(|u| u.to_string())
}

fn scope_list(value: &Value) -> Vec<String> {
    let all = value.get("scopes_supported").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    all.filter(|s| !s.is_empty() && s.len() <= 80 && !s.chars().any(|c| c.is_control() || c.is_whitespace())).take(30).map(str::to_string).collect()
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder().timeout(Duration::from_secs(4)).redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(0).build().ok()
}

/// A body of at most `LIMIT` bytes; None when it is larger.
async fn body(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        out.extend_from_slice(&chunk);
        if out.len() > LIMIT {
            return None;
        }
    }
    Some(out)
}

async fn get_json(http: &reqwest::Client, address: &str) -> Option<Value> {
    if !crate::oauth::allowed(address) {
        return None;
    }
    let response = http.get(address).header("accept", "application/json").send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_slice(&body(response).await?).ok()
}

/// The `resource_metadata` address a 401 names, if it does.
fn named_metadata(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=\"")? + "resource_metadata=\"".len();
    header[at..].split('"').next().map(str::to_string)
}

/// A `serverInfo` out of a JSON answer or an event stream's first `data:` line.
fn server_info(answer: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(answer).ok()?;
    let json = if text.trim_start().starts_with('{') { text.to_string() } else { text.lines().find_map(|l| l.strip_prefix("data:"))?.trim().to_string() };
    let value: Value = serde_json::from_str(&json).ok()?;
    value.get("result")?.get("serverInfo").cloned()
}

/// The icon to show out of `serverInfo.icons`: not made for a dark background,
/// as the page is light; embedded as a `data:` URL.
async fn icon(http: &reqwest::Client, icons: &Value) -> Option<String> {
    let list: Vec<&Value> = icons.as_array()?.iter().filter(|i| i.get("theme").and_then(Value::as_str) != Some("dark")).collect();
    for entry in list.into_iter().take(4) {
        let Some(src) = entry.get("src").and_then(Value::as_str) else { continue };
        if let Some(rest) = src.strip_prefix("data:") {
            let (kind, data) = rest.split_once(";base64,")?;
            if shown(kind) && data.len() <= LIMIT * 4 / 3 && B64.decode(data).is_ok() {
                return Some(src.to_string());
            }
            continue;
        }
        if !crate::oauth::allowed(src) {
            continue;
        }
        let Ok(response) = http.get(src).send().await else { continue };
        let kind = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if response.status().is_success()
            && shown(&kind)
            && let Some(bytes) = body(response).await
        {
            return Some(format!("data:{kind};base64,{}", B64.encode(bytes)));
        }
    }
    None
}

/// The image types the page embeds (an SVG in an `<img>` runs no script).
fn shown(kind: &str) -> bool {
    matches!(kind, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml")
}

/// The well-known address of the resource metadata for `url` (RFC 9728, 3.1).
fn well_known(url: &url::Url, with_path: bool) -> String {
    let mut base = url.clone();
    let path = if with_path { url.path().trim_end_matches('/').to_string() } else { String::new() };
    base.set_path(&format!("/.well-known/oauth-protected-resource{path}"));
    base.set_query(None);
    base.to_string()
}

/// What the server at `url` publishes about itself. Never fails: what could
/// not be read is left out.
pub async fn fetch(url: &str) -> About {
    let (Some(http), Ok(parsed)) = (client(), url::Url::parse(url)) else { return About::default() };
    let mut about = About::default();

    // An unauthenticated `initialize`: serverInfo if it answers, else the 401's pointer to the metadata.
    let mut pointer = None;
    let hello = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "mcp-apps-cli", "version": "0"}}});
    if let Ok(response) = http.post(url).header("accept", "application/json, text/event-stream").json(&hello).send().await {
        pointer = response.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).and_then(named_metadata);
        if response.status().is_success()
            && let Some(info) = body(response).await.and_then(|b| server_info(&b))
        {
            about.title = text(&info, "title");
            about.description = text(&info, "description");
            about.website = link(&info, "websiteUrl");
            if let Some(icons) = info.get("icons") {
                about.icon = icon(&http, icons).await;
            }
        }
    }

    // The protected resource metadata: the address the 401 names, else the well-known ones.
    let mut resource = None;
    let mut candidates: Vec<String> = pointer.into_iter().collect();
    candidates.push(well_known(&parsed, true));
    candidates.push(well_known(&parsed, false));
    for address in candidates {
        if let Some(found) = get_json(&http, &address).await.filter(Value::is_object) {
            resource = Some(found);
            break;
        }
    }
    if let Some(resource) = &resource {
        if about.title.is_none() {
            about.title = text(resource, "resource_name");
        }
        about.docs = link(resource, "resource_documentation");
        about.policy = link(resource, "resource_policy_uri");
        about.terms = link(resource, "resource_tos_uri");
        about.scopes = scope_list(resource);
        if about.scopes.is_empty() {
            // The authorization server's list (RFC 8414), when the resource names none.
            let issuer = resource.get("authorization_servers").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str).and_then(|s| url::Url::parse(s).ok());
            if let Some(mut issuer) = issuer {
                let path = issuer.path().trim_end_matches('/').to_string();
                issuer.set_path(&format!("/.well-known/oauth-authorization-server{path}"));
                if let Some(meta) = get_json(&http, issuer.as_str()).await {
                    about.scopes = scope_list(&meta);
                }
            }
        }
    }
    about
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_server_publishes_is_read_without_trusting_it() {
        let v = json!({"resource_name": " Docs \u{7}", "resource_documentation": "https://d.example/docs", "resource_policy_uri": "javascript:alert(1)", "resource_tos_uri": 5, "scopes_supported": ["read", "bad scope", "", "write"]});
        assert_eq!(text(&v, "resource_name"), None, "a control character is refused");
        assert_eq!(text(&json!({"a": " Docs "}), "a").as_deref(), Some("Docs"));
        assert_eq!(link(&v, "resource_documentation").as_deref(), Some("https://d.example/docs"));
        assert_eq!(link(&v, "resource_policy_uri"), None);
        assert_eq!(link(&v, "resource_tos_uri"), None);
        assert_eq!(scope_list(&v), ["read", "write"]);
    }

    #[test]
    fn the_metadata_address_comes_from_the_401_or_the_well_known_paths() {
        assert_eq!(named_metadata(r#"Bearer realm="OAuth", resource_metadata="https://m.example/.well-known/oauth-protected-resource/mcp", scope="a b""#).as_deref(), Some("https://m.example/.well-known/oauth-protected-resource/mcp"));
        assert_eq!(named_metadata("Bearer"), None);
        let u = url::Url::parse("https://m.example/v2/mcp?x=1").unwrap();
        assert_eq!(well_known(&u, true), "https://m.example/.well-known/oauth-protected-resource/v2/mcp");
        assert_eq!(well_known(&u, false), "https://m.example/.well-known/oauth-protected-resource");
    }

    #[test]
    fn server_info_is_read_from_json_or_an_event_stream() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"n","title":"T"}}}"#;
        assert_eq!(server_info(body).unwrap()["title"], "T");
        let sse = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"n\"}}}\n\n";
        assert_eq!(server_info(sse).unwrap()["name"], "n");
        assert!(server_info(b"{\"error\":1}").is_none());
    }

    #[test]
    fn only_image_types_are_embedded() {
        assert!(shown("image/png") && shown("image/svg+xml") && !shown("text/html") && !shown(""));
    }
}
