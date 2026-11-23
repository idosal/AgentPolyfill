//! Requests from the mod: HTTP/1.1 POSTs with a JSON body, over a Unix
//! socket only the person can open, or (Windows, `MCP_APPS_CLI_TRANSPORT=tcp`)
//! loopback TCP. Every request carries the token the mod got on stdout
//! (`x-mcp-apps-cli-token`); one without it gets 403. One request per
//! connection: the answer, then the connection closes.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::Helper;
use crate::out::log;

const TOKEN_HEADER: &str = "x-mcp-apps-cli-token";
/// A request's head, and its body, at most (a tool result can be large).
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

static SOCKET: OnceLock<PathBuf> = OnceLock::new();

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
pub(crate) mod test_support;

/// Starts listening: `("socket", path)` or `("url", "http://127.0.0.1:port")`.
pub async fn listen(helper: Arc<Helper>) -> Result<(&'static str, String)> {
    let tcp = cfg!(windows) || std::env::var("MCP_APPS_CLI_TRANSPORT").as_deref() == Ok("tcp");
    if tcp {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(helper.clone(), stream));
            }
        });
        return Ok(("url", url));
    }
    #[cfg(unix)]
    {
        let path = helper
            .args
            .socket
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join(format!("mcp-apps-cli-{}.sock", std::process::id())));
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        let _ = SOCKET.set(path.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(helper.clone(), stream));
            }
        });
        return Ok(("socket", path.to_string_lossy().to_string()));
    }
    #[allow(unreachable_code)]
    {
        bail!("no transport")
    }
}

pub fn remove_socket() {
    if let Some(path) = SOCKET.get() {
        let _ = std::fs::remove_file(path);
    }
}

/// One request: read, checked, answered.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(helper: Arc<Helper>, mut stream: S) {
    let (status, body) = match read_request(&mut stream).await {
        Ok((path, headers, body)) => {
            let given = headers.iter().find(|(k, _)| k == TOKEN_HEADER).map(|(_, v)| v.as_str()).unwrap_or("");
            if !same(given.as_bytes(), helper.token.as_bytes()) {
                (403, json!({ "ok": false, "error": "not authorized" }))
            } else {
                let input: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).unwrap_or(json!({})) };
                match route(&helper, &path, input).await {
                    Some(Ok(answer)) => (200, answer),
                    Some(Err(error)) => (500, json!({ "ok": false, "error": format!("{error:#}") })),
                    None => (404, json!({ "ok": false, "error": "not found" })),
                }
            }
        }
        Err(error) => (400, json!({ "ok": false, "error": error.to_string() })),
    };
    let text = body.to_string();
    let reason = match status { 200 => "OK", 403 => "Forbidden", 404 => "Not Found", 400 => "Bad Request", _ => "Error" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    // Our side done; the connection closes once the client has read the
    // answer and closed its own (RFC 9112's lingering close). Closing at
    // once fails a client still finishing its write of a large request
    // (EPIPE), with its answer unread.
    let _ = stream.shutdown().await;
    let mut rest = [0u8; 4096];
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while matches!(stream.read(&mut rest).await, Ok(n) if n > 0) {}
    })
    .await;
}

/// Compares the token in constant time.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

type Request = (String, Vec<(String, String)>, Vec<u8>);

// Vec's automatic geometric growth can exceed a byte limit even when its
// length does not. Grow geometrically, but cap the requested capacity too.
fn append_bounded(buf: &mut Vec<u8>, bytes: &[u8], limit: usize) {
    let needed = buf.len() + bytes.len();
    if needed > buf.capacity() {
        let capacity = needed.max(buf.capacity().saturating_mul(2)).min(limit);
        buf.reserve_exact(capacity - buf.len());
    }
    buf.extend_from_slice(bytes);
}

async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Request> {
    let mut buf = Vec::with_capacity(4096);
    let mut searched = 0;
    let head_end = loop {
        if let Some(at) = buf[searched..].windows(4).position(|w| w == b"\r\n\r\n") {
            break searched + at;
        }
        if buf.len() == MAX_HEAD {
            bail!("request head too long");
        }
        searched = buf.len().saturating_sub(3);
        let mut chunk = [0u8; 8192];
        let remaining = chunk.len().min(MAX_HEAD - buf.len());
        let n = stream.read(&mut chunk[..remaining]).await?;
        if n == 0 {
            bail!("connection closed early");
        }
        append_bounded(&mut buf, &chunk[..n], MAX_HEAD);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let mut length = None;
    for (_, value) in headers.iter().filter(|(k, _)| k == "content-length") {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            bail!("invalid content-length");
        }
        let parsed: usize = value.parse().map_err(|_| anyhow::anyhow!("invalid content-length"))?;
        if parsed > MAX_BODY { bail!("request body too large"); }
        if length.is_some_and(|previous| previous != parsed) { bail!("conflicting content-length"); }
        length = Some(parsed);
    }
    let length = length.unwrap_or(0);
    let buffered = &buf[head_end + 4..];
    let mut body = buffered[..buffered.len().min(length)].to_vec();
    while body.len() < length {
        let mut chunk = vec![0u8; (length - body.len()).min(1 << 20)];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            bail!("connection closed early");
        }
        append_bounded(&mut body, &chunk[..n], length);
    }
    body.truncate(length);
    Ok((path, headers, body))
}

/// Transport-independent routes, with page wakeups handled by views.
async fn route(helper: &Arc<Helper>, path: &str, input: Value) -> Option<Result<Value>> {
    let views = [
        "/open", "/input", "/shown", "/activity", "/resize", "/reply", "/theme", "/args", "/result", "/cancel", "/inline-png",
        "/refresh", "/close", "/locate", "/mode",
    ];
    Some(match path {
        "/ping" => Ok(helper.views.ping().await),
        // Whether app views have a browser to run in, and which.
        "/browser" => Ok(match crate::chrome::executable() {
            Ok(path) => json!({ "ok": true, "found": true, "path": path.display().to_string() }),
            Err(error) => json!({ "ok": true, "found": false, "error": format!("{error:#}"), "fetchable": crate::fetch_browser::platform().is_some() }),
        }),
        // Only on the person's yes (the mod asks): Chrome for Testing's
        // headless shell, fetched into the plugin's data folder.
        "/fetch-browser" => Ok(match crate::fetch_browser::fetch().await {
            Ok((path, version)) => json!({ "ok": true, "path": path.display().to_string(), "version": version }),
            Err(error) => json!({ "ok": false, "error": format!("{error:#}") }),
        }),
        "/discover" => {
            let server = input.get("server").and_then(Value::as_str).unwrap_or_default().to_string();
            let refresh = input.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            match helper.mcp.discover(&server, refresh).await {
                Ok(found) => {
                    let mut answer = json!({ "ok": true });
                    if let (Value::Object(a), Value::Object(f)) = (&mut answer, found) {
                        a.extend(f);
                    }
                    Ok(answer)
                }
                Err(error) => Ok(json!({ "ok": false, "error": format!("{error:#}") })),
            }
        }
        "/prewarm" => match helper.chrome.browser().await {
            Ok(_) => {
                helper.chrome.note_views().await;
                // Given the server and theme of the view expected, a tab is
                // made ready for it (see Views::keep_spare).
                if let Some(theme) = input["theme"].as_str() {
                    let server = input["server"].as_str().unwrap_or("");
                    let local_network = helper.mcp.server_url(server).as_deref().is_none_or(crate::policy::local_server);
                    crate::views::Views::keep_spare(helper, crate::policy::theme_name(theme), crate::terminal::image_capable(), local_network);
                }
                // Given the tool, its UI resource is read ahead (and kept, as
                // every view's is), so the first view of the app doesn't wait on it.
                if let (Some(server), Some(tool)) = (input["server"].as_str(), input["tool"].as_str()) {
                    let (helper, server, tool) = (helper.clone(), server.to_string(), tool.to_string());
                    tokio::spawn(async move {
                        let Ok(discovered) = helper.mcp.discover(&server, false).await else { return };
                        let Some(uri) = discovered["tools"][tool.as_str()]["resourceUri"].as_str().map(str::to_string) else { return };
                        let _ = crate::views::Views::resource(&helper, &server, &uri).await;
                    });
                }
                Ok(json!({ "ok": true }))
            }
            Err(error) => {
                log(format!("Chrome: {error:#}"));
                Ok(json!({ "ok": false, "error": format!("{error:#}") }))
            }
        },
        p if views.contains(&p) => crate::views::route(helper, p, input).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_support::{Chunked, allocations, cases};

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().build().unwrap()
    }

    #[test]
    fn random_bytes_and_short_reads_never_panic() {
        let rt = runtime();
        cases(0x48545450, 3_000, |rng| {
            let mut bytes = rng.bytes(1024);
            if rng.below(2) == 0 { bytes.extend_from_slice(b"\r\n\r\n"); }
            let mut stream = Chunked::new(bytes, rng.next(), 1 + rng.below(256));
            let (result, largest) = allocations(|| rt.block_on(read_request(&mut stream)));
            assert!(largest <= MAX_HEAD);
            if let Ok((_, _, body)) = result { assert!(body.len() <= MAX_BODY); }
        });
    }

    #[test]
    fn declared_body_is_exact_across_chunking_and_eof() {
        let rt = runtime();
        cases(0x424f4459, 3_000, |rng| {
            let body = rng.bytes(2048);
            let name: String = "content-length".chars().map(|c| if rng.below(2) == 0 { c.to_ascii_uppercase() } else { c }).collect();
            let head = format!("POST /input?ignored=yes HTTP/1.1\r\n{name}: \t{} \t\r\nX-McP-ApPs-ClI-ToKeN: secret\r\n\r\n", body.len());
            let mut bytes = head.as_bytes().to_vec();
            bytes.extend_from_slice(&body);
            let complete = rng.below(2) == 0;
            if complete { bytes.extend_from_slice(b"extra bytes are not part of the body"); }
            else { bytes.truncate(rng.below(bytes.len())); }
            let mut stream = Chunked::new(bytes, rng.next(), 1 + rng.below(512));
            let result = rt.block_on(read_request(&mut stream));
            if complete {
                let (path, headers, actual) = result.unwrap();
                assert_eq!(path, "/input");
                assert!(headers.contains(&(TOKEN_HEADER.into(), "secret".into())));
                assert_eq!(actual, body);
            } else { assert!(result.is_err()); }
        });
    }

    #[test]
    fn malformed_and_oversized_lengths_are_errors() {
        let rt = runtime();
        let values = vec!["-1".to_string(), "+1".into(), "".into(), "one".into(), "1.0".into(), "1,1".into(),
            "1 0".into(), "18446744073709551616".into(), "9".repeat(200), (MAX_BODY + 1).to_string()];
        let check = |value: &str| {
            let bytes = format!("POST / HTTP/1.1\r\ncontent-length: {value}\r\n\r\nx").into_bytes();
            let mut stream = Chunked::new(bytes, 7, 97);
            let (result, largest) = allocations(|| rt.block_on(read_request(&mut stream)));
            assert!(result.is_err(), "accepted content-length: {value:?}");
            assert!(largest <= MAX_HEAD, "allocated {largest} for {value:?}");
        };
        for value in values { check(&value); }
        cases(0x4c454e, 3_000, |rng| { check(&format!("{}x{}", rng.next(), rng.string(12))); });
    }

    #[test]
    fn missing_zero_and_repeated_lengths() {
        let rt = runtime();
        for headers in ["", "Content-Length: 0\r\n", "Content-Length: 000\r\n"] {
            let bytes = format!("POST / HTTP/1.1\r\n{headers}\r\nignored");
            assert!(rt.block_on(read_request(&mut bytes.as_bytes())).unwrap().2.is_empty());
        }
        for headers in ["Content-Length: 1\r\ncontent-length: 2", "Content-Length: 0\r\ncontent-length: -1"] {
            let bytes = format!("POST / HTTP/1.1\r\n{headers}\r\n\r\nxx");
            assert!(rt.block_on(read_request(&mut bytes.as_bytes())).is_err(), "{headers}");
        }
        let mut bytes = b"POST / HTTP/1.1\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx".as_slice();
        assert_eq!(rt.block_on(read_request(&mut bytes)).unwrap().2, b"x");
    }

    fn padded_head(size: usize) -> Vec<u8> {
        let mut bytes = b"POST / HTTP/1.1\r\nX-Pad: ".to_vec();
        bytes.resize(size - 4, b'a');
        bytes.extend_from_slice(b"\r\n\r\n");
        bytes
    }

    #[test]
    fn head_limit_is_independent_of_read_boundaries() {
        let rt = runtime();
        for size in [MAX_HEAD - 1, MAX_HEAD, MAX_HEAD + 1, MAX_HEAD + 4, MAX_HEAD + 8192] {
            for max in [1, 997, 8192, MAX_HEAD * 2] {
                let mut stream = Chunked::new(padded_head(size), 23, max);
                let (result, largest) = allocations(|| rt.block_on(read_request(&mut stream)));
                assert_eq!(result.is_ok(), size <= MAX_HEAD, "size={size}, chunk={max}");
                assert!(stream.read <= MAX_HEAD, "read {} head bytes", stream.read);
                assert!(largest <= MAX_HEAD, "head allocation={largest}");
            }
        }
        cases(0x48454144, 3_000, |rng| {
            let size = MAX_HEAD - 32 + rng.below(65);
            let mut stream = Chunked::new(padded_head(size), rng.next(), 8192);
            let (result, largest) = allocations(|| rt.block_on(read_request(&mut stream)));
            assert_eq!(result.is_ok(), size <= MAX_HEAD, "head size={size}");
            assert!(stream.read <= MAX_HEAD);
            assert!(largest <= MAX_HEAD);
        });
    }

    #[test]
    fn body_allocation_stays_within_limit() {
        let rt = runtime();
        // Thirteen prefetched bytes make geometric Vec growth overshoot 64 MiB.
        // The rest is generated by AsyncRead, without a second 64 MiB test buffer.
        for length in [MAX_BODY - 1, MAX_BODY] {
            let mut head = format!("POST / HTTP/1.1\r\nContent-Length: {length}\r\n\r\n").into_bytes();
            head.extend_from_slice(&[b'x'; 13]);
            let mut stream = head.as_slice().chain(tokio::io::repeat(b'x').take((length - 13) as u64));
            let (result, largest) = allocations(|| rt.block_on(read_request(&mut stream)));
            let body = result.unwrap().2;
            assert_eq!(body.len(), length);
            assert!(body.iter().all(|&b| b == b'x'));
            assert!(body.capacity() <= MAX_BODY, "capacity={}", body.capacity());
            assert!(largest <= MAX_BODY, "allocation={largest}");
        }
        let head = format!("POST / HTTP/1.1\r\nContent-Length: {MAX_BODY}\r\n\r\n");
        assert!(rt.block_on(read_request(&mut head.as_bytes())).is_err());
    }

    #[test]
    fn io_errors_propagate() {
        struct Broken;
        impl AsyncRead for Broken {
            fn poll_read(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, _: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::ErrorKind::ConnectionReset.into()))
            }
        }
        let rt = runtime();
        assert!(rt.block_on(read_request(&mut Broken)).is_err());
        let mut stream = b"POST / HTTP/1.1\r\nContent-Length: 1\r\n\r\n".as_slice().chain(Broken);
        assert!(rt.block_on(read_request(&mut stream)).is_err());
    }

    #[test]
    fn token_equality_matches_bytes() {
        cases(0x544f4b454e, 5_000, |rng| {
            let a = rng.bytes(256);
            let mut b = if rng.below(2) == 0 { a.clone() } else { rng.bytes(256) };
            assert_eq!(same(&a, &b), a == b);
            assert!(same(&a, &a));
            for i in 0..a.len() {
                b = a.clone();
                b[i] ^= 1;
                assert!(!same(&a, &b), "difference at {i}");
            }
            b = a.clone();
            b.push(0);
            assert!(!same(&a, &b));
            assert!(!same(&b, &a));
        });
        assert!(same(b"", b""));
        assert!(!same(b"\0", b""));
    }
}
