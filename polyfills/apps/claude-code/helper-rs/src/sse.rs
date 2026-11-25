//! MCP's older HTTP transport (HTTP+SSE, 2024-11-05), which rmcp's client
//! no longer carries: a GET opens an event stream whose first event names
//! the endpoint to POST messages to; every later `message` event is one
//! from the server. Bridged to rmcp as a newline-delimited JSON stream.

use anyhow::{Context, Result, anyhow, bail};
use http::HeaderMap;
use http::header::{ACCEPT, CONTENT_TYPE};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

use crate::out::log;

/// Connects: once the server has named its endpoint, the stream rmcp talks
/// over (its lines out are POSTed, the server's events come back as lines).
pub async fn connect(url: &str, headers: HeaderMap) -> Result<DuplexStream> {
    let base = url::Url::parse(url).context("the server's url")?;
    // No redirects, for the stream or the messages: one to another host
    // would carry the server's headers there, outside the browser's
    // protections, and get round the endpoint's origin check below.
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().context("an HTTP client")?;
    let response = client
        .get(base.clone())
        .headers(headers.clone())
        .header(ACCEPT, "text/event-stream")
        .send()
        .await
        .context("opening the server's event stream")?;
    if !response.status().is_success() {
        bail!("the server's event stream answered {}", response.status());
    }
    let mut events = Events { response, buf: Vec::new(), last_cr: false };
    let endpoint = loop {
        match tokio::time::timeout(std::time::Duration::from_secs(30), events.next()).await {
            Ok(Ok(Some((name, data)))) if name == "endpoint" => break data,
            Ok(Ok(Some(_))) => continue,
            Ok(Ok(None)) => bail!("the server closed its event stream before naming its endpoint"),
            Ok(Err(error)) => return Err(error),
            Err(_) => bail!("the server didn't name its endpoint"),
        }
    };
    let endpoint = base.join(endpoint.trim()).context("the server's endpoint")?;
    // As the TypeScript SDK checks: messages go back to the server they came from.
    if endpoint.origin() != base.origin() {
        bail!("the server's endpoint ({endpoint}) isn't on its own origin");
    }

    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (read, mut write) = tokio::io::split(ours);
    tokio::spawn(async move {
        loop {
            match events.next().await {
                Ok(Some((name, data))) if name.is_empty() || name == "message" => {
                    if write.write_all(data.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                        break;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(error) => {
                    log(format!("event stream: {error:#}"));
                    break;
                }
            }
        }
        // The stream ended: rmcp reads its end, and the connection closes.
        let _ = write.shutdown().await;
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            // Each on its own: a server that answers its POST only once it
            // has handled the message doesn't hold up the next.
            let post = client.post(endpoint.clone()).headers(headers.clone()).header(CONTENT_TYPE, "application/json").body(line);
            tokio::spawn(async move {
                match post.send().await {
                    Ok(answer) if answer.status().is_success() => {}
                    Ok(answer) => log(format!("the server's endpoint answered {}", answer.status())),
                    Err(error) => log(format!("posting to the server: {error}")),
                }
            });
        }
    });
    Ok(theirs)
}

/// Server-sent events, read off the response as they arrive.
struct Events {
    response: reqwest::Response,
    buf: Vec<u8>,
    last_cr: bool,
}

impl Events {
    fn push_chunk(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            // CR, LF and CRLF each end one line, even across response chunks.
            if byte != b'\n' || !self.last_cr {
                self.buf.push(if byte == b'\r' { b'\n' } else { byte });
            }
            self.last_cr = byte == b'\r';
        }
    }

    fn buffered(&mut self) -> Option<(String, String)> {
        while let Some(at) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buf.drain(..at + 2).collect();
            if let Some(event) = parse(&String::from_utf8_lossy(&block)) {
                return Some(event);
            }
        }
        None
    }

    /// The next event, `(name, data)`: the name empty if none was given.
    async fn next(&mut self) -> Result<Option<(String, String)>> {
        loop {
            if let Some(event) = self.buffered() {
                return Ok(Some(event));
            }
            match self.response.chunk().await.map_err(|e| anyhow!("reading the event stream: {e}"))? {
                Some(bytes) => self.push_chunk(&bytes),
                None => return Ok(None),
            }
        }
    }
}

/// One event's lines: `event:` its name, `data:` lines its data (joined by
/// newlines), comments and other fields left out.
fn parse(block: &str) -> Option<(String, String)> {
    let mut name = String::new();
    let mut data: Vec<&str> = Vec::new();
    for line in block.split(['\r', '\n']) {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => name = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }
    (!data.is_empty()).then(|| (name, data.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::test_support::cases;

    fn empty_events() -> Events {
        Events { response: http::Response::new(Vec::<u8>::new()).into(), buf: Vec::new(), last_cr: false }
    }

    fn collect(chunks: &[&[u8]]) -> Vec<(String, String)> {
        let mut events = empty_events();
        let mut out = Vec::new();
        for chunk in chunks {
            events.push_chunk(chunk);
            while let Some(event) = events.buffered() { out.push(event); }
        }
        out
    }

    #[test]
    fn cr_crlf_comments_and_multiline_data_at_every_boundary() {
        for ending in ["\n", "\r", "\r\n"] {
            let stream = [": comment", "", "event: message", "data: one", "data:  two", "id: ignored", "", "data", "", "data: unfinished"]
                .join(ending);
            let expected = vec![("message".into(), "one\n two".into()), ("".into(), "".into())];
            for split in 0..=stream.len() {
                assert_eq!(collect(&[&stream.as_bytes()[..split], &stream.as_bytes()[split..]]), expected, "ending={ending:?}, split={split}");
            }
            assert_eq!(collect(&stream.as_bytes().chunks(1).collect::<Vec<_>>()), expected);
        }
        assert_eq!(parse("event: message\rdata: one\rdata: two"), Some(("message".into(), "one\ntwo".into())));
    }

    #[test]
    fn generated_event_streams_are_chunk_invariant() {
        cases(0x535345, 3_000, |rng| {
            let mut bytes = Vec::new();
            let mut expected = Vec::new();
            for _ in 0..1 + rng.below(3) {
                let name = rng.string(8).replace(['\r', '\n'], "");
                let lines: Vec<_> = (0..1 + rng.below(3)).map(|_| rng.string(8).replace(['\r', '\n'], "")).collect();
                let ending = ["\n", "\r\n", "\r"][rng.below(3)];
                bytes.extend_from_slice(format!(": keepalive{ending}event: {name}{ending}").as_bytes());
                for line in &lines { bytes.extend_from_slice(format!("data: {line}{ending}").as_bytes()); }
                bytes.extend_from_slice(ending.as_bytes());
                expected.push((name, lines.join("\n")));
            }
            for split in 0..=bytes.len() {
                assert_eq!(collect(&[&bytes[..split], &bytes[split..]]), expected, "split={split}, bytes={bytes:?}");
            }
            let mut chunks = Vec::new();
            let mut at = 0;
            while at < bytes.len() {
                let end = (at + 1 + rng.below(17)).min(bytes.len());
                chunks.push(&bytes[at..end]);
                at = end;
            }
            assert_eq!(collect(&chunks), expected);
        });
    }

    #[test]
    fn random_invalid_utf8_is_chunk_invariant_and_never_panics() {
        cases(0x55544638, 3_000, |rng| {
            let mut bytes = b"data: ".to_vec();
            bytes.extend(rng.bytes(128));
            bytes.extend_from_slice(b"\n\n");
            let _ = parse(&String::from_utf8_lossy(&bytes));
            let expected = collect(&[&bytes]);
            for split in 0..=bytes.len() {
                assert_eq!(collect(&[&bytes[..split], &bytes[split..]]), expected, "split={split}, bytes={bytes:?}");
            }
        });
        let bytes = b"data: \xf0\x9f\x98\x80\xff\xc0\n\n";
        assert_eq!(collect(&bytes.chunks(1).collect::<Vec<_>>()), vec![("".into(), "😀��".into())]);
    }

    #[tokio::test]
    async fn events_next_drains_completed_events_and_discards_unterminated_tail() {
        for bytes in [b"data: tail".as_slice(), b"data: tail\n", b"data: tail\r\n"] {
            assert_eq!(parse(&String::from_utf8_lossy(bytes)), Some(("".into(), "tail".into())));
            let mut events = Events { response: http::Response::new(bytes.to_vec()).into(), buf: Vec::new(), last_cr: false };
            // An SSE event needs a blank line; EOF does not dispatch it.
            assert_eq!(events.next().await.unwrap(), None);
        }
        let mut events = Events { response: http::Response::new(b": comment\r\nevent: endpoint\r\ndata: /mcp\r\n\r\ndata: second\r\rdata: tail".to_vec()).into(), buf: Vec::new(), last_cr: false };
        assert_eq!(events.next().await.unwrap(), Some(("endpoint".into(), "/mcp".into())));
        assert_eq!(events.next().await.unwrap(), Some(("".into(), "second".into())));
        assert_eq!(events.next().await.unwrap(), None);
        assert_eq!(events.next().await.unwrap(), None);
    }

    #[test]
    fn events() {
        assert_eq!(parse("event: endpoint\ndata: /messages?session=1\n\n"), Some(("endpoint".into(), "/messages?session=1".into())));
        assert_eq!(parse("data: {\"a\":1}\n\n"), Some((String::new(), "{\"a\":1}".into())));
        assert_eq!(parse(": keepalive\n\n"), None);
        assert_eq!(parse("event: message\ndata:one\ndata: two\nid: 3\n\n"), Some(("message".into(), "one\ntwo".into())));
    }
}
