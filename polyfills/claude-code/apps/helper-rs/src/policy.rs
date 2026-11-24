//! Pure parts of the Node host contract: origins, CSP, results and themes.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const SANDBOX: &str = "allow-scripts allow-forms allow-same-origin allow-pointer-lock";
pub const CSP_KEYS: [&str; 4] = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"];

/// Node's SHA-1-derived image filename. This is an identifier, never a
/// security digest (origins/stores use SHA-256). Avoid another dependency
/// solely for this twelve-character, externally visible filename prefix.
pub fn image_file_stem(id: &str) -> String {
    let mut data = id.as_bytes().to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 { data.push(0); }
    data.extend_from_slice(&bits.to_be_bytes());
    let mut h = [0x67452301u32,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0];
    for block in data.chunks_exact(64) {
        let mut w = [0u32;80];
        for (i, word) in block.chunks_exact(4).enumerate() { w[i] = u32::from_be_bytes(word.try_into().unwrap()); }
        for i in 16..80 { w[i] = (w[i-3]^w[i-8]^w[i-14]^w[i-16]).rotate_left(1); }
        let [mut a,mut b,mut c,mut d,mut e] = h;
        for (i,word) in w.into_iter().enumerate() {
            let (f,k) = match i {
                0..20 => ((b&c)|(!b&d),0x5a827999),
                20..40 => (b^c^d,0x6ed9eba1),
                40..60 => ((b&c)|(b&d)|(c&d),0x8f1bbcdc),
                _ => (b^c^d,0xca62c1d6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(word);
            e=d;d=c;c=b.rotate_left(30);b=a;a=t;
        }
        for (value,delta) in h.iter_mut().zip([a,b,c,d,e]) { *value = value.wrapping_add(delta); }
    }
    hex::encode(h.into_iter().flat_map(u32::to_be_bytes).collect::<Vec<_>>())[..12].into()
}

#[derive(Clone, Debug)]
pub struct Origins {
    pub view: String,
    pub host: String,
}

pub fn origins(url: Option<&str>, domain: Option<&str>) -> Origins {
    if let (Some(url), Some(domain)) = (url.filter(|u| !u.is_empty()), domain) {
        let expected = format!("{}.claudemcpcontent.com", &hex::encode(Sha256::digest(url.as_bytes()))[..32]);
        if domain.to_lowercase() == expected {
            return Origins { view: format!("https://{expected}"), host: format!("https://host.{expected}") };
        }
    }
    Origins { view: "http://mcp-app.localhost".into(), host: "http://host.mcp-app.localhost".into() }
}

pub fn origin(url: &str) -> String {
    url::Url::parse(url).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}

fn sources(value: &Value) -> Vec<&str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str)
        .filter(|s| !s.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ';' | '\'' | '"'))).collect()
}

fn source_host(source: &str) -> Option<(String, String)> {
    let lower = source.to_ascii_lowercase();
    let authority = lower.split_once("://").map_or(lower.as_str(), |(_, a)| a);
    let (host, rest) = if authority.starts_with('[') {
        let end = authority.find(']')? + 1;
        (&authority[..end], &authority[end..])
    } else {
        let end = authority.find([':', '/']).unwrap_or(authority.len());
        (&authority[..end], &authority[end..])
    };
    if host.is_empty() { return None; }
    let port = rest.strip_prefix(':').and_then(|r| {
        let p = r.split('/').next().unwrap_or("");
        (!p.is_empty() && (p == "*" || p.bytes().all(|b| b.is_ascii_digit()))).then_some(p)
    }).unwrap_or(if lower.starts_with("https:") || lower.starts_with("wss:") { "443" } else { "80" });
    Some((host.strip_prefix("*.").unwrap_or(host).into(), port.into()))
}

/// This machine or its local network: `localhost` and `.local` names, and
/// addresses that are loopback, private, link-local or unspecified (an
/// address, parsed: a name like `127.0.0.1.example` is a name).
fn private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host == "local" || host.ends_with(".local") { return true; }
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified(),
        Ok(std::net::IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || ip.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private() || v4.is_link_local())
        }
        Err(_) => false,
    }
}

/// A server on this machine or its local network (its URL's host): its
/// views may reach that network (see Page::new). A stdio server has no URL
/// and runs here.
pub fn local_server(url: &str) -> bool {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).is_some_and(|h| private_host(&h))
}

/// A source that names no one site, and so isn't applied (security review,
/// A4): `*`; a scheme alone (`https:`); a wildcard host (`*`, or `*.` over
/// fewer than two labels, such as `*.com`); a wildcard port (`:*`). Without
/// the public suffix list, a wildcard over a two-label suffix such as
/// `*.co.uk` still passes.
fn too_broad(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    if lower == "*" || ["http:", "https:", "ws:", "wss:"].contains(&lower.as_str()) {
        return true;
    }
    let authority = lower.split_once("://").map_or(lower.as_str(), |(_, a)| a);
    let end = if authority.starts_with('[') {
        authority.find(']').map_or(authority.len(), |e| e + 1)
    } else {
        authority.find([':', '/']).unwrap_or(authority.len())
    };
    let host = &authority[..end];
    if host.is_empty() || authority[end..].strip_prefix(':').is_some_and(|r| r.split('/').next() == Some("*")) {
        return true;
    }
    if !host.contains('*') {
        return false;
    }
    match host.strip_prefix("*.") {
        Some(rest) => rest.contains('*') || rest.split('.').filter(|label| !label.is_empty()).count() < 2,
        None => true,
    }
}

pub fn allowed_csp(csp: &Value, server_url: Option<&str>) -> Value {
    let own = server_url.and_then(|s| url::Url::parse(s).ok()).and_then(|u| {
        Some((u.host_str()?.to_lowercase(), u.port_or_known_default()?.to_string()))
    });
    let mut out = json!({});
    for key in CSP_KEYS {
        let kept: Vec<_> = sources(&csp[key]).into_iter().filter(|s| {
            let broad = too_broad(s);
            let private = source_host(s).is_some_and(|at| private_host(&at.0) && own.as_ref() != Some(&at));
            if broad || private { crate::out::log(format!("declared CSP source not applied: {s}")); }
            !broad && !private
        }).collect();
        if !kept.is_empty() { out[key] = json!(kept); }
    }
    out
}

pub fn build_csp(csp: &Value) -> String {
    let r = sources(&csp["resourceDomains"]).join(" ");
    let c = sources(&csp["connectDomains"]).join(" ");
    let f = sources(&csp["frameDomains"]).join(" ");
    let b = sources(&csp["baseUriDomains"]).join(" ");
    [
        "default-src 'self' 'unsafe-inline'".into(),
        format!("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: {r}"),
        format!("style-src 'self' 'unsafe-inline' blob: data: {r}"),
        format!("img-src 'self' data: blob: {r}"), format!("font-src 'self' data: blob: {r}"),
        format!("media-src 'self' data: blob: {r}"), format!("connect-src 'self' {c}"),
        format!("worker-src 'self' blob: {r}"),
        if f.is_empty() { "frame-src 'none'".into() } else { format!("frame-src {f}") },
        "object-src 'none'".into(),
        if b.is_empty() { "base-uri 'none'".into() } else { format!("base-uri {b}") },
    ].iter().map(|s| s.trim()).collect::<Vec<_>>().join("; ")
}

pub fn normalize_result(result: &Value, structured: bool) -> Value {
    if result.is_null() || result == &json!(false) || result == &json!("") || result == &json!(0) { return Value::Null; }
    let mut call = match result {
        Value::String(text) => json!({"content": [{"type": "text", "text": text}]}),
        Value::Array(_) => json!({"content": result}),
        _ if result["content"].is_array() => result.clone(),
        _ => return json!({"content": [{"type": "text", "text": result.to_string()}], "structuredContent": result}),
    };
    if structured && call["structuredContent"].is_null() && !call["isError"].as_bool().unwrap_or(false) {
        let texts: Vec<_> = call["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").collect();
        if texts.len() == 1 {
            if let Ok(parsed) = serde_json::from_str::<Value>(texts[0]["text"].as_str().unwrap_or("")) {
                if parsed.is_object() { call["structuredContent"] = parsed; }
            }
        }
    }
    call
}

pub fn theme_name(theme: &str) -> &'static str {
    match theme {
        "light" => "light", "dark" => "dark",
        _ => match std::env::var("COLORFGBG").unwrap_or_default().split(';').next_back().unwrap_or("") {
            "7" | "15" => "light", _ => "dark",
        },
    }
}

pub fn theme(scheme: &str) -> Value {
    static THEMES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    THEMES.get_or_init(|| serde_json::from_str(include_str!("../js/themes.json")).expect("theme constants"))[scheme].clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::test_support::cases;

    fn directives(policy: &str) -> std::collections::BTreeMap<&str, Vec<&str>> {
        assert!(!policy.chars().any(char::is_control), "control character in {policy:?}");
        let mut out = std::collections::BTreeMap::new();
        for directive in policy.split(';') {
            let mut words = directive.split_whitespace();
            let name = words.next().unwrap();
            assert!(out.insert(name, words.collect()).is_none(), "duplicate {name}");
        }
        assert_eq!(out.len(), 11, "injected directive in {policy:?}");
        assert_eq!(out["object-src"], ["'none'"]);
        out
    }

    #[test]
    fn whitespace_cannot_inject_additional_sources() {
        for separator in ['\t', '\r', '\n', '\u{000b}', '\u{000c}', '\0', '\u{2028}'] {
            for key in CSP_KEYS {
                let csp = json!({key: [format!("https://good.example{separator}*")]});
                let policy = build_csp(&allowed_csp(&csp, None));
                let parsed = directives(&policy);
                assert_eq!(parsed["frame-src"], ["'none'"], "{csp}");
                assert_eq!(parsed["base-uri"], ["'none'"], "{csp}");
                assert!(!parsed.values().flatten().any(|&s| s == "*"), "{csp}");
                // build_csp also guards its own boundary when used directly.
                assert_eq!(build_csp(&csp), build_csp(&json!({})), "{csp}");
            }
        }
    }

    #[test]
    fn random_domain_lists_preserve_directive_boundaries() {
        cases(0x435350, 3_000, |rng| {
            let mut csp = json!({});
            let mut expected = std::collections::BTreeMap::new();
            for key in CSP_KEYS {
                let mut values = Vec::new();
                let mut kept = Vec::new();
                for i in 0..1 + rng.below(6) {
                    let value = match rng.below(4) {
                        0 => json!(format!("https://d{i}.example/path")),
                        1 => json!(format!("https://safe.example{}*", [';', '\t', '\n', '\r', '\'', '"', ' ', '\u{000c}'][rng.below(8)])),
                        2 => rng.json(2),
                        _ => json!(rng.string(64)),
                    };
                    if let Some(s) = value.as_str() {
                        if !s.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ';' | '\'' | '"')) {
                            kept.push(s.to_string());
                        }
                    }
                    values.push(value);
                }
                csp[key] = json!(values);
                expected.insert(key, kept);
            }
            let meta = json!({"_meta": {"ui": {"csp": csp}}});
            let raw = &meta["_meta"]["ui"]["csp"];
            let policy = build_csp(raw);
            let parsed = directives(&policy);
            for (directive, key) in [("frame-src", "frameDomains"), ("base-uri", "baseUriDomains")] {
                let tokens: Vec<_> = expected[key].iter().filter(|s| !s.is_empty()).map(String::as_str).collect();
                assert_eq!(parsed[directive], if tokens.is_empty() { vec!["'none'"] } else { tokens }, "{raw}");
            }
            for (directive, tokens) in &parsed {
                for token in tokens.iter().filter(|t| t.contains(['\'', '"'])) {
                    assert!(matches!(*token, "'self'" | "'none'" | "'unsafe-inline'" | "'unsafe-eval'"), "{directive}: {token}");
                }
            }
            let filtered = allowed_csp(raw, Some("https://server.example/mcp"));
            let filtered_policy = build_csp(&filtered);
            let filtered_directives = directives(&filtered_policy);
            for name in ["frame-src", "base-uri"] {
                for token in &filtered_directives[name] {
                    assert!(*token == "'none'" || parsed[name].contains(token), "added source: {token}");
                    assert!(!matches!(*token, "*" | "http:" | "https:" | "ws:" | "wss:"));
                }
            }
        });
    }

    #[test]
    fn unrelated_domains_and_malformed_json_cannot_enable_frames_or_base() {
        cases(0x4d455441, 3_000, |rng| {
            for csp in [rng.json(3), json!({"resourceDomains": [rng.string(80)], "connectDomains": [rng.string(80)]})] {
                let policy = build_csp(&allowed_csp(&csp, None));
                let parsed = directives(&policy);
                assert_eq!(parsed["frame-src"], ["'none'"]);
                assert_eq!(parsed["base-uri"], ["'none'"]);
            }
        });
    }

    #[test]
    fn random_origins_never_panic_and_canonical_origins_round_trip() {
        cases(0x4f524947494e, 5_000, |rng| {
            let text = rng.string(128);
            let bytes = rng.bytes(128);
            for s in [text.as_str(), &String::from_utf8_lossy(&bytes)] { let _ = origin(s); }
            let host = format!("d{}.example", rng.next());
            let port = 1024 + rng.below(60_000);
            let want = format!("https://{host}:{port}");
            assert_eq!(origin(&format!("{want}/path?q=1#fragment")), want);
            assert_eq!(origin(&want), want);
        });
        for (url, want) in [("https://EXAMPLE.com:443/a", "https://example.com"), ("http://[::1]:8080/a", "http://[::1]:8080"),
            ("data:text/plain,hello", "null"), ("not a URL", ""), ("http://[", "")] {
            assert_eq!(origin(url), want);
        }
    }
    #[test]
    fn domains_belong_to_the_server() {
        let url = "https://example.com/mcp";
        let domain = format!("{}.claudemcpcontent.com", &hex::encode(Sha256::digest(url))[..32]);
        assert_eq!(origins(Some(url), Some(&domain.to_uppercase())).view, format!("https://{domain}"));
        assert_eq!(origins(None, Some(&domain)).view, "http://mcp-app.localhost");
        assert_eq!(origins(Some(url), Some("other.claudemcpcontent.com")).host, "http://host.mcp-app.localhost");
    }
    #[test]
    fn image_prefix_matches_node_sha1() {
        assert_eq!(image_file_stem(""),"da39a3ee5e6b");
        assert_eq!(image_file_stem("abc"),"a9993e364706");
        assert_eq!(image_file_stem(&"a".repeat(1000)),"291e9a6c6699");
    }
    #[test]
    fn broad_sources_are_not_applied() {
        let broad = ["*", "https:", "http://*", "https://*", "http://*:*", "https://*:443", "wss://*:*", "https://*.com", "*.com",
            "https://example.com:*", "https://*.*.example.com", "https://*.", "https://"];
        let named = ["https://*.example.com", "https://cdn.example.com", "https://example.com:8443", "wss://live.example.com", "blob:", "data:"];
        for source in broad {
            assert!(too_broad(source), "{source} was taken as one site");
        }
        for source in named {
            assert!(!too_broad(source), "{source} was refused");
        }
        let all: Vec<&str> = broad.iter().chain(named.iter()).copied().collect();
        assert_eq!(allowed_csp(&json!({"connectDomains": all}), Some("https://example.com/mcp")), json!({"connectDomains": named}));
    }

    #[test]
    fn local_servers() {
        for url in ["http://localhost:3212/mcp", "http://127.0.0.1:8/mcp", "http://[::1]:9/mcp", "http://10.1.2.3/mcp", "http://box.local:1/mcp", "http://app.localhost/mcp"] {
            assert!(local_server(url), "{url}");
        }
        for url in ["https://example.com/mcp", "https://localtest.me/mcp", "https://127.0.0.1.example/mcp", "https://10.example.com/mcp", "not a url"] {
            assert!(!local_server(url), "{url}");
        }
    }

    #[test]
    fn csp_private_ports_and_injection() {
        let csp = allowed_csp(&json!({"connectDomains": ["*", "https:", "https://*", "http://127.0.0.1:123", "http://127.0.0.1:124", "http://10.0.0.1", "http://[::1]", "https://*.example.com", "evil; connect-src *", "'unsafe-eval'"]}), Some("http://127.0.0.1:123/mcp"));
        assert_eq!(csp, json!({"connectDomains": ["http://127.0.0.1:123", "https://*.example.com"]}));
        let s = build_csp(&csp);
        assert!(s.contains("frame-src 'none'; object-src 'none'; base-uri 'none'"));
        assert!(s.contains("connect-src 'self' http://127.0.0.1:123 https://*.example.com"));
        assert_eq!(allowed_csp(&json!({"frameDomains": ["http://[::1]:90", "http://[::1]:91"]}), Some("http://[::1]:90/mcp"))["frameDomains"], json!(["http://[::1]:90"]));
    }
    #[test]
    fn results_restore_only_schema_objects() {
        assert_eq!(normalize_result(&json!("{\"n\":2}"), true)["structuredContent"], json!({"n":2}));
        assert!(normalize_result(&json!("[1]"), true)["structuredContent"].is_null());
        assert!(normalize_result(&json!({"isError":true,"content":[{"type":"text","text":"{}"}]}), true)["structuredContent"].is_null());
    }
}
