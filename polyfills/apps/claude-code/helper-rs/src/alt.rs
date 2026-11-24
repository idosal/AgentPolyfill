//! Accessibility descriptions. The same roles, sanitization, deduplication
//! and 300 UTF-16-unit budget as alt.mjs, directly from Chrome's AX tree.
use std::collections::{HashMap, HashSet};
use serde_json::Value;

pub fn plain_text(text: &str) -> String {
    text.chars().map(|c| if matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' |
        '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}') {
        ' '
    } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn control(role: &str) -> bool {
    matches!(role, "button" | "link" | "checkbox" | "radio" | "switch" | "tab" | "textbox" |
        "combobox" | "slider" | "menuitem" | "searchbox" | "spinbutton")
}

fn shorten(text: String) -> String {
    if text.encode_utf16().count() <= 300 { return text; }
    let mut out = String::new();
    let mut n = 0;
    for c in text.chars() {
        if n + c.len_utf16() > 299 { break; }
        out.push(c); n += c.len_utf16();
    }
    if let Some(space) = out.rfind(char::is_whitespace) { out.truncate(space); }
    out.push('…');
    out
}

pub fn from_tree(tree: &Value) -> String {
    let Some(nodes) = tree["nodes"].as_array() else { return String::new() };
    let by_id: HashMap<_, _> = nodes.iter().filter_map(|n| Some((n["nodeId"].as_str()?, n))).collect();
    let mut seen_nodes = HashSet::new();
    let mut parts = Vec::new();
    fn walk<'a>(node: &'a Value, nodes: &HashMap<&'a str, &'a Value>, visited: &mut HashSet<&'a str>, parts: &mut Vec<String>) {
        let Some(id) = node["nodeId"].as_str() else { return };
        if !visited.insert(id) { return; }
        let role = node["role"]["value"].as_str().unwrap_or("");
        let name = plain_text(node["name"]["value"].as_str().unwrap_or(""));
        let ignored = node["ignored"].as_bool().unwrap_or(false);
        let semantic = !matches!(role, "RootWebArea" | "WebArea" | "generic" | "none" | "InlineTextBox" | "LineBreak");
        if !ignored && semantic && !name.is_empty() {
            parts.push(if control(role) { format!("{name} ({role})") } else { name.clone() });
        }
        // ariaSnapshot uses the accessible name for these leaves, not their
        // text children a second time. Text fields include their value.
        if !ignored && control(role) {
            if matches!(role, "textbox" | "searchbox" | "spinbutton") {
                let value = plain_text(node["value"]["value"].as_str().unwrap_or(""));
                if name.is_empty() && !value.is_empty() { parts.push(format!("{value} ({role})")); }
            }
            return;
        }
        if !ignored && matches!(role, "heading" | "img" | "StaticText") && !name.is_empty() { return; }
        for child in node["childIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if let Some(n) = nodes.get(child) { walk(n, nodes, visited, parts); }
        }
    }
    if let Some(root) = nodes.first() { walk(root, &by_id, &mut seen_nodes, &mut parts); }
    let mut seen = HashSet::new();
    shorten(parts.into_iter().filter(|p| seen.insert(p.clone())).collect::<Vec<_>>().join(". "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn terminal_controls_and_invisible_marks() {
        assert_eq!(plain_text(" a\x1b[31m\n b\u{202e}c\u{200b}d "), "a [31m b c d");
    }
    #[test]
    fn reads_semantics_in_tree_order_without_duplicates() {
        let tree = json!({"nodes":[
            {"nodeId":"1","role":{"value":"RootWebArea"},"childIds":["2","3","4","5"]},
            {"nodeId":"4","role":{"value":"StaticText"},"name":{"value":"waiting"}},
            {"nodeId":"2","role":{"value":"heading"},"name":{"value":"Echo"}},
            {"nodeId":"3","role":{"value":"button"},"name":{"value":"Again"},"childIds":["6"]},
            {"nodeId":"5","role":{"value":"StaticText"},"name":{"value":"waiting"}},
            {"nodeId":"6","role":{"value":"StaticText"},"name":{"value":"Again"}}
        ]});
        assert_eq!(from_tree(&tree), "Echo. Again (button). waiting");
        assert!(shorten("several words ".repeat(100)).encode_utf16().count() <= 300);
    }
}
