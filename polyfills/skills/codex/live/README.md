# Recorded sessions

Real Codex sessions with the plugin, driven by a script so they can be
repeated.

| What | Kept here |
|---|---|
| The terminal UI (Codex 0.172.0, macOS), Hugging Face's public MCP server, in a throwaway Codex home made by [`take-proof.sh`](take-proof.sh): the served skill in Codex's `$` skill picker, marked with its server; a question it fits; Codex calling `load_skill`; the plugin's question; "Show me its SKILL.md first"; "Load it"; the answer, from the skill and two reference files read with `read_skill_file`. | [`runs/proof/`](runs/proof/) |
| The same steps in a Codex home that has many other skills and plugins (236 skills). | [`runs/own-home/`](runs/own-home/) |
| `codex exec`, unattended: a skill approved in the interactive session loads with no question; one never approved is refused, and nothing of it is used. | [`../docs/evidence/exec.txt`](../docs/evidence/exec.txt) |

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

[`take-proof.sh`](take-proof.sh) makes a throwaway `CODEX_HOME`, copies only
your sign-in (`auth.json`) into it, installs the plugin from this repository's
marketplace, adds Hugging Face's server there, and deletes it all at the end.
Your own Codex config is not read or changed.
