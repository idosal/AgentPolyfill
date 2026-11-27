//! The pages `signin` shows in the person's browser (served by oauth.rs on a
//! loopback address of its own): the consent page, and the two that end it.
//! Plain HTML and CSS, no script, nothing loaded from elsewhere (the server's
//! icon, when it has one, was downloaded by about.rs and is embedded).

use crate::about::About;

/// Text safe to put in HTML.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

const STYLE: &str = "\
body{margin:0;background:#f4f5f7;color:#1c1e21;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;padding:48px 16px}\
main{width:100%;max-width:560px;background:#fff;border:1px solid #d9dce1;border-radius:14px;padding:28px 30px;box-shadow:0 2px 10px rgba(0,0,0,.05)}\
h1{font-size:22px;margin:0 0 2px}.url{font:13px ui-monospace,Menlo,monospace;color:#6b7280;margin:0 0 18px;word-break:break-all}\
ul{margin:0 0 20px;padding-left:20px}li{margin:6px 0}h2{font-size:15px;margin:0 0 8px}\
label.opt{display:block;border:1px solid #d9dce1;border-radius:10px;padding:10px 12px;margin:0 0 8px;cursor:pointer}\
input:checked + label.opt{border-color:#2563eb;background:#eff4ff}label.opt small{display:block;color:#6b7280}input[type=radio]{margin-right:8px}\
.pass{display:none;margin:0 0 8px 28px}input#enc:checked ~ .pass{display:block}\
.pass input{display:block;width:100%;box-sizing:border-box;padding:8px;margin:4px 0;border:1px solid #c4c8cf;border-radius:8px;font-size:15px}\
details{margin:0 0 20px}summary{cursor:pointer;color:#4b5563;font-size:14px}\
.row{display:flex;gap:10px;margin-top:20px}button{font:600 15px inherit;border-radius:9px;padding:10px 20px;border:1px solid #c4c8cf;background:#fff;cursor:pointer}\
button.ok{background:#2563eb;border-color:#2563eb;color:#fff}.err{background:#fdecea;border:1px solid #f5b5af;color:#8a1c14;border-radius:8px;padding:8px 12px;margin:0 0 16px}\
.who{display:flex;align-items:center;gap:12px;margin:0 0 14px}.who strong{display:block;font-size:15px}.who small{color:#6b7280;font-size:13px}\
.icon{width:44px;height:44px;border-radius:10px;object-fit:contain;background:#f4f5f7;border:1px solid #e5e7eb}.letter{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#4b5563}\
.about{margin:0 0 8px;color:#374151}.links{margin:0 0 16px;font-size:14px}.links a{color:#2563eb}.none{color:#6b7280;font-size:13px;margin:0 0 18px}.scopes code{font-size:13px;color:#4b5563}\
.more{margin-top:18px;font-size:13px;color:#6b7280}.more a{color:#2563eb}";

fn shell(title: &str, body: &str) -> String {
    format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{STYLE}</style><main>{body}</main></html>", escape(title))
}

/// The icon (or, without one, the first letter), the name the person gave it
/// and the links the server published.
fn identity(name: &str, url: &str, about: &About) -> String {
    let badge = match &about.icon {
        Some(icon) => format!("<img class=\"icon\" src=\"{}\" alt=\"\">", escape(icon)),
        None => format!("<span class=\"icon letter\">{}</span>", escape(&name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default())),
    };
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let mut links = Vec::new();
    for (label, target) in [("Website", &about.website), ("Documentation", &about.docs), ("Privacy policy", &about.policy), ("Terms of service", &about.terms)] {
        if let Some(target) = target {
            links.push(format!("<a href=\"{}\" rel=\"noreferrer noopener\" target=\"_blank\">{label}</a>", escape(target)));
        }
    }
    let links = if links.is_empty() { String::new() } else { format!("<p class=\"links\">{}</p>", links.join(" · ")) };
    let about_text = about.description.as_ref().map(|d| format!("<p class=\"about\">{}</p>", escape(d))).unwrap_or_default();
    format!("<div class=\"who\">{badge}<div><strong>{}</strong><small>{}</small></div></div>{about_text}{links}", escape(name), escape(&host))
}

/// What the server lists as the permissions it asks for, as the server wrote
/// them; only the standard OpenID Connect words get a plain sentence. Without
/// a list, the page says so instead of guessing.
fn permissions(about: &About) -> String {
    if about.scopes.is_empty() {
        return "<h2>Permissions</h2><p class=\"none\">This server does not say which permissions it asks for. Its own sign-in page, next, shows them.</p>".to_string();
    }
    let items: String = about
        .scopes
        .iter()
        .map(|scope| match plain(scope) {
            Some(sentence) => format!("<li>{sentence} <code>{}</code></li>", escape(scope)),
            None => format!("<li><code>{}</code></li>", escape(scope)),
        })
        .collect();
    format!("<h2>Permissions the server lists</h2><ul class=\"scopes\">{items}</ul><p class=\"none\">As the server words them; the helper can’t say more than the server does.</p>")
}

/// The standard OpenID Connect scopes in plain words.
fn plain(scope: &str) -> Option<&'static str> {
    Some(match scope {
        "openid" => "Confirm who you are.",
        "email" => "See your email address.",
        "profile" => "See your name and profile.",
        "offline_access" => "Stay signed in without asking you again.",
        _ => return None,
    })
}

/// The consent page for `name` at `url`; `token` guards the form; `problem`
/// is what went wrong with the last answer, if anything.
pub fn page(name: &str, url: &str, about: &About, token: &str, problem: Option<&str>) -> String {
    let title = about.title.as_deref().unwrap_or(name);
    let heading = escape(title);
    let identity = identity(name, url, about);
    let asks = permissions(about);
    let (name, url, token) = (escape(name), escape(url), escape(token));
    let error = problem.map(|p| format!("<p class=\"err\">{}</p>", escape(p))).unwrap_or_default();
    let mac = cfg!(target_os = "macos");
    let stores = if mac {
        "<input type=\"radio\" name=\"store\" value=\"keychain\" id=\"kc\" checked hidden>\
         <label class=\"opt\" for=\"kc\"><b>macOS Keychain</b> (recommended)<small>Encrypted by macOS, unlocked with your session.</small></label>\
         <input type=\"radio\" name=\"store\" value=\"encrypted\" id=\"enc\" hidden>\
         <label class=\"opt\" for=\"enc\"><b>File encrypted with a passphrase</b><small>You set the passphrase now; the helper reads it from the environment later.</small></label>\
         <div class=\"pass\"><input type=\"password\" name=\"passphrase\" placeholder=\"Passphrase (8 characters or more)\" autocomplete=\"new-password\"><input type=\"password\" name=\"again\" placeholder=\"Passphrase again\" autocomplete=\"new-password\"></div>\
         <details><summary>Advanced</summary><label class=\"opt\" style=\"margin-top:8px\"><input type=\"radio\" name=\"store\" value=\"file\">Plain file, not encrypted<small>Only for a machine with no Keychain. Anyone who can read your files can read it.</small></label></details>"
    } else {
        "<p>Only a plain file is available on this system for now (macOS gets the Keychain and encrypted files first).</p>\
         <label class=\"opt\"><input type=\"radio\" name=\"store\" value=\"file\" checked>Plain file, not encrypted<small>Anyone who can read your files can read it.</small></label>"
    };
    // The radio inputs are hidden and chosen through their labels; the checked
    // one decides which fields show (CSS only, see `.pass`).
    let body = format!(
        "{error}{identity}<h1>Sign in to “{heading}”?</h1><p class=\"url\">{url}</p>{asks}\
         <h2>What this means</h2><ul><li>The helper gets <b>its own login</b> to {name}. Claude Code’s sign-in is not used.</li>\
         <li>Claude Code’s <code>/mcp</code> and your organisation’s MCP rules <b>can’t see or cancel</b> it.</li>\
         <li>It stays until you run <code>mcp-apps-cli-helper signout {name}</code>.</li></ul>\
         <form method=\"post\" action=\"/decision\"><input type=\"hidden\" name=\"t\" value=\"{token}\"><h2>Where to keep the login</h2>{stores}\
         <div class=\"row\"><button class=\"ok\" name=\"decision\" value=\"accept\">Accept</button><button name=\"decision\" value=\"refuse\" formnovalidate>Refuse</button></div></form>\
         <p class=\"more\">More: <a href=\"{more}\" rel=\"noreferrer\">README, “Own sign-in”</a></p>",
        more = crate::oauth::MORE
    );
    shell(&format!("Sign in to {title}?"), &body)
}

pub fn refused_page(name: &str) -> String {
    shell("Not signed in", &format!("<h1>Not signed in</h1><p>Nothing was kept for “{}”. You can close this tab.</p>", escape(name)))
}

pub fn done_page() -> String {
    shell("Signed in", "<h1>Signed in</h1><p>You can close this tab and go back to the terminal.</p>")
}

#[cfg(test)]
mod tests {
    use super::*;

    // What the person is shown: the server, three points, the stores, both buttons, nothing injected.
    #[test]
    fn the_consent_page_says_what_it_means_and_escapes_what_it_shows() {
        let html = page("de\"mo<b>", "http://127.0.0.1:1/mcp?a=1&b=2", &About::default(), "tok", Some("two <i>different</i>"));
        for needle in ["its own login", "can’t see or cancel", "signout de&quot;mo&lt;b&gt;", "name=\"t\" value=\"tok\"", "value=\"accept\"", "value=\"refuse\"", "Plain file, not encrypted", "a=1&amp;b=2"] {
            assert!(html.contains(needle), "{needle}");
        }
        assert!(!html.contains("<b>de") && !html.contains("<i>different") && !html.contains("<script"), "{html}");
        if cfg!(target_os = "macos") {
            assert!(html.contains("macOS Keychain") && html.contains("File encrypted with a passphrase"));
        }
    }

    // With nothing published: no icon, no links, and the page says it does not know the permissions.
    #[test]
    fn without_metadata_the_page_falls_back_to_what_the_person_configured() {
        let html = page("docs", "https://m.example/mcp", &About::default(), "t", None);
        for needle in ["Sign in to “docs”?", "class=\"icon letter\">D<", "m.example", "does not say which permissions"] {
            assert!(html.contains(needle), "{needle}");
        }
        assert!(!html.contains("<img") && !html.contains("class=\"links\"") && !html.contains("class=\"about\""), "{html}");
    }

    // With metadata: title, icon, site, links, permissions in the server's words; everything escaped.
    #[test]
    fn with_metadata_the_page_shows_who_it_is_and_what_it_asks() {
        let about = About {
            title: Some("Docs <Pro>".into()),
            description: Some("Search \"docs\"".into()),
            website: Some("https://docs.example/".into()),
            icon: Some("data:image/png;base64,AAAA".into()),
            policy: Some("https://docs.example/privacy?a=1&b=2".into()),
            terms: Some("https://docs.example/terms".into()),
            scopes: vec!["read".into(), "openid".into(), "x<y".into()],
            ..About::default()
        };
        let html = page("docs", "https://m.example/mcp", &about, "t", None);
        for needle in ["Sign in to “Docs &lt;Pro&gt;”?", "<img class=\"icon\" src=\"data:image/png;base64,AAAA\"", "Search &quot;docs&quot;", "href=\"https://docs.example/\"", "Privacy policy", "Terms of service", "a=1&amp;b=2", "Permissions the server lists", "<code>read</code>", "Confirm who you are.", "x&lt;y", "signout docs"] {
            assert!(html.contains(needle), "{needle}\n{html}");
        }
        assert!(!html.contains("<Pro>") && !html.contains("<script"), "{html}");
    }
}
