//! MCP server configs as Claude Code sees them, first match wins: the
//! helper's own `--mcp-config`, the `--mcp-config` on the command line of
//! the claude that started it, then local (`~/.claude.json` for this folder),
//! project (`.mcp.json`) and user (`~/.claude.json`) scope.

use std::path::Path;

use serde_json::{Map, Value};

use crate::Args;
use crate::out::log;

pub fn load(args: &Args, cwd: &Path) -> Map<String, Value> {
    let mut servers = Map::new();
    let mut add = |config: Option<&Value>| {
        if let Some(Value::Object(found)) = config.and_then(|c| c.get("mcpServers")) {
            for (name, server) in found {
                servers.entry(name.clone()).or_insert_with(|| server.clone());
            }
        }
    };
    for source in args.mcp_config.iter().cloned().chain(parent_mcp_configs()) {
        let text = if source.trim_start().starts_with('{') {
            Ok(source.clone())
        } else {
            std::fs::read_to_string(cwd.join(&source))
        };
        match text.map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
            Ok(config) => add(Some(&config)),
            Err(error) => log(format!("could not read MCP config {source}: {error}")),
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
    let global = home.as_ref().and_then(|h| read_json(&h.join(".claude.json")));
    let cwd_key = cwd.to_string_lossy().to_string();
    add(global.as_ref().and_then(|g| g.get("projects")).and_then(|p| p.get(&cwd_key)));
    add(read_json(&cwd.join(".mcp.json")).as_ref());
    add(global.as_ref());
    servers
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `--mcp-config` values on the command line of the claude that started us.
fn parent_mcp_configs() -> Vec<String> {
    #[cfg(unix)]
    {
        let parent = crate::tmp::parent_pid().to_string();
        let Ok(out) = std::process::Command::new("ps").args(["-ww", "-o", "args=", "-p", &parent]).output() else {
            return Vec::new();
        };
        mcp_config_args(&command_words(String::from_utf8_lossy(&out.stdout).trim()))
    }
    #[cfg(windows)]
    crate::win::parent_command_line().map(|line| mcp_config_args(&command_words(&line))).unwrap_or_default()
}

/// A command line's words, a quoted one (a path with spaces) kept whole.
pub fn command_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut chars = line.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '"' {
            chars.next();
            words.push(chars.by_ref().take_while(|&c| c != '"').collect());
        } else {
            let mut word = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                word.push(c);
                chars.next();
            }
            words.push(word);
        }
    }
    words
}

/// The values of `--mcp-config` in a claude command line: each word after
/// the flag up to the next flag, or the flag's own `=value`.
pub fn mcp_config_args(words: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < words.len() {
        if words[i] == "--mcp-config" {
            let mut j = i + 1;
            while j < words.len() && !words[j].starts_with("--") {
                found.push(words[j].clone());
                j += 1;
            }
        } else if let Some(value) = words[i].strip_prefix("--mcp-config=") {
            found.push(value.to_string());
        }
        i += 1;
    }
    found
}

/// `${NAME}` and `${NAME:-fallback}` in a config, from the environment.
pub fn expand_env(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(expand(s)),
        Value::Array(items) => Value::Array(items.iter().map(expand_env).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), expand_env(v))).collect()),
        other => other.clone(),
    }
}

fn expand(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, fallback) = match inner.split_once(":-") {
            Some((n, f)) => (n, Some(f)),
            None => (inner, None),
        };
        let valid = !name.is_empty()
            && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid {
            out.push_str(&std::env::var(name).ok().or(fallback.map(str::to_string)).unwrap_or_default());
        } else {
            out.push_str(&rest[start..start + 3 + end]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::test_support::cases;

    #[test]
    fn random_strings_never_panic() {
        cases(0x434f4e464947, 5_000, |rng| {
            let text = rng.string(256);
            let words = command_words(&text);
            let _ = mcp_config_args(&words);
            let _ = expand_env(&Value::String(text));
            let bytes = rng.bytes(256);
            let text = String::from_utf8_lossy(&bytes);
            let _ = mcp_config_args(&command_words(&text));
            let _ = expand(&text);
            let value = rng.json(4);
            let expanded = expand_env(&value);
            assert_eq!(serde_json::from_str::<Value>(&expanded.to_string()).unwrap(), expanded);
        });
    }

    #[test]
    fn quoted_words_round_trip() {
        cases(0x51554f5445, 5_000, |rng| {
            // The documented grammar quotes complete words with double quotes;
            // it does not promise shell escapes or literal embedded quotes.
            let expected: Vec<_> = (0..rng.below(12)).map(|_| rng.string(64).replace('"', "")).collect();
            let separator = [" ", "\t", "\n", "\u{2003}"][rng.below(4)];
            let line = expected.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(separator);
            assert_eq!(command_words(&line), expected);
        });
        assert_eq!(command_words("\"\" \"two words\" \"unterminated"), ["", "two words", "unterminated"]);
    }

    #[test]
    fn mcp_config_flags_round_trip_without_eating_other_flags() {
        cases(0x41524753, 5_000, |rng| {
            let files: Vec<_> = (0..rng.below(8)).map(|_| format!("file {}.json", rng.string(32).replace('"', ""))).collect();
            let equal = rng.string(32).replace('"', "");
            let mut words = vec!["claude".to_string(), "--mcp-config".into()];
            words.extend(files.clone());
            words.extend(["--model".into(), "ignored".into(), format!("--mcp-config={equal}"), "--mcp-config".into()]);
            let mut expected = files;
            expected.push(equal);
            assert_eq!(mcp_config_args(&words), expected);
            let line = words.iter().map(|w| format!("\"{w}\"")).collect::<Vec<_>>().join(" ");
            assert_eq!(mcp_config_args(&command_words(&line)), expected);
        });
    }

    #[test]
    fn environment_fallbacks_and_invalid_names_are_literal() {
        const UNSET: &str = "MCP_APPS_FUZZ_UNSET_45F814C9996E";
        assert!(std::env::var_os(UNSET).is_none(), "test requires {UNSET} to be unset");
        cases(0x454e56, 5_000, |rng| {
            let fallback = rng.string(64).replace('}', "");
            let input = format!("before${{{UNSET}:-{fallback}}}after${{{UNSET}}}");
            assert_eq!(expand(&input), format!("before{fallback}after"));
            let invalid = format!("${{9{}:-value}}", rng.string(16).replace('}', ""));
            assert_eq!(expand(&invalid), invalid);
            let unfinished = format!("before${{{UNSET}:-{}", rng.string(16).replace('}', ""));
            assert_eq!(expand(&unfinished), unfinished);
            let nested = serde_json::json!({"key${untouched}": [input, 7, null, {"child": invalid}]});
            assert_eq!(expand_env(&nested), serde_json::json!({"key${untouched}": [format!("before{fallback}after"), 7, null, {"child": invalid}]}));
        });
    }

    #[test]
    fn quoted_paths_stay_whole() {
        let words = command_words(r#""C:\Program Files\Claude\claude.exe" --model sonnet --mcp-config "C:\Users\Ada Lovelace\mcp.json" --verbose"#);
        assert_eq!(words[0], r"C:\Program Files\Claude\claude.exe");
        assert_eq!(mcp_config_args(&words), vec![r"C:\Users\Ada Lovelace\mcp.json".to_string()]);
    }

    #[test]
    fn several_files_or_one_after_equals() {
        let w = |s: &str| command_words(s);
        assert_eq!(mcp_config_args(&w("claude --mcp-config a.json b.json --strict-mcp-config")), vec!["a.json", "b.json"]);
        assert_eq!(mcp_config_args(&w("claude --mcp-config=c.json")), vec!["c.json"]);
        assert!(mcp_config_args(&w("claude --model opus")).is_empty());
    }

    #[test]
    fn env_expansion() {
        // Read an existing variable; mutating the process environment would race
        // the other parser tests (and is unsafe in a multithreaded test harness).
        let (name, value) = std::env::vars().find(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic() || c == '_')).unwrap();
        assert_eq!(expand(&format!("a ${{{name}}} $x")), format!("a {value} $x"));
    }
}
