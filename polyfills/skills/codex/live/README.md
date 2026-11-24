# Recorded sessions

Real Codex sessions with the plugin, driven by a script so they can be
repeated.

| What | Kept here |
|---|---|
| The terminal UI (Codex 0.172.0, macOS), Hugging Face's public MCP server, in a throwaway Codex home made by [`take-proof.sh`](take-proof.sh): the served skill in Codex's `$` skill picker, marked with its server; a question it fits; Codex calling `load_skill`; the plugin's question; "Show me its SKILL.md first"; "Load it"; the answer, from the skill and two reference files read with `read_skill_file`. | [`runs/proof/`](runs/proof/) |
| The same steps in a Codex home that has many other skills and plugins (236 skills). | [`runs/own-home/`](runs/own-home/) |
| `codex exec`, unattended: a skill approved in the interactive session loads with no question; one never approved is refused, and nothing of it is used. | [`../docs/evidence/exec.txt`](../docs/evidence/exec.txt) |
| On a running app-server daemon, as the terminal UI uses it ([`take-daemon.sh`](take-daemon.sh), 0.1.5): the first session after install, two plain questions; a marketplace update (the plugin's folder copied afresh); a second session on the same daemon, one plain question. Each session is a client of the daemon's control socket, as the terminal UI is ([`daemon-client.mjs`](daemon-client.mjs)), and answers the plugin's question "Load it". | [`../docs/evidence/daemon.txt`](../docs/evidence/daemon.txt) |

Each screen is kept as text (`00-start.txt` … `05-answer.txt`, and
`transcript.txt` with all of them). Local paths are replaced by `<project>`
and `<tmp>`.

With 236 skills, Codex listed every skill by name only, without its
description, so a plain question did not lead the model to the served skill
(it searched the web), and naming it with `$` did. Codex's question is drawn by
Codex: the text above the choices and the three choices are the plugin's.

To record one yourself you need `pyte` (`pip install pyte`), Node 20+, and a
signed-in `codex`:

```bash
PTY_PYTHON=python3 live/take-proof.sh /tmp/my-run
```

[`take-proof.sh`](take-proof.sh) makes a throwaway `HOME` and `CODEX_HOME`,
copies only your sign-in (`auth.json`) into them, installs the plugin from this
repository's marketplace, adds Hugging Face's server there, and deletes it all
at the end. Your own `~/.codex` and `~/.agents` are not read or changed.
[`take-daemon.sh`](take-daemon.sh) does the same around its own app-server
daemon (`live/take-daemon.sh out.txt`; Node 20+ and a signed-in `codex`).
