//! The server gate (`config::decide`), checked over every case, and the part
//! that reads the files (`config::facts`) checked against it on random worlds.
//! Included from config.rs as a test module: the helper is a binary crate.
//!
//! What this proves: for every combination of the facts `decide` takes (a
//! finite set: 2^11 flags times 12^4 settings layers, 42,467,328 cases),
//! `decide` gives the entry the rules below give, and each safety rule holds
//! on its own. What it does not prove: that the rules are Claude Code's (they
//! are its documented behaviour as the security review read it, and the mod
//! asks Claude Code's own verdict first), nor that `facts` reads every file
//! right: that half is property-tested on random worlds, not proved.

use super::*;
use crate::server::test_support::cases;

const SCOPES: [Scope; 4] = [Scope::Command, Scope::Local, Scope::Project, Scope::User];

fn layers() -> Vec<Layer> {
    let mut all = Vec::new();
    for approve_all in [None, Some(false), Some(true)] {
        for approved in [false, true] {
            for rejected in [false, true] {
                all.push(Layer { approve_all, approved, rejected });
            }
        }
    }
    all
}

fn flags(bits: u32) -> Facts {
    let bit = |i: u32| bits & (1 << i) != 0;
    Facts {
        reserved: bit(0),
        managed_policy: bit(1),
        settings_policy: bit(2),
        disabled: bit(3),
        strict: bit(4),
        has: [bit(5), bit(6), bit(7), bit(8)],
        own_trust: bit(9),
        parent_trust: bit(10),
        layers: [Layer::default(); 4],
    }
}

/// The rules, written out on their own: the entry Claude Code would use, or none.
fn would_use(f: &Facts) -> Option<Scope> {
    // claude.ai connectors' and plugins' names come from no file the helper reads.
    if f.reserved {
        return None;
    }
    // A policy on MCP servers that the helper can see: it can't judge it.
    if f.managed_policy || f.settings_policy {
        return None;
    }
    // Switched off for this project.
    if f.disabled {
        return None;
    }
    // Where Claude Code finds the name, highest first; under --strict-mcp-config, the command line only.
    let found: Vec<Scope> = SCOPES.into_iter().filter(|&s| f.has[s as usize] && (s == Scope::Command || !f.strict)).collect();
    let first = *found.first()?;
    // The command line and a file both: the helper can't tell which Claude Code uses.
    if first == Scope::Command && found.len() > 1 {
        return None;
    }
    let trusted = f.own_trust || f.parent_trust;
    match first {
        Scope::Command | Scope::User => Some(first),
        Scope::Local => trusted.then_some(first),
        Scope::Project => {
            if !trusted {
                return None;
            }
            // The person's approvals count wherever the trust comes from; the
            // repository's own settings only where the folder is trusted itself.
            let counted: Vec<Layer> = (0..4).filter(|&i| i >= 2 || f.own_trust).map(|i| f.layers[i]).collect();
            let rejected = counted.iter().any(|l| l.rejected);
            let all = counted.iter().find_map(|l| l.approve_all).unwrap_or(false);
            let listed = counted.iter().any(|l| l.approved);
            (!rejected && (all || listed)).then_some(first)
        }
    }
}

#[test]
fn every_case_decides_as_the_rules_say() {
    let layers = layers();
    let mut cases = 0u64;
    let mut used = [0u64; 4];
    for bits in 0..(1u32 << 11) {
        let base = flags(bits);
        // The layers matter only for a project entry; every combination is still checked.
        for a in &layers {
            for b in &layers {
                for c in &layers {
                    for d in &layers {
                        let f = Facts { layers: [*a, *b, *c, *d], ..base.clone() };
                        let got = decide(&f);
                        assert_eq!(got.ok(), would_use(&f), "{f:?}: {got:?}");
                        if let Ok(scope) = got {
                            used[scope as usize] += 1;
                            // Each rule, on its own.
                            assert!(!f.reserved && !f.managed_policy && !f.settings_policy && !f.disabled, "{f:?}");
                            assert!(f.has[scope as usize], "no entry there: {f:?}");
                            // Never a lower scope's entry in place of a higher one's (no shadowing).
                            for higher in SCOPES.into_iter().take(scope as usize) {
                                assert!(!f.has[higher as usize] || (f.strict && higher != Scope::Command), "{scope:?} over {higher:?}: {f:?}");
                            }
                            if scope != Scope::Command {
                                assert!(!f.strict && !f.has[0], "{f:?}");
                            }
                            if matches!(scope, Scope::Local | Scope::Project) {
                                assert!(f.own_trust || f.parent_trust, "untrusted: {f:?}");
                            }
                        }
                        cases += 1;
                    }
                }
            }
        }
    }
    assert_eq!(cases, 2048 * 12u64.pow(4));
    // Every scope is reachable, so the rules above aren't checked in vain.
    assert!(used.iter().all(|&n| n > 0), "{used:?}");
}

#[test]
fn with_inherited_trust_the_repositorys_own_settings_change_nothing() {
    let layers = layers();
    for bits in (0..(1u32 << 11)).filter(|b| b & (1 << 9) == 0) {
        for c in &layers {
            for d in &layers {
                let plain = Facts { layers: [Layer::default(), Layer::default(), *c, *d], ..flags(bits) };
                for a in &layers {
                    for b in &layers {
                        let planted = Facts { layers: [*a, *b, *c, *d], ..plain.clone() };
                        assert_eq!(decide(&planted), decide(&plain), "{planted:?}");
                    }
                }
            }
        }
    }
}

// ---- facts() against decide(): random worlds on disk ----

struct World {
    root: PathBuf,
    places: Places,
}

impl World {
    fn new(seed: u64) -> Self {
        let root = std::env::temp_dir().join(format!("mcp-apps-facts-{}-{seed:x}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = root.join("work").join("repo");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(root.join("home/.claude")).unwrap();
        let project = std::fs::canonicalize(&project).unwrap();
        let places = Places {
            claude_json: root.join("home/.claude.json"),
            config_dir: root.join("home/.claude"),
            managed_dirs: vec![root.join("managed")],
            managed_plists: vec![root.join("managed/com.anthropic.claudecode.plist")],
            project,
        };
        World { root, places }
    }
    fn write(&self, path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value.to_string()).unwrap();
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A layer as a settings object, naming `name` (and another server, which must not count).
fn layer_json(l: &Layer, name: &str) -> Map<String, Value> {
    let mut m = Map::new();
    if let Some(all) = l.approve_all {
        m.insert("enableAllProjectMcpServers".into(), json!(all));
    }
    m.insert("enabledMcpjsonServers".into(), if l.approved { json!(["other", name]) } else { json!(["other"]) });
    m.insert("disabledMcpjsonServers".into(), if l.rejected { json!([name, "other"]) } else { json!(["other"]) });
    m
}

#[test]
fn the_files_read_back_as_the_facts_they_were_written_from() {
    let layers = layers();
    cases(0x47415445, 400, |rng| {
        let mut f = flags(rng.below(1 << 11) as u32);
        for i in 0..4 {
            f.layers[i] = layers[rng.below(layers.len())];
        }
        let w = World::new(rng.next());
        let name = if f.reserved { ["claude_ai_Gmail", "plugin_x_y"][rng.below(2)] } else { "srv" };
        let entry = json!({"command": "/bin/true"});
        // A policy: one of the forms the helper looks for.
        if f.managed_policy {
            match rng.below(4) {
                0 => w.write(&w.root.join("managed/managed-mcp.json"), &json!({"mcpServers": {}})),
                1 => w.write(&w.root.join("managed/managed-settings.json"), &json!({"deniedMcpServers": [{"serverName": "x"}]})),
                2 => w.write(&w.root.join("managed/managed-settings.d/10.json"), &json!({"allowedMcpServers": []})),
                _ => w.write(&w.places.config_dir.join("remote-settings.json"), &json!({"policy": {"allowManagedMcpServersOnly": true}})),
            }
        }
        let mut settings = [layer_json(&f.layers[0], name), layer_json(&f.layers[1], name), layer_json(&f.layers[2], name)];
        if f.settings_policy {
            settings[rng.below(3)].insert(POLICY_KEYS[rng.below(4)].into(), json!([]));
        }
        w.write(&w.places.project.join(".claude/settings.local.json"), &Value::Object(settings[0].clone()));
        w.write(&w.places.project.join(".claude/settings.json"), &Value::Object(settings[1].clone()));
        w.write(&w.places.config_dir.join("settings.json"), &Value::Object(settings[2].clone()));
        let mut project = layer_json(&f.layers[3], name);
        if f.own_trust {
            project.insert("hasTrustDialogAccepted".into(), json!(true));
        }
        project.insert("disabledMcpServers".into(), if f.disabled { json!(["other", name]) } else { json!(["other"]) });
        if f.has[1] {
            project.insert("mcpServers".into(), json!({ name: entry }));
        }
        let mut projects = Map::new();
        projects.insert(w.places.project.to_string_lossy().to_string(), Value::Object(project));
        if f.parent_trust {
            let parent = w.places.project.ancestors().nth(1 + rng.below(2)).unwrap().to_string_lossy().to_string();
            projects.insert(parent, json!({"hasTrustDialogAccepted": true}));
        }
        let mut claude = json!({"projects": projects, "mcpServers": {"other": entry}});
        if f.has[3] {
            claude["mcpServers"][name] = entry.clone();
        }
        w.write(&w.places.claude_json, &claude);
        if f.has[2] {
            w.write(&w.places.project.join(".mcp.json"), &json!({"mcpServers": { name: entry }}));
        }
        let file = w.root.join("servers.json");
        w.write(&file, &json!({"mcpServers": if f.has[0] { json!({ name: entry }) } else { json!({"other": entry}) }}));
        let mut parent = vec!["claude".to_string(), "--mcp-config".into(), file.to_string_lossy().to_string()];
        if f.strict {
            parent.push("--strict-mcp-config".into());
        }
        let (read, _) = facts(&w.places, &[], &parent, name);
        assert_eq!(read, f, "read back differently");
        let got = resolve_in(&w.places, &[], &parent, &|_| None, name).map(|e| e.scope);
        assert_eq!(got.ok(), decide(&f).ok().map(Scope::name), "{f:?}");
    });
}

// ---- credentials in a remote entry ----

#[test]
fn a_credential_never_reaches_a_remote_entry_and_is_never_looked_up() {
    const PREFIXES: &[&str] = &["ANTHROPIC_", "CLAUDE_", "AWS_", "GITHUB_", "GH_", "GOOGLE_", "OPENAI_", "NPM_", "SSH_", "DOCKER_", "KUBE"];
    const OWN: &[&str] = &["MY_TOKEN", "LINEAR_API_KEY", "NOTION_TOKEN", "SERVER_KEY"];
    cases(0x43524544, 5_000, |rng| {
        let mut credentials = Vec::new();
        let mut own = Vec::new();
        let mut parts = Vec::new();
        for _ in 0..1 + rng.below(6) {
            let name = if rng.below(2) == 0 {
                let mut n = format!("{}{}", PREFIXES[rng.below(PREFIXES.len())], ["KEY", "TOKEN", "X", "SECRET_1"][rng.below(4)]);
                if rng.below(4) == 0 {
                    n = n.to_ascii_lowercase();
                }
                if rng.below(4) == 0 {
                    n = ["HTTPS_PROXY", "all_proxy", "DATABASE_URL", "PGPASSWORD"][rng.below(4)].into();
                }
                credentials.push(n.clone());
                n
            } else {
                let n = OWN[rng.below(OWN.len())].to_string();
                own.push(n.clone());
                n
            };
            let fallback = if rng.below(3) == 0 { format!(":-fallback-{}", rng.below(9)) } else { String::new() };
            parts.push(format!("{}${{{name}{fallback}}}", rng.string(8).replace(['$', '{', '}'], "")));
        }
        let text = parts.join("");
        let asked = std::cell::RefCell::new(Vec::<String>::new());
        let env = |n: &str| {
            asked.borrow_mut().push(n.to_string());
            Some(format!("<{n}>"))
        };
        let config = json!({"type": "http", "url": format!("https://x.example/?q={text}"), "headers": {"a": text.clone()}});
        let remote = expand_value(&config, true, &env).to_string();
        for name in &credentials {
            assert!(credential_var(name), "{name}");
            assert!(!remote.contains(&format!("<{name}>")), "{name} reached {remote}");
            assert!(!asked.borrow().contains(name), "{name} was looked up");
        }
        for name in &own {
            assert!(remote.contains(&format!("<{name}>")), "{name} missing from {remote}");
        }
        // A local entry's own environment and arguments get every variable, as Claude Code gives them.
        let local = expand_value(&json!({"command": "x", "args": [text.clone()]}), false, &env).to_string();
        for name in credentials.iter().chain(&own) {
            assert!(local.contains(&format!("<{name}>")), "{name} missing from a local entry");
        }
    });
}
