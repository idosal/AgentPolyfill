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
h1{font-size:22px;line-height:1.3;margin:0 0 8px}.url{font:13px ui-monospace,Menlo,monospace;color:#6b7280;margin:0 0 18px;word-break:break-all}\
ul{margin:0 0 20px;padding-left:20px}li{margin:6px 0}h2{font-size:15px;margin:0 0 8px}\
.row{display:flex;gap:10px;margin-top:6px}button{font:600 15px inherit;border-radius:9px;padding:10px 20px;border:1px solid #c4c8cf;background:#fff;cursor:pointer}\
button.ok{background:#2563eb;border-color:#2563eb;color:#fff}.err{background:#fdecea;border:1px solid #f5b5af;color:#8a1c14;border-radius:8px;padding:8px 12px;margin:0 0 16px}\
.who{display:flex;align-items:center;gap:12px;margin:0 0 14px}.who strong{display:block;font-size:15px}.who small{color:#6b7280;font-size:13px}\
.icon{width:44px;height:44px;border-radius:10px;object-fit:contain;background:#f4f5f7;border:1px solid #e5e7eb}.letter{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#4b5563}\
.about{margin:0 0 8px;color:#374151}.links{margin:0 0 16px;font-size:14px}.links a{color:#2563eb}.none{color:#6b7280;font-size:13px;margin:0 0 18px}.perms{list-style:none;padding:0;margin:0 0 6px}.perms li{padding:8px 0 8px 26px;position:relative;border-bottom:1px solid #f0f1f3}.perms li:before{content:'\\2713';position:absolute;left:4px;color:#2563eb;font-weight:700}.perms small{color:#9ca3af;font-size:12px;margin-left:6px}.also{color:#6b7280;font-size:13px;margin:0 0 6px}.lead{margin:0 0 14px;color:#374151}.status{display:flex;gap:10px;align-items:center;margin:14px 0 8px;min-height:30px}.status b{font-size:14px;font-weight:500}.dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700}.dot.ok{background:#16a34a}.dot.warn{background:#d97706}\
.tools{margin-left:auto;display:flex;gap:4px;align-self:center}.tool{position:relative;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#6b7280;cursor:pointer}.tool:hover,.tool:focus-visible{background:#f0f1f3;outline:none}.tool svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.tool.warn{color:#c2791c}\
.tool[data-tip]:hover:after,.tool[data-tip]:focus-visible:after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);right:0;white-space:nowrap;background:#1f2937;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;pointer-events:none}#info:checked ~ .row .gear{background:#f0f1f3;color:#1f2937}.tog:focus-visible ~ .row .gear{outline:2px solid #2563eb}\
.tog{position:absolute;opacity:0;width:1px;height:1px}.extra{display:none;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:14px}\
#info:checked ~ .extra{display:block}\
.plain{margin:0 0 16px;color:#374151}.more{margin-top:18px;font-size:13px;color:#6b7280}.more a{color:#2563eb}";

fn shell(title: &str, body: &str) -> String {
    format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{STYLE}</style><main>{body}</main></html>", escape(title))
}

/// What the page calls the thing that asks: the tool's own name, said to be a
/// Claude Code add-on.
pub const APP: &str = "mcp-apps-cli";

/// The words of the page.
pub struct Words {
    pub heading: String,
    pub lead: String,
    /// Above the list of permissions.
    pub list_heading: String,
    /// In place of the list, when the server names no permissions.
    pub no_list: String,
    pub go: String,
    pub cancel: &'static str,
}

pub fn words(title: &str) -> Words {
    Words {
        heading: format!("{APP} wants to use your {title} account"),
        lead: "A Claude Code add-on.".into(),
        list_heading: "It will be able to:".into(),
        no_list: format!("{title} lists what it can access on the next page."),
        go: format!("Continue to {title}"),
        cancel: "Cancel",
    }
}

/// The icon (or, without one, the first letter) with the name and the web
/// address of the server, its description and the links it published.
fn identity(title: &str, url: &str, about: &About) -> String {
    let badge = match &about.icon {
        Some(icon) => format!("<img class=\"icon\" src=\"{}\" alt=\"\">", escape(icon)),
        None => format!("<span class=\"icon letter\">{}</span>", escape(&title.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default())),
    };
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    format!("<div class=\"who\">{badge}<div><strong>{}</strong><small>{}</small></div></div>", escape(title), escape(&host))
}

/// A permission in everyday words, when its name says it: the standard
/// OpenID Connect ones, and the common `thing:read`, `write`, `thing.delete`
/// forms. None: the server's word is shown as it is.
pub fn plain(scope: &str, title: &str) -> Option<String> {
    match scope {
        "openid" => return Some("Confirm who you are".into()),
        "email" => return Some("See your email address".into()),
        "profile" => return Some("See your name and profile".into()),
        "offline_access" => return Some("Stay logged in".into()),
        _ => {}
    }
    let parts: Vec<&str> = scope.split([':', '.', '/', '_', '-']).filter(|p| !p.is_empty()).collect();
    let (verb, object) = parts.split_last()?;
    let verb = match *verb {
        "read" | "view" | "get" | "list" => "Read",
        "write" | "edit" | "update" | "create" => "Edit",
        "delete" => "Delete",
        "admin" | "manage" => "Manage",
        _ => return None,
    };
    if object.iter().any(|o| !o.chars().all(|c| c.is_ascii_lowercase())) {
        return None;
    }
    Some(if object.is_empty() { format!("{verb} your data in {title}") } else { format!("{verb} your {}", object.join(" ")) })
}

/// The permissions as a list in everyday words, each with the server's own
/// word in small print; the ones that can't be put in words go on one line.
fn permissions(about: &About, title: &str, w: &Words) -> String {
    if about.scopes.is_empty() {
        return format!("<p class=\"lead\">{}</p>", escape(&w.no_list));
    }
    let mut items = String::new();
    let mut raw = Vec::new();
    for scope in &about.scopes {
        match plain(scope, title) {
            Some(sentence) => items.push_str(&format!("<li>{}<small>{}</small></li>", escape(&sentence), escape(scope))),
            None => raw.push(format!("<code>{}</code>", escape(scope))),
        }
    }
    let heading = if w.list_heading.is_empty() { String::new() } else { format!("<p class=\"lead\">{}</p>", escape(&w.list_heading)) };
    let list = if items.is_empty() { String::new() } else { format!("<ul class=\"perms\">{items}</ul>") };
    let also = if raw.is_empty() { String::new() } else { format!("<p class=\"also\">{} {}</p>", if items.is_empty() { "Access named" } else { "And" }, raw.join(", ")) };
    format!("{heading}{list}{also}")
}

/// The storage line: whether it is fine (a green check) or a warning, and its words. A
/// passphrase-locked file is as safe as the Keychain (the same strong encryption), so it is
/// green too; only the plain file is a warning.
pub fn storage_status(kind: Kind) -> (bool, &'static str) {
    match kind {
        Kind::Keychain => (true, "Saved securely on this Mac"),
        Kind::Encrypted => (true, "Locked with your passphrase"),
        Kind::File => (false, "Not encrypted"),
    }
}

const LOCK: &str = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 8 0v3\"/></svg>";
const LOCK_OPEN: &str = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 7.4-2\"/></svg>";
const GEAR: &str = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"6.5\"/><circle cx=\"12\" cy=\"12\" r=\"2.3\"/><path d=\"M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1\"/></svg>";

/// The consent page for `name` at `url`; `kind` is where the login will be
/// kept (a global setting, so the page only says it, with a lock); `token`
/// guards the form; `problem` is what went wrong with the last answer, if
/// anything. The details open with the gear (a hidden checkbox and its label,
/// no script).
pub fn page(name: &str, url: &str, about: &About, kind: Kind, token: &str, problem: Option<&str>) -> String {
    render(false, name, url, about, kind, token, problem)
}

/// The page; `open` shows the details (the previews use it).
pub fn render(open: bool, name: &str, url: &str, about: &About, kind: Kind, token: &str, problem: Option<&str>) -> String {
    let title = about.title.as_deref().unwrap_or(name);
    let w = words(title);
    let identity = identity(title, url, about);
    let perms = permissions(about, title, &w);
    let (url, name_html, token) = (escape(url), escape(name), escape(token));
    let error = problem.map(|p| format!("<p class=\"err\">{}</p>", escape(p))).unwrap_or_default();
    let checked = if open || problem.is_some() { " checked" } else { "" };
    // A closed lock for the Keychain and a passphrase-locked file (the same strong
    // encryption); an open one, with a touch of amber, only for the plain file.
    let (good, headline) = storage_status(kind);
    let lock = format!(
        "<span class=\"tool{}\" tabindex=\"0\" role=\"img\" data-tip=\"{headline}\" aria-label=\"{headline}\">{}</span>",
        if good { "" } else { " warn" },
        if good { LOCK } else { LOCK_OPEN }
    );
    let gear = format!("<label for=\"info\" class=\"tool gear\" data-tip=\"Settings and details\" aria-label=\"Settings and details\">{GEAR}</label>");
    let saved = match kind {
        Kind::Keychain => "Saved in the Keychain, the password vault of your Mac.",
        Kind::Encrypted => "Saved in a file locked with your passphrase.",
        Kind::File => "Saved in a plain file, not encrypted.",
    };
    let mut links = Vec::new();
    for (label, target) in [("Website", &about.website), ("Documentation", &about.docs), ("Privacy policy", &about.policy), ("Terms of service", &about.terms)] {
        if let Some(target) = target {
            links.push(format!("<a href=\"{}\" rel=\"noreferrer noopener\" target=\"_blank\">{label}</a>", escape(target)));
        }
    }
    let links = if links.is_empty() { String::new() } else { format!("<li>{}</li>", links.join(" · ")) };
    let lead = format!("<p class=\"lead\">{}</p>", escape(&w.lead));
    let about_text = about.description.as_ref().map(|d| format!("<li>{}</li>", escape(d))).unwrap_or_default();
    let details = format!(
        "<ul>{about_text}<li>{saved} To change: set <code>MCP_APPS_CLI_TOKEN_STORE</code> · <a href=\"{more}\" rel=\"noreferrer noopener\" target=\"_blank\">README</a></li>\
         <li>Separate from Claude Code’s own login: it doesn’t list or cancel it.</li>\
         <li>To disconnect: <code>mcp-apps-cli-helper signout {name_html}</code></li>{links}\
         <li><code>{url}</code></li></ul>",
        more = crate::oauth::MORE
    );
    let body = format!(
        "{error}{identity}<h1>{}</h1>{lead}{perms}\
         <form method=\"post\" action=\"/decision\"><input type=\"hidden\" name=\"t\" value=\"{token}\"><input type=\"checkbox\" class=\"tog\" id=\"info\"{checked}>\
         <div class=\"row\"><button class=\"ok\" name=\"decision\" value=\"accept\">{}</button><button name=\"decision\" value=\"refuse\" formnovalidate>{}</button><div class=\"tools\">{lock}{gear}</div></div>\
         <div class=\"extra\">{details}</div></form>",
        escape(&w.heading),
        escape(&w.go),
        w.cancel
    );
    shell(&w.heading, &body)
}

pub fn refused_page(_name: &str) -> String {
    shell("Cancelled", "<h1>Cancelled</h1><p>Nothing was connected. You can close this tab.</p>")
}

pub fn done_page() -> String {
    shell("You’re connected", "<h1>You’re connected</h1><p>You can close this tab and go back to where you started.</p>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> About {
        About {
            title: Some("Docs <Pro>".into()),
            description: Some("Search \"docs\"".into()),
            website: Some("https://docs.example/".into()),
            icon: Some("data:image/png;base64,AAAA".into()),
            policy: Some("https://docs.example/privacy?a=1&b=2".into()),
            terms: Some("https://docs.example/terms".into()),
            scopes: vec!["docs:read".into(), "openid".into(), "default".into(), "x<y".into()],
            ..About::default()
        }
    }

    // What the person is shown: who asks, what for, the buttons, the details behind "?", nothing injected.
    #[test]
    fn the_consent_page_says_who_asks_what_for_and_escapes_what_it_shows() {
        let html = page("de\"mo<b>", "http://127.0.0.1:1/mcp?a=1&b=2", &About::default(), Kind::Keychain, "tok", Some("two <i>different</i>"));
        for needle in ["Separate from Claude Code", "signout de&quot;mo&lt;b&gt;", "name=\"t\" value=\"tok\"", "value=\"accept\"", "value=\"refuse\"", "Continue to de&quot;mo&lt;b&gt;", "Cancel", "MCP_APPS_CLI_TOKEN_STORE", "Settings and details", "Saved securely on this Mac", "a=1&amp;b=2"] {
            assert!(html.contains(needle), "{needle}");
        }
        assert!(!html.contains("<b>de") && !html.contains("<i>different") && !html.contains("<script"), "{html}");
        // No choice of store, no jargon in the words that are always shown.
        assert!(!html.contains("name=\"store\"") && !html.contains("name=\"passphrase\""), "{html}");
        assert!(page("d", "https://m.example/mcp", &About::default(), Kind::File, "t", None).contains("Not encrypted") && page("d", "https://m.example/mcp", &About::default(), Kind::File, "t", None).contains("tool warn"));
        assert!(page("d", "https://m.example/mcp", &About::default(), Kind::Encrypted, "t", None).contains("Locked with your passphrase"));
    }

    // With nothing published: the configured name, its first letter as the icon, and a plain line instead of a list.
    #[test]
    fn without_metadata_the_page_falls_back_to_what_the_person_configured() {
        let html = page("docs", "https://m.example/mcp", &About::default(), Kind::Keychain, "t", None);
        for needle in ["wants to use your docs account", "class=\"icon letter\">D<", "m.example", "lists what it can access on the next page"] {
            assert!(html.contains(needle), "{needle}");
        }
        assert!(!html.contains("<img") && !html.contains("class=\"perms\"") && !html.contains("<li>Search"), "{html}");
    }

    // With metadata: title, icon, description, links, permissions in everyday words with the server's own word in small print.
    #[test]
    fn with_metadata_the_page_shows_who_it_is_and_what_it_asks() {
        let html = page("docs", "https://m.example/mcp", &full(), Kind::Keychain, "t", None);
        for needle in ["Docs &lt;Pro&gt;", "<img class=\"icon\" src=\"data:image/png;base64,AAAA\"", "<li>Search &quot;docs&quot;</li>", "href=\"https://docs.example/\"", "Privacy policy", "Terms of service", "a=1&amp;b=2", "Read your docs<small>docs:read</small>", "Confirm who you are<small>openid</small>", "<code>default</code>, <code>x&lt;y</code>", "signout docs"] {
            assert!(html.contains(needle), "{needle}\n{html}");
        }
        assert!(!html.contains("<Pro>") && !html.contains("<script"), "{html}");
    }

    #[test]
    fn a_permission_is_put_in_words_only_when_its_name_says_it() {
        assert_eq!(plain("docs:write", "A").as_deref(), Some("Edit your docs"));
        assert_eq!(plain("read", "Acme").as_deref(), Some("Read your data in Acme"));
        assert_eq!(plain("project.delete", "A").as_deref(), Some("Delete your project"));
        assert_eq!(plain("offline_access", "A").as_deref(), Some("Stay logged in"));
        assert_eq!(plain("default", "A"), None);
        assert_eq!(plain("mcp", "A"), None);
        assert_eq!(plain("Org:Read", "A"), None);
    }

    // Writes the page, closed and open, for each store, as files in $CONSENT_PREVIEW_DIR for a look in a browser.
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
            std::fs::write(format!("{dir}/{state}-trousseau.html"), html).unwrap();
        }
        std::fs::write(format!("{dir}/ferme-fichier.html"), render(false, "docs", "https://mcp.acme.example/mcp", &about, Kind::File, "tok", None)).unwrap();
        std::fs::write(format!("{dir}/ouvert-fichier.html"), render(true, "docs", "https://mcp.acme.example/mcp", &about, Kind::File, "tok", None)).unwrap();
        let bare = About { title: Some("Acme Docs".into()), ..About::default() };
        std::fs::write(format!("{dir}/ferme-sans.html"), render(false, "docs", "https://mcp.acme.example/mcp", &bare, Kind::Keychain, "tok", None)).unwrap();
    }
}
