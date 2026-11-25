//! Which MCP server a name means, as Claude Code itself would use it, or why
//! the helper won't connect to it.
//!
//! The helper opens connections of its own (to read a tool's UI, and for an
//! app's calls to tools only apps may call), so it must not reach further
//! than Claude Code does. A name is looked up the way Claude Code looks it
//! up, and refused where Claude Code would not use that entry:
//!
//! - names beginning `claude_ai_` or `plugin_` are Claude Code's names for
//!   claude.ai connectors and plugins' servers: no config file the helper
//!   reads defines them, so a file that does is never believed;
//! - where a managed MCP policy exists, or any settings file says which MCP
//!   servers are allowed or denied, nothing is used: the helper can't judge
//!   such a policy (a policy in the Windows registry is not visible to it);
//! - a server switched off for this project in Claude Code stays off;
//! - local scope (`~/.claude.json` for this folder) and the project's
//!   `.mcp.json` are used only in a folder Claude Code trusts, and a
//!   `.mcp.json` entry only once it is approved and not rejected; where the
//!   trust comes from a parent folder, the project's own settings files
//!   don't count as approval;
//! - the entry Claude Code would use decides (local, then project, then
//!   user): when that one is refused, a lower scope's entry of the same name
//!   doesn't stand in for it;
//! - `--mcp-config` on the command line of the claude that started the
//!   helper is the person's own choice and is used (only it, under
//!   `--strict-mcp-config`), but a name it shares with a config file is
//!   refused: the helper can't be sure which of the two Claude Code uses;
//! - `${VAR}` and `${VAR:-default}` are expanded only in an entry that
//!   passed, and never with a credential's name in a remote server's url or
//!   headers (see `credential_var`).
//!
//! The mod asks Claude Code's own verdict (`$.mcp.connect`) before it asks
//! the helper anything about a server; these rules are the helper's own,
//! for any request that reaches it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::Args;
use crate::out::log;

/// Where the files Claude Code decides by are.
#[derive(Clone, Debug)]
pub struct Places {
    /// The folder Claude Code runs in: its `.mcp.json` and `.claude/`.
    pub project: PathBuf,
    /// `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`.
    pub claude_json: PathBuf,
    /// `~/.claude`, or `$CLAUDE_CONFIG_DIR`.
    pub config_dir: PathBuf,
    /// Where managed settings live on this platform.
    pub managed_dirs: Vec<PathBuf>,
    /// macOS managed-preferences files for Claude Code.
    pub managed_plists: Vec<PathBuf>,
}

impl Places {
    pub fn here(project: &Path) -> Self {
        let home = crate::tmp::home().unwrap_or_else(|| PathBuf::from("."));
        let custom = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
        Places {
            project: project.to_path_buf(),
            claude_json: custom.as_ref().map_or_else(|| home.join(".claude.json"), |d| d.join(".claude.json")),
            config_dir: custom.unwrap_or_else(|| home.join(".claude")),
            managed_dirs: default_managed_dirs(),
            managed_plists: default_managed_plists(),
        }
    }
}

fn default_managed_dirs() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Library/Application Support/ClaudeCode")]
    } else if cfg!(windows) {
        vec![PathBuf::from(r"C:\Program Files\ClaudeCode")]
    } else {
        vec![PathBuf::from("/etc/claude-code")]
    }
}

fn default_managed_plists() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut plists = vec![PathBuf::from("/Library/Managed Preferences/com.anthropic.claudecode.plist")];
        // SAFETY: getpwuid returns a pointer into static storage or null; it's read at once.
        let user = unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if pw.is_null() { None } else { std::ffi::CStr::from_ptr((*pw).pw_name).to_str().ok().map(str::to_string) }
        };
        if let Some(user) = user {
            plists.push(PathBuf::from(format!("/Library/Managed Preferences/{user}/com.anthropic.claudecode.plist")));
        }
        plists
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// A server's config as the helper will use it: expanded, and which scope it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub config: Value,
    /// `command line`, `local`, `project` or `user`.
    pub scope: &'static str,
}

/// The entry Claude Code would use for `name`, or why the helper won't use one.
pub fn resolve(args: &Args, cwd: &Path, name: &str) -> Result<Entry, String> {
    resolve_in(&Places::here(cwd), &args.mcp_config, &parent_command_words(), &|n| std::env::var(n).ok(), name)
}

/// Keys of a settings file that say which MCP servers may be used.
const POLICY_KEYS: [&str; 4] = ["allowedMcpServers", "deniedMcpServers", "allowManagedMcpServersOnly", "managedMcpServers"];

/// The same as `resolve`, with every input given: the files' places, the
/// helper's own `--mcp-config` values, the words of the parent's command
/// line, and the environment. The files are read into `Facts`, `decide`
/// says which entry those facts allow, and only that entry is expanded.
pub fn resolve_in(
    places: &Places,
    own: &[String],
    parent: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    name: &str,
) -> Result<Entry, String> {
    let (facts, mut configs) = facts(places, own, parent, name);
    let scope = decide(&facts).map_err(|refusal| match refusal {
        Refusal::ManagedPolicy => format!(
            "your organisation manages which MCP servers are allowed ({}), and the helper can't judge that policy, so it connects to none",
            managed_policy(places).map_or_else(|| "managed settings".into(), |p| p.display().to_string())
        ),
        other => other.message(name),
    })?;
    let config = configs[scope as usize].take().expect("decide picks a scope that has an entry");
    Ok(expanded(config, scope.name(), env))
}

/// Where an entry comes from, in the order Claude Code looks (the command line first).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Command = 0,
    Local = 1,
    Project = 2,
    User = 3,
}

impl Scope {
    pub fn name(self) -> &'static str {
        match self {
            Scope::Command => "command line",
            Scope::Local => "local",
            Scope::Project => "project",
            Scope::User => "user",
        }
    }
}

/// What one settings layer says about a `.mcp.json` server.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Layer {
    /// `enableAllProjectMcpServers`, when it is set to a boolean.
    pub approve_all: Option<bool>,
    /// The name is in `enabledMcpjsonServers`.
    pub approved: bool,
    /// The name is in `disabledMcpjsonServers`.
    pub rejected: bool,
}

/// Everything about a name that the decision depends on, read from the files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// The name begins `claude_ai_` or `plugin_`.
    pub reserved: bool,
    /// A managed MCP policy exists (a managed file, drop-in, managed-MCP file, plist or fetched policy).
    pub managed_policy: bool,
    /// A project or user settings file has an allow or deny list for MCP servers.
    pub settings_policy: bool,
    /// The name is in this project's `disabledMcpServers`.
    pub disabled: bool,
    /// `--strict-mcp-config` is on the parent's command line.
    pub strict: bool,
    /// Which scopes have an entry for the name: command line, local, project, user (as `Scope`).
    pub has: [bool; 4],
    /// The folder's own trust is on record.
    pub own_trust: bool,
    /// A folder above it is trusted.
    pub parent_trust: bool,
    /// The project's `.claude/settings.local.json` and `.claude/settings.json`, the
    /// user's settings, and the project's entry in `~/.claude.json`, highest first.
    pub layers: [Layer; 4],
}

/// Why `decide` won't use an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Reserved,
    ManagedPolicy,
    SettingsPolicy,
    Disabled,
    Ambiguous,
    NotFound,
    Untrusted,
    Rejected,
    Unapproved,
}

impl Refusal {
    pub fn message(self, name: &str) -> String {
        match self {
            Refusal::Reserved => format!(
                "\"{name}\" is how Claude Code names a claude.ai connector or a plugin's server, which no config file the helper reads defines"
            ),
            Refusal::ManagedPolicy => {
                "your organisation manages which MCP servers are allowed, and the helper can't judge that policy, so it connects to none".into()
            }
            Refusal::SettingsPolicy => "a settings file says which MCP servers are allowed or denied, and the helper can't apply such a list, so it connects to none".into(),
            Refusal::Disabled => "it is switched off for this project in Claude Code".into(),
            Refusal::Ambiguous => "it is named both on Claude Code's command line (--mcp-config) and in a config file, and the helper can't be sure which one Claude Code uses".into(),
            Refusal::NotFound => format!("no config found for MCP server \"{name}\""),
            Refusal::Untrusted => "this folder is not trusted in Claude Code, so neither its .mcp.json nor its local servers are used".into(),
            Refusal::Rejected => "it was rejected for this project in Claude Code".into(),
            Refusal::Unapproved => "it is in this project's .mcp.json but not approved in Claude Code".into(),
        }
    }
}

/// Which entry the helper may use for a name with these facts: the one
/// Claude Code would use, or a refusal. A pure function of a finite input,
/// checked over every case by `tests/support/gate_exhaustive.rs`.
pub fn decide(f: &Facts) -> Result<Scope, Refusal> {
    if f.reserved {
        return Err(Refusal::Reserved);
    }
    if f.managed_policy {
        return Err(Refusal::ManagedPolicy);
    }
    if f.settings_policy {
        return Err(Refusal::SettingsPolicy);
    }
    if f.disabled {
        return Err(Refusal::Disabled);
    }
    // Under --strict-mcp-config Claude Code reads no config file.
    let in_files = !f.strict && (f.has[1] || f.has[2] || f.has[3]);
    if f.has[0] {
        return if in_files { Err(Refusal::Ambiguous) } else { Ok(Scope::Command) };
    }
    if !in_files {
        return Err(Refusal::NotFound);
    }
    // The entry Claude Code's order picks decides: a refused one is not
    // replaced by a lower scope's.
    let scope = [Scope::Local, Scope::Project, Scope::User].into_iter().find(|s| f.has[*s as usize]).expect("in_files");
    // Claude Code asks about trust once per folder and takes the answer for the folders inside it.
    let trusted = f.own_trust || f.parent_trust;
    match scope {
        Scope::Local if !trusted => Err(Refusal::Untrusted),
        Scope::Project => {
            if !trusted {
                return Err(Refusal::Untrusted);
            }
            // The folder's own settings count only when the folder's trust is its own.
            let layers = if f.own_trust { &f.layers[..] } else { &f.layers[2..] };
            // A yes-or-no is taken from the highest layer that sets it; lists add up.
            if layers.iter().any(|l| l.rejected) {
                return Err(Refusal::Rejected);
            }
            let approve_all = layers.iter().find_map(|l| l.approve_all) == Some(true);
            if !approve_all && !layers.iter().any(|l| l.approved) {
                return Err(Refusal::Unapproved);
            }
            Ok(scope)
        }
        _ => Ok(scope),
    }
}

/// The facts about `name` in the files Claude Code reads, and each scope's
/// entry for it (unexpanded), as `decide` takes them.
pub fn facts(places: &Places, own: &[String], parent: &[String], name: &str) -> (Facts, [Option<Value>; 4]) {
    let reserved = name.starts_with("claude_ai_") || name.starts_with("plugin_");
    let managed = managed_policy(places);
    let claude = read_json(&places.claude_json);
    let projects = claude.as_ref().and_then(|c| c.get("projects")).and_then(Value::as_object);
    let real = std::fs::canonicalize(&places.project).unwrap_or_else(|_| places.project.clone());
    let lookup = |path: &Path| projects.and_then(|ps| path_keys(path).iter().find_map(|k| ps.get(k)));
    let accepted = |path: &Path| lookup(path).and_then(|e| e.get("hasTrustDialogAccepted")) == Some(&Value::Bool(true));
    let entry = lookup(&places.project).or_else(|| lookup(&real)).cloned().unwrap_or_else(|| json!({}));
    let own_trust = accepted(&places.project) || accepted(&real);
    let parent_trust = [&places.project, &real].iter().any(|start| start.ancestors().skip(1).any(accepted));

    let project_settings = [
        read_json(&places.project.join(".claude").join("settings.local.json")),
        read_json(&places.project.join(".claude").join("settings.json")),
    ];
    let user_settings = read_json(&places.config_dir.join("settings.json"));
    let settings_policy = project_settings.iter().chain([&user_settings]).flatten().any(|s| POLICY_KEYS.iter().any(|k| s.get(*k).is_some()));
    let disabled = names(&entry["disabledMcpServers"]).iter().any(|n| n == name);

    // On the command line: the helper's own (a test's), then the parent's.
    let mut command = None;
    for source in own.iter().cloned().chain(mcp_config_args(parent)) {
        let text = if source.trim_start().starts_with('{') {
            Ok(source.clone())
        } else {
            std::fs::read_to_string(places.project.join(&source)).map_err(|e| e.to_string())
        };
        match text.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
            Ok(config) => {
                if command.is_none() {
                    command = config.get("mcpServers").and_then(|s| s.get(name)).cloned();
                }
            }
            Err(error) => log(format!("could not read MCP config {source}: {error}")),
        }
    }
    let strict = parent.iter().any(|w| w == "--strict-mcp-config");
    let configs = [
        command,
        entry.get("mcpServers").and_then(|s| s.get(name)).cloned(),
        read_json(&places.project.join(".mcp.json")).and_then(|j| j.get("mcpServers").and_then(|s| s.get(name)).cloned()),
        claude.as_ref().and_then(|c| c.get("mcpServers")).and_then(|s| s.get(name)).cloned(),
    ];
    let layer = |l: Option<&Value>| match l {
        Some(l) => Layer {
            approve_all: l.get("enableAllProjectMcpServers").and_then(Value::as_bool),
            approved: names(&l["enabledMcpjsonServers"]).iter().any(|n| n == name),
            rejected: names(&l["disabledMcpjsonServers"]).iter().any(|n| n == name),
        },
        None => Layer::default(),
    };
    let facts = Facts {
        reserved,
        managed_policy: managed.is_some(),
        settings_policy,
        disabled,
        strict,
        has: [configs[0].is_some(), configs[1].is_some(), configs[2].is_some(), configs[3].is_some()],
        own_trust,
        parent_trust,
        layers: [layer(project_settings[0].as_ref()), layer(project_settings[1].as_ref()), layer(user_settings.as_ref()), layer(Some(&entry))],
    };
    (facts, configs)
}

/// The ways `~/.claude.json` may spell a folder (Windows: either slash).
fn path_keys(path: &Path) -> Vec<String> {
    let text = path.to_string_lossy().to_string();
    let forward = text.replace('\\', "/");
    if forward == text { vec![text] } else { vec![text, forward] }
}

/// A file's JSON object, or none (missing, unreadable, or not an object).
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(path).ok()?).ok().filter(Value::is_object)
}

fn names(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// Whether settings (or anything nested in them: a cached policy has its own
/// wrapping) say which MCP servers may be used.
fn sets_policy(v: &Value, depth: usize) -> bool {
    depth <= 6 && v.as_object().is_some_and(|m| m.iter().any(|(k, x)| POLICY_KEYS.contains(&k.as_str()) || sets_policy(x, depth + 1)))
}

/// Where an MCP policy was found, if one was: a managed file or drop-in, the
/// managed-MCP file, a macOS managed-preferences file for Claude Code (its
/// presence is enough), or policy fetched from the organisation and kept in
/// the config folder. A managed file that can't be read as JSON is taken to
/// hold one.
fn managed_policy(places: &Places) -> Option<PathBuf> {
    let holds = |path: &Path| path.exists() && read_json(path).is_none_or(|v| sets_policy(&v, 0));
    for dir in &places.managed_dirs {
        let mcp = dir.join("managed-mcp.json");
        if mcp.exists() {
            return Some(mcp);
        }
        let managed = dir.join("managed-settings.json");
        if holds(&managed) {
            return Some(managed);
        }
        if let Ok(entries) = std::fs::read_dir(dir.join("managed-settings.d")) {
            for drop in entries.flatten().map(|e| e.path()) {
                if drop.extension().is_some_and(|x| x == "json") && holds(&drop) {
                    return Some(drop);
                }
            }
        }
    }
    if let Some(plist) = places.managed_plists.iter().find(|p| p.exists()) {
        return Some(plist.clone());
    }
    let remote = places.config_dir.join("remote-settings.json");
    holds(&remote).then_some(remote)
}

/// How the helper reaches a server: `http`, `sse` or `stdio`.
pub fn kind(config: &Value) -> &'static str {
    match config.get("type").and_then(Value::as_str) {
        Some("http" | "streamable-http") => "http",
        Some("sse") => "sse",
        Some(_) => "stdio",
        None if config.get("url").is_some() => "http",
        None => "stdio",
    }
}

fn expanded(config: Value, scope: &'static str, env: &dyn Fn(&str) -> Option<String>) -> Entry {
    // Remote: anything that is reached by a url.
    let remote = kind(&config) != "stdio" || config.get("url").is_some();
    Entry { config: expand_value(&config, remote, env), scope }
}

/// The words of the command line of the claude that started us.
fn parent_command_words() -> Vec<String> {
    #[cfg(unix)]
    {
        let parent = crate::tmp::parent_pid().to_string();
        let Ok(out) = std::process::Command::new("ps").args(["-ww", "-o", "args=", "-p", &parent]).output() else {
            return Vec::new();
        };
        command_words(String::from_utf8_lossy(&out.stdout).trim())
    }
    #[cfg(windows)]
    crate::win::parent_command_line().map(|line| command_words(&line)).unwrap_or_default()
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

/// Credentials an environment carries whether or not any MCP server was
/// meant to have them: Claude's own, this plugin's, cloud and model
/// providers', package registries', source hosts', CI's, and proxies (whose
/// addresses often hold a password). In a remote server's url or headers
/// they read as empty, and a default after `:-` is ignored. Claude Code has
/// such a set too and publishes only examples of it, so this one (the same
/// as the mcp-events plugin's) is drawn wide: to send a token to a server,
/// keep it in a variable with a name of your own.
pub fn credential_var(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "ANTHROPIC_", "CLAUDE_", "MCP_APPS_CLI_", "MCP_EVENTS_", "AWS_", "AZURE_", "ARM_", "GOOGLE_", "GCLOUD_", "GCP_", "CLOUDSDK_",
        "VERTEX", "BEDROCK", "CLOUDFLARE_", "CF_", "DIGITALOCEAN_", "HEROKU_", "VERCEL_", "NETLIFY_", "FLY_", "OPENAI_", "GEMINI_",
        "MISTRAL_", "COHERE_", "GROQ_", "XAI_", "HF_", "HUGGINGFACE", "HUGGING_FACE", "NPM_", "NODE_AUTH_TOKEN", "YARN_", "PNPM_",
        "PIP_", "PYPI_", "TWINE_", "POETRY_", "UV_", "CARGO_", "GEM_", "BUNDLE_", "DOCKER_", "KUBE", "SSH_", "GPG_", "GH_", "GITHUB_",
        "GITLAB_", "BITBUCKET_", "CI_", "ACTIONS_", "RUNNER_", "SENTRY_", "DATADOG_", "DD_", "STRIPE_", "SLACK_", "TWILIO_",
    ];
    const EXACT: &[&str] = &["ALL_PROXY", "NO_PROXY", "PGPASSWORD", "MYSQL_PWD", "DATABASE_URL", "REDIS_URL"];
    let upper = name.to_ascii_uppercase();
    PREFIXES.iter().any(|p| upper.starts_with(p)) || upper.ends_with("_PROXY") || EXACT.contains(&upper.as_str())
}

/// `${NAME}` and `${NAME:-fallback}` in a config, from `env`; in a remote
/// server's (`remote`), a credential's name reads as empty.
pub fn expand_value(value: &Value, remote: bool, env: &dyn Fn(&str) -> Option<String>) -> Value {
    match value {
        Value::String(s) => Value::String(expand_str(s, remote, env)),
        Value::Array(items) => Value::Array(items.iter().map(|v| expand_value(v, remote, env)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), expand_value(v, remote, env))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

fn expand_str(s: &str, remote: bool, env: &dyn Fn(&str) -> Option<String>) -> String {
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
        if valid && remote && credential_var(name) {
            // Left empty, the default too: never looked up.
        } else if valid {
            out.push_str(&env(name).or(fallback.map(str::to_string)).unwrap_or_default());
        } else {
            out.push_str(&rest[start..start + 3 + end]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
#[path = "../tests/support/gate_exhaustive.rs"]
mod gate_exhaustive;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::test_support::cases;
    use std::cell::RefCell;

    fn process_env(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
    fn expand(s: &str) -> String {
        expand_str(s, false, &process_env)
    }
    fn expand_env(v: &Value) -> Value {
        expand_value(v, false, &process_env)
    }

    #[test]
    fn random_strings_never_panic() {
        cases(0x434f4e464947, 5_000, |rng| {
            let text = rng.string(256);
            let words = command_words(&text);
            let _ = mcp_config_args(&words);
            let _ = expand_env(&Value::String(text.clone()));
            let _ = expand_str(&text, true, &process_env);
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
        let env = |n: &str| (n == "SOME_NAME").then(|| "value".to_string());
        assert_eq!(expand_str("a ${SOME_NAME} $x", false, &env), "a value $x");
    }

    // ---- which entry a name means ----

    /// A home, a config folder, a managed folder and a project, all in a
    /// temporary folder of their own.
    struct World {
        root: PathBuf,
        places: Places,
    }

    impl World {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("mcp-apps-config-{tag}-{}-{}", std::process::id(), crate::tmp::random_hex(4).unwrap()));
            let project = root.join("work").join("repo");
            std::fs::create_dir_all(&project).unwrap();
            std::fs::create_dir_all(root.join("home/.claude")).unwrap();
            let places = Places {
                claude_json: root.join("home/.claude.json"),
                config_dir: root.join("home/.claude"),
                managed_dirs: vec![root.join("managed")],
                managed_plists: vec![root.join("managed/com.anthropic.claudecode.plist")],
                project: std::fs::canonicalize(&project).unwrap(),
            };
            World { root, places }
        }
        fn write(&self, path: &Path, value: Value) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, value.to_string()).unwrap();
        }
        /// `~/.claude.json`: user servers, and this project's entry.
        fn claude_json(&self, user: Value, project: Value) {
            let key = self.places.project.to_string_lossy().to_string();
            self.write(&self.places.claude_json, json!({"mcpServers": user, "projects": {key: project}}));
        }
        fn mcp_json(&self, servers: Value) {
            self.write(&self.places.project.join(".mcp.json"), json!({"mcpServers": servers}));
        }
        fn resolve(&self, name: &str) -> Result<Entry, String> {
            resolve_in(&self.places, &[], &[], &|_| None, name)
        }
        fn scope(&self, name: &str) -> Result<&'static str, String> {
            self.resolve(name).map(|e| e.scope)
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn stdio(marker: &str) -> Value {
        json!({"command": "/bin/sh", "args": ["-c", format!("echo ran > {marker}")]})
    }

    #[test]
    fn unapproved_project_entries_are_never_used_and_never_shadow() {
        let w = World::new("unapproved");
        // A user-scope server's name, a claude.ai
        // connector's and a plugin's, planted in a trusted folder's .mcp.json.
        w.claude_json(json!({"meshy-mcp-server": stdio("user")}), json!({"hasTrustDialogAccepted": true}));
        w.mcp_json(json!({
            "meshy-mcp-server": stdio("project"),
            "claude_ai_Gmail": stdio("connector"),
            "plugin_cloudflare_cloudflare-docs": stdio("plugin"),
            "github": {"type": "http", "url": "https://attacker.example/mcp"},
        }));
        // Not approved: refused, and the user's own entry does not stand in.
        assert!(w.resolve("meshy-mcp-server").unwrap_err().contains("not approved"));
        assert!(w.resolve("github").unwrap_err().contains("not approved"));
        assert!(w.resolve("claude_ai_Gmail").unwrap_err().contains("claude.ai connector"));
        assert!(w.resolve("plugin_cloudflare_cloudflare-docs").unwrap_err().contains("plugin"));
    }

    #[test]
    fn approved_project_entries_win_as_in_claude_code_but_reserved_names_never() {
        let w = World::new("approved");
        let all = json!(["meshy-mcp-server", "claude_ai_Gmail", "plugin_cloudflare_cloudflare-docs"]);
        w.claude_json(json!({"meshy-mcp-server": stdio("user")}), json!({"hasTrustDialogAccepted": true, "enabledMcpjsonServers": all}));
        w.mcp_json(json!({"meshy-mcp-server": stdio("project"), "claude_ai_Gmail": stdio("c"), "plugin_cloudflare_cloudflare-docs": stdio("p")}));
        // Claude Code: local, then project, then user.
        assert_eq!(w.scope("meshy-mcp-server"), Ok("project"));
        assert!(w.resolve("claude_ai_Gmail").is_err());
        assert!(w.resolve("plugin_cloudflare_cloudflare-docs").is_err());
    }

    #[test]
    fn an_untrusted_folder_uses_neither_project_nor_local_servers() {
        let w = World::new("untrusted");
        w.claude_json(json!({"mine": stdio("user")}), json!({"enableAllProjectMcpServers": true, "mcpServers": {"local-one": stdio("local")}}));
        w.mcp_json(json!({"repo": stdio("repo")}));
        assert!(w.resolve("repo").unwrap_err().contains("not trusted"));
        assert!(w.resolve("local-one").unwrap_err().contains("not trusted"));
        assert_eq!(w.scope("mine"), Ok("user"));
    }

    #[test]
    fn rejected_and_switched_off_servers_stay_off() {
        let w = World::new("off");
        w.claude_json(
            json!({"mine": stdio("user")}),
            json!({"hasTrustDialogAccepted": true, "enableAllProjectMcpServers": true, "disabledMcpjsonServers": ["repo"], "disabledMcpServers": ["mine"]}),
        );
        w.mcp_json(json!({"repo": stdio("repo"), "other": stdio("other")}));
        assert!(w.resolve("repo").unwrap_err().contains("rejected"));
        assert!(w.resolve("mine").unwrap_err().contains("switched off"));
        assert_eq!(w.scope("other"), Ok("project"));
    }

    #[test]
    fn any_mcp_policy_turns_everything_off() {
        type Plant = fn(&World);
        let plants: [(&str, Plant); 6] = [
            ("managed-mcp.json", |w| w.write(&w.root.join("managed/managed-mcp.json"), json!({"mcpServers": {}}))),
            ("managed allow list", |w| w.write(&w.root.join("managed/managed-settings.json"), json!({"allowedMcpServers": [{"serverName": "mine"}]}))),
            ("unreadable managed settings", |w| { std::fs::create_dir_all(w.root.join("managed")).unwrap(); std::fs::write(w.root.join("managed/managed-settings.json"), "{not json").unwrap(); }),
            ("managed drop-in", |w| w.write(&w.root.join("managed/managed-settings.d/10-mcp.json"), json!({"deniedMcpServers": [{"serverName": "x"}]}))),
            ("remote settings", |w| w.write(&w.places.config_dir.join("remote-settings.json"), json!({"policy": {"deniedMcpServers": [{"serverName": "x"}]}}))),
            ("user deny list", |w| w.write(&w.places.config_dir.join("settings.json"), json!({"deniedMcpServers": [{"serverName": "x"}]}))),
        ];
        for (what, plant) in plants {
            let w = World::new("policy");
            w.claude_json(json!({"mine": stdio("user")}), json!({"hasTrustDialogAccepted": true}));
            assert_eq!(w.scope("mine"), Ok("user"), "{what}: before");
            plant(&w);
            let refused = w.resolve("mine").unwrap_err();
            assert!(refused.contains("allowed"), "{what}: {refused}");
            // The helper's own --mcp-config too.
            assert!(resolve_in(&w.places, &[json!({"mcpServers": {"mine": stdio("cmd")}}).to_string()], &[], &|_| None, "mine").is_err(), "{what}");
        }
        // A managed file with only a hook policy says nothing about MCP servers.
        let w = World::new("hooks-only");
        w.claude_json(json!({"mine": stdio("user")}), json!({}));
        w.write(&w.root.join("managed/managed-settings.json"), json!({"allowManagedHooksOnly": true}));
        assert_eq!(w.scope("mine"), Ok("user"));
    }

    #[test]
    fn trust_from_a_parent_folder_counts_but_not_the_repos_own_approvals() {
        let w = World::new("parent");
        let parent = w.places.project.parent().unwrap().to_string_lossy().to_string();
        w.write(&w.places.claude_json, json!({"projects": {parent.clone(): {"hasTrustDialogAccepted": true}}}));
        w.mcp_json(json!({"repo": stdio("repo")}));
        w.write(&w.places.project.join(".claude/settings.json"), json!({"enableAllProjectMcpServers": true}));
        // The repository's own approval does not count when trust is inherited.
        assert!(w.resolve("repo").unwrap_err().contains("not approved"));
        // The person's own approval, in ~/.claude.json, does.
        let key = w.places.project.to_string_lossy().to_string();
        w.write(&w.places.claude_json, json!({"projects": {parent: {"hasTrustDialogAccepted": true}, key.clone(): {"enabledMcpjsonServers": ["repo"]}}}));
        assert_eq!(w.scope("repo"), Ok("project"));
        // With the folder's own trust, its settings count (as Claude Code reads them).
        w.write(&w.places.claude_json, json!({"projects": {key: {"hasTrustDialogAccepted": true}}}));
        assert_eq!(w.scope("repo"), Ok("project"));
    }

    #[test]
    fn the_command_line_is_used_alone_or_refused_where_it_competes() {
        let w = World::new("cmdline");
        w.claude_json(json!({"shared": stdio("user"), "only-user": stdio("u")}), json!({"hasTrustDialogAccepted": true}));
        let file = w.root.join("servers.json");
        w.write(&file, json!({"mcpServers": {"arcade": {"type": "http", "url": "https://example.com/mcp"}, "shared": stdio("cmd")}}));
        let parent: Vec<String> = ["claude", "--mcp-config", file.to_str().unwrap()].iter().map(|s| s.to_string()).collect();
        let resolve = |parent: &[String], name: &str| resolve_in(&w.places, &[], parent, &|_| None, name);
        assert_eq!(resolve(&parent, "arcade").map(|e| e.scope), Ok("command line"));
        assert!(resolve(&parent, "shared").unwrap_err().contains("both"));
        assert_eq!(resolve(&parent, "only-user").map(|e| e.scope), Ok("user"));
        // --strict-mcp-config: Claude Code uses the command line's servers alone.
        let mut strict = parent.clone();
        strict.push("--strict-mcp-config".into());
        assert_eq!(resolve(&strict, "shared").map(|e| e.scope), Ok("command line"));
        assert!(resolve(&strict, "only-user").is_err());
    }

    #[test]
    fn credentials_never_reach_a_remote_url_or_headers() {
        let w = World::new("credentials");
        w.claude_json(
            json!({
                "remote": {"type": "http", "url": "https://x.example/mcp?k=${ANTHROPIC_API_KEY}&g=${GH_TOKEN:-fallback}&mine=${MY_SERVER_TOKEN}",
                           "headers": {"x-a": "${GITHUB_TOKEN}", "x-b": "Bearer ${AWS_SECRET_ACCESS_KEY}", "x-c": "${HTTPS_PROXY}", "x-mine": "${MY_SERVER_TOKEN}"}},
                "local": {"command": "run", "args": ["${ANTHROPIC_API_KEY}"], "env": {"TOKEN": "${GITHUB_TOKEN}"}},
            }),
            json!({}),
        );
        let env = |n: &str| Some(format!("synthetic-{n}"));
        let remote = resolve_in(&w.places, &[], &[], &env, "remote").unwrap().config;
        assert_eq!(remote["url"], "https://x.example/mcp?k=&g=&mine=synthetic-MY_SERVER_TOKEN");
        assert_eq!(remote["headers"], json!({"x-a": "", "x-b": "Bearer ", "x-c": "", "x-mine": "synthetic-MY_SERVER_TOKEN"}));
        // A local server's own environment and arguments are expanded as Claude Code does.
        let local = resolve_in(&w.places, &[], &[], &env, "local").unwrap().config;
        assert_eq!(local["args"], json!(["synthetic-ANTHROPIC_API_KEY"]));
        assert_eq!(local["env"]["TOKEN"], "synthetic-GITHUB_TOKEN");
    }

    #[test]
    fn nothing_is_expanded_for_an_entry_that_failed() {
        let w = World::new("unexpanded");
        w.claude_json(json!({}), json!({"hasTrustDialogAccepted": true}));
        w.mcp_json(json!({"repo": {"type": "http", "url": "https://attacker.example/?${MY_SECRET}", "headers": {"x": "${OTHER}"}}}));
        let asked = RefCell::new(Vec::<String>::new());
        let env = |n: &str| {
            asked.borrow_mut().push(n.to_string());
            Some("v".to_string())
        };
        assert!(resolve_in(&w.places, &[], &[], &env, "repo").is_err());
        assert!(asked.borrow().is_empty(), "looked up {:?}", asked.borrow());
    }

    #[test]
    fn credential_names() {
        for name in ["ANTHROPIC_API_KEY", "claude_code_oauth_token", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "GH_TOKEN", "HTTPS_PROXY", "https_proxy", "NODE_AUTH_TOKEN", "HUGGINGFACE_HUB_TOKEN", "KUBECONFIG", "DATABASE_URL", "MCP_APPS_CLI_X"] {
            assert!(credential_var(name), "{name}");
        }
        for name in ["MY_SERVER_TOKEN", "LINEAR_API_KEY", "PATH", "HOME", "NOTION_TOKEN"] {
            assert!(!credential_var(name), "{name}");
        }
    }
}
