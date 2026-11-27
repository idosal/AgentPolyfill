//! The pages `signin` shows in the person's browser (served by oauth.rs on a
//! loopback address of its own): the consent page, and the two that end it.
//! Plain HTML and CSS, no script, nothing loaded from elsewhere (the server's
//! icon, when it has one, was downloaded by about.rs and is embedded).

use crate::about::About;
use crate::vault::Kind;

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
.row{display:flex;gap:10px;margin-top:6px}button{font:600 15px inherit;border-radius:9px;padding:10px 20px;border:1px solid #c4c8cf;background:#fff;cursor:pointer}\
button.ok{background:#2563eb;border-color:#2563eb;color:#fff}.err{background:#fdecea;border:1px solid #f5b5af;color:#8a1c14;border-radius:8px;padding:8px 12px;margin:0 0 16px}\
.who{display:flex;align-items:center;gap:12px;margin:0 0 14px}.who strong{display:block;font-size:15px}.who small{color:#6b7280;font-size:13px}\
.icon{width:44px;height:44px;border-radius:10px;object-fit:contain;background:#f4f5f7;border:1px solid #e5e7eb}.letter{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#4b5563}\
.about{margin:0 0 8px;color:#374151}.links{margin:0 0 16px;font-size:14px}.links a{color:#2563eb}.none{color:#6b7280;font-size:13px;margin:0 0 18px}.scopes code{font-size:13px;color:#4b5563}\
.tog{position:absolute;opacity:0;width:1px;height:1px}.extra{display:none;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:14px}\
#info:checked ~ .extra{display:block}\
.help{margin-left:auto;align-self:center;width:34px;height:34px;box-sizing:border-box;border-radius:50%;border:1px solid #c4c8cf;color:#4b5563;display:flex;align-items:center;justify-content:center;font-weight:600;cursor:pointer}\
#info:checked ~ .row .help{background:#eff4ff;border-color:#2563eb;color:#2563eb}\
.tog:focus-visible ~ .row .help{outline:2px solid #2563eb}\
.q{margin:0 0 10px}.plain{margin:0 0 16px;color:#374151}.more{margin-top:18px;font-size:13px;color:#6b7280}.more a{color:#2563eb}";

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
    format!("<h2>Permissions the server lists</h2><ul class=\"scopes\">{items}</ul><p class=\"none\">These are the server’s own words.</p>")
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

/// The consent page for `name` at `url`; `kind` is where the login will be
/// kept (a global setting, so the page only says it); `token` guards the
/// form; `problem` is what went wrong with the last answer, if anything.
/// The explanations open with a “?” (a hidden checkbox and its label, no script).
pub fn page(name: &str, url: &str, about: &About, kind: Kind, token: &str, problem: Option<&str>) -> String {
    render(false, name, url, about, kind, token, problem)
}

/// The page; `open` shows the explanations (the previews use it).
pub fn render(open: bool, name: &str, url: &str, about: &About, kind: Kind, token: &str, problem: Option<&str>) -> String {
    let title = about.title.as_deref().unwrap_or(name);
    let heading = escape(title);
    let identity = identity(name, url, about);
    let asks = permissions(about);
    let (name, url, token) = (escape(name), escape(url), escape(token));
    let error = problem.map(|p| format!("<p class=\"err\">{}</p>", escape(p))).unwrap_or_default();
    let checked = if open || problem.is_some() { " checked" } else { "" };
    let (keeps, saved) = match kind {
        Kind::Keychain => ("Saved in the macOS Keychain.", "in the macOS Keychain, the safe place where your Mac keeps passwords"),
        Kind::Encrypted => ("Saved in a file protected by your passphrase.", "in a file protected by your passphrase"),
        Kind::File => ("Saved in a plain file, not encrypted.", "in a plain file, which is not encrypted"),
    };
    let good = format!(
        "<h2>Good to know</h2><ul><li><b>Its own sign-in.</b> It is separate from the one Claude Code uses: Claude Code doesn’t list it and can’t cancel it.</li>\
         <li><b>Kept on this computer</b>, {saved}.</li>\
         <li><b>Remove it any time.</b> Type <code>mcp-apps-cli-helper signout {name}</code> in a terminal and it is gone.</li></ul>\
         <p class=\"none\">To change where logins are saved (for every server), set <code>MCP_APPS_CLI_TOKEN_STORE</code> to <code>keychain</code>, <code>encrypted</code> or <code>file</code> before signing in.</p>"
    );
    let buttons = "<button class=\"ok\" name=\"decision\" value=\"accept\">Accept</button><button name=\"decision\" value=\"refuse\" formnovalidate>Refuse</button>";
    let help = "<label for=\"info\" class=\"help\" title=\"More information\" aria-label=\"More information\">?</label>";
    let more = format!("<p class=\"more\">More: <a href=\"{}\" rel=\"noreferrer\">README, “Own sign-in”</a></p>", crate::oauth::MORE);
    let body = format!(
        "{error}{identity}<h1>Sign in to “{heading}”?</h1><p class=\"url\">{url}</p>{asks}\
         <p class=\"plain\">Next, you sign in on the server’s own page. {keeps}</p>\
         <form method=\"post\" action=\"/decision\"><input type=\"hidden\" name=\"t\" value=\"{token}\"><input type=\"checkbox\" class=\"tog\" id=\"info\"{checked}>\
         <div class=\"row\">{buttons}{help}</div><div class=\"extra\">{good}</div></form>{more}"
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

    // What the person is shown: the server, the explanations, where the login goes, both buttons, nothing injected.
    #[test]
    fn the_consent_page_says_what_it_means_and_escapes_what_it_shows() {
        let html = page("de\"mo<b>", "http://127.0.0.1:1/mcp?a=1&b=2", &About::default(), Kind::Keychain, "tok", Some("two <i>different</i>"));
        for needle in ["separate", "signout de&quot;mo&lt;b&gt;", "name=\"t\" value=\"tok\"", "value=\"accept\"", "value=\"refuse\"", "MCP_APPS_CLI_TOKEN_STORE", "Saved in the macOS Keychain.", "a=1&amp;b=2"] {
            assert!(html.contains(needle), "{needle}");
        }
        assert!(!html.contains("<b>de") && !html.contains("<i>different") && !html.contains("<script"), "{html}");
        // The page has no choice of store: it says what is used, and the other kinds say their own.
        assert!(!html.contains("name=\"store\"") && !html.contains("name=\"passphrase\""), "{html}");
        assert!(page("d", "https://m.example/mcp", &About::default(), Kind::File, "t", None).contains("Saved in a plain file, not encrypted."));
        assert!(page("d", "https://m.example/mcp", &About::default(), Kind::Encrypted, "t", None).contains("Saved in a file protected by your passphrase."));
    }

    // With nothing published: no icon, no links, and the page says it does not know the permissions.
    #[test]
    fn without_metadata_the_page_falls_back_to_what_the_person_configured() {
        let html = page("docs", "https://m.example/mcp", &About::default(), Kind::Keychain, "t", None);
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
        let html = page("docs", "https://m.example/mcp", &about, Kind::Keychain, "t", None);
        for needle in ["Sign in to “Docs &lt;Pro&gt;”?", "<img class=\"icon\" src=\"data:image/png;base64,AAAA\"", "Search &quot;docs&quot;", "href=\"https://docs.example/\"", "Privacy policy", "Terms of service", "a=1&amp;b=2", "Permissions the server lists", "<code>read</code>", "Confirm who you are.", "x&lt;y", "signout docs"] {
            assert!(html.contains(needle), "{needle}\n{html}");
        }
        assert!(!html.contains("<Pro>") && !html.contains("<script"), "{html}");
    }

    // Writes the page, closed and open, as files in $CONSENT_PREVIEW_DIR for a look in a browser.
    #[test]
    #[ignore]
    fn preview_the_page() {
        let dir = std::env::var("CONSENT_PREVIEW_DIR").expect("CONSENT_PREVIEW_DIR");
        let about = About {
            title: Some("Acme Docs".into()),
            description: Some("Search the Acme documentation.".into()),
            website: Some("https://acme.example/".into()),
            icon: Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAkUExURQ92bhJ4cP///1igmmSmoYO4tCOBeqfNyjSLhNHl40mXkRF3b2M41LsAAAABYktHRAJmC3xkAAAAB3RJTUUH6gsbESc7/enhzQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0yN1QxNzozOTo1OSswMDowML3eDowAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMjdUMTc6Mzk6NTkrMDA6MDDMg7YwAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTExLTI3VDE3OjM5OjU5KzAwOjAwm5aX7wAAAZFJREFUaN7t1tuOgzAMBFDAufP//7ssbVmwk1CSsbQP8WM8dDiqonaaxowZM2bMmOczL7NuAS2kDFh0CbQVaBJ+AaoE2gv0CC+AIoHeBVqED0CNQEeBDuEPoESgU4EG4QxQIdClAE+4AhQIxArQBA6AE0gUYAkSACZQpgBJyAGgBMoW4Ah5AJBAhQIUoQSAEahYgCGUASACVQoQhBoAQmAAgyaI3wE0gQHsZLEE/sJuclgCA/jtyCMJHBC2s4AkMEDcDyOOwAFpP004Ar/E6366wq4zB5j3uUERqPBBM4jAP8ceG4shcIA7Ng5C4AB/2nkEgQPCaRcABA6Il23sJ3BAumxTN0H8kK2XNb9szwkcYNjedBLmuze8DTwEWJGwXQTxfk5EXBeBA3wm4zsIAhAyodBB4ICYTcVmggCkbCw1E8S/0TUbE5ftW4IAmELQNBLo2+fmNoJ4zBajtokgAK4YdS0EAfCVsG8gCECohMNzggDEajw+JghAqsbTYwJ/oHDJPiMu23L/JYwZM2bMmP83Pxi2Ds5FxdiuAAAAAElFTkSuQmCC".into()),
            docs: Some("https://docs.acme.example/mcp".into()),
            policy: Some("https://acme.example/privacy".into()),
            terms: Some("https://acme.example/terms".into()),
            scopes: vec!["docs:read".into(), "docs:write".into(), "openid".into()],
        };
        for (open, state) in [(false, "ferme"), (true, "ouvert")] {
            let html = render(open, "docs", "https://mcp.acme.example/mcp", &about, Kind::Keychain, "tok", None);
            std::fs::write(format!("{dir}/{state}.html"), html).unwrap();
        }
    }
}
