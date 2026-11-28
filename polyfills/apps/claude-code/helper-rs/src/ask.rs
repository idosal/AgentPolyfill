//! The terminal's version of the consent page (`signin --no-browser`, and the
//! summary `--yes` prints): the same structure and words as the page (consent.rs),
//! drawn with plain characters and, where the terminal takes them, ANSI colours.
//! No library: a few escape codes by hand.

use std::io::IsTerminal;

use crate::about::About;
use crate::consent::{self, APP};
use crate::vault::Kind;

/// Colours only on a real terminal, and never when `NO_COLOR` is set (no-color.org) or the terminal is "dumb".
pub fn color_on() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()) && std::env::var("TERM").is_ok_and(|t| t != "dumb")
}

struct Paint(bool);

impl Paint {
    fn wrap(&self, code: &str, text: &str) -> String {
        if self.0 { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_string() }
    }
    fn bold(&self, t: &str) -> String {
        self.wrap("1", t)
    }
    fn green(&self, t: &str) -> String {
        self.wrap("32", t)
    }
    fn amber(&self, t: &str) -> String {
        self.wrap("33", t)
    }
    fn dim(&self, t: &str) -> String {
        self.wrap("90", t)
    }
}

/// The summary: who, what for, what it will be able to do, where the login is saved.
pub fn screen(name: &str, url: &str, about: &About, kind: Kind, color: bool) -> String {
    let p = Paint(color);
    let title = about.title.as_deref().unwrap_or(name);
    let w = consent::words(title);
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let mut out = format!("\n  {}  {}\n\n  {}\n  {}\n\n", p.bold(title), p.dim(&host), p.bold(&w.heading), w.lead);
    if about.scopes.is_empty() {
        out.push_str(&format!("  {}\n\n", w.no_list));
    } else {
        out.push_str(&format!("  {}\n", w.list_heading));
        let mut lines: Vec<(Option<String>, &str)> = Vec::new();
        for scope in &about.scopes {
            lines.push((consent::plain(scope, title), scope.as_str()));
        }
        let width = lines.iter().filter_map(|(s, _)| s.as_ref()).map(|s| s.chars().count()).max().unwrap_or(0);
        for (sentence, scope) in lines {
            // A word that can't be put in everyday words is still a line of its own, the server's word in grey.
            match sentence {
                Some(sentence) => out.push_str(&format!("    {} {}{}  {}\n", p.green("\u{2713}"), sentence, " ".repeat(width - sentence.chars().count()), p.dim(scope))),
                None => out.push_str(&format!("    {} {}\n", p.green("\u{2713}"), p.dim(scope))),
            }
        }
        out.push('\n');
    }
    let (good, headline) = consent::storage_status(kind);
    // A closed lock, quiet, when it is fine; an open one with a warning sign when it is not.
    if good {
        out.push_str(&format!("  \u{1F512} {}\n", p.dim(headline)));
    } else {
        out.push_str(&format!("  \u{1F513} {}\n", p.amber(&format!("\u{26A0} {headline}"))));
    }
    out
}

/// What the "?" shows: the same details as the page's "?".
pub fn details(name: &str, url: &str, about: &About, color: bool) -> String {
    let p = Paint(color);
    let mut out = String::new();
    if let Some(d) = &about.description {
        out.push_str(&format!("  \u{2022} {d}\n"));
    }
    out.push_str(&format!("  \u{2022} Separate from Claude Code's own login: it doesn't list or cancel it.\n  \u{2022} To disconnect: {}\n", p.bold(&format!("mcp-apps-cli-helper signout {name}"))));
    out.push_str(&format!("  \u{2022} To change where it is saved: set {}\n", p.bold("MCP_APPS_CLI_TOKEN_STORE")));
    for (label, target) in [("Website", &about.website), ("Documentation", &about.docs), ("Privacy policy", &about.policy), ("Terms of service", &about.terms)] {
        if let Some(target) = target {
            out.push_str(&format!("  \u{2022} {label}: {target}\n"));
        }
    }
    out.push_str(&format!("  \u{2022} {}\n", p.dim(url)));
    out
}

/// The question: the button's words, then the answers (no is the default).
pub fn question(name: &str, about: &About) -> String {
    let title = about.title.as_deref().unwrap_or(name);
    format!("\n  {} [y/N/?] ", consent::words(title).go)
}

/// What the one-line mention of the app says when the question is skipped (`--yes`).
pub fn disconnect_hint(name: &str) -> String {
    format!("  To disconnect: mcp-apps-cli-helper signout {name}  ({APP})")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn about() -> About {
        About {
            title: Some("Acme Docs".into()),
            description: Some("Search the Acme documentation.".into()),
            website: Some("https://acme.example/".into()),
            scopes: vec!["docs:read".into(), "docs:write".into(), "openid".into(), "default".into()],
            ..About::default()
        }
    }

    // The summary has the page's structure; without colour it is plain text, with colour it has escape codes.
    #[test]
    fn the_screen_has_the_pages_structure_with_or_without_colour() {
        let plain = screen("docs", "https://mcp.acme.example/mcp", &about(), Kind::Keychain, false);
        for needle in ["Acme Docs", "mcp.acme.example", "mcp-apps-cli wants to use your Acme Docs account", "A Claude Code add-on.", "It will be able to:", "\u{2713} Read your docs", "docs:read", "Confirm who you are", "\u{2713} default", "\u{1F512} Saved securely on this Mac"] {
            assert!(plain.contains(needle), "{needle}\n{plain}");
        }
        assert!(!plain.contains('\x1b'), "{plain:?}");
        let coloured = screen("docs", "https://mcp.acme.example/mcp", &about(), Kind::File, true);
        assert!(coloured.contains("\x1b[32m\u{2713}") && coloured.contains("\x1b[33m\u{26A0} Not encrypted") && coloured.contains("\u{1F513}") && coloured.contains("Not encrypted"), "{coloured:?}");
        // Nothing published: the title is the name, and a plain line stands for the list.
        let bare = screen("docs", "https://m.example/mcp", &About::default(), Kind::Encrypted, false);
        assert!(bare.contains("wants to use your docs account") && bare.contains("lists what it can access on the next page") && bare.contains("Locked with your passphrase"), "{bare}");
    }

    // The "?" block holds everything technical, and the question names where "Continue" goes.
    #[test]
    fn the_details_and_the_question() {
        let d = details("docs", "https://mcp.acme.example/mcp", &about(), false);
        for needle in ["Search the Acme documentation.", "Separate from Claude Code's own login", "mcp-apps-cli-helper signout docs", "MCP_APPS_CLI_TOKEN_STORE", "Website: https://acme.example/", "https://mcp.acme.example/mcp"] {
            assert!(d.contains(needle), "{needle}\n{d}");
        }
        assert_eq!(question("docs", &about()).trim(), "Continue to Acme Docs [y/N/?]");
    }

    // Writes the Keychain summary (with colour) as a text file in $CONSENT_PREVIEW_DIR, for a capture
    // that doesn't touch the person's Keychain (the real binary probes it).
    #[test]
    #[ignore]
    fn preview_the_keychain_summary() {
        let dir = std::env::var("CONSENT_PREVIEW_DIR").expect("CONSENT_PREVIEW_DIR");
        let text = format!("{}{}n\n", screen("docs", "https://mcp.acme.example/mcp", &about(), Kind::Keychain, true), question("docs", &about()));
        std::fs::write(format!("{dir}/terminal-keychain.txt"), text).unwrap();
    }
}
