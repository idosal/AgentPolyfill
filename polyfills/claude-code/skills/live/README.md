# Recorded sessions

Real, interactive Claude Code sessions with the mod, driven and recorded by a
script so they can be repeated.

| Script | What it records | Kept here |
|---|---|---|
| [`take-demo.sh`](take-demo.sh) | The session behind the README's video: Hugging Face's public MCP server, a list of its skills, one question, one approval, the answer. | [`runs/demo/`](runs/demo/) |
| [`take-real.sh`](take-real.sh) | Two public servers (Hugging Face and TogoMCP): the list, a skill read in a panel before loading, an approval, an answer from the skill's files, a shell command afterwards with nothing asked, and a skill of the second server. | [`runs/real-1/`](runs/real-1/) |

Each run folder holds the screen as text at each step (`01-….txt`, …), the
whole run (`transcript.txt`) and the scenario that drove it. The raw terminal
recording stays on the machine that made it. What is kept is passed through
[`tools/scrub-run.py`](../tools/scrub-run.py), which removes the recorder's
plan name, usage line and local paths.

To record one yourself you need `pyte` (`pip install pyte`) and a signed-in
`claude`:

```bash
PTY_PYTHON=python3 live/take-demo.sh /tmp/my-run
```
