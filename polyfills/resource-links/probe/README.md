# Probes

[`run.sh`](run.sh) measures what Claude Code and Codex do today when a tool
returns a resource link, with no polyfill installed. It's what
[`../docs/findings.md`](../docs/findings.md) is based on.

```bash
probe/run.sh <out-dir> [claude|codex|both]
```

It runs two copies of the fixture server as `docs` and `other`, asks each host
to call one tool and follow the link, and keeps what the host gave the model.
[`summarize.py`](summarize.py) turns each host's output into the text files
kept in `runs/`.

## Signing in

The script never copies, reads or passes on a credential, and has no option
to.

- **Claude Code** runs as `claude -p`, so it uses the sign-in it already has,
  the same as any `claude -p` you run. The script only limits it to the two
  fixture servers and project settings.
- **Codex** runs in a throwaway `HOME` and `CODEX_HOME`, which start signed
  out. The script prints the command to sign in there and waits:

  ```
  Sign in to Codex inside the throwaway home. In another terminal, run:

    HOME=/tmp/… CODEX_HOME=/tmp/… codex login

  Then press Enter here.
  ```

  Run it, sign in with Codex's own login, and press Enter. When the script
  ends, Codex signs out of that home and the home is deleted.
- Without a terminal to ask in, the Codex half stops before it runs anything.

Your own Claude Code settings, Codex config and MCP servers aren't used.

A test, [`../codex/test/no-credentials-test.ts`](../codex/test/no-credentials-test.ts),
fails if any file in this polyfill (code, tests, docs, recorded runs) names
a host's sign-in file, a keychain entry or a key variable, or if a script
names your own Codex or Claude Code home.

## How the kept runs were made

The runs in [`runs/before/`](runs/before/) were made on 24 November 2026 by an
earlier version of this script and by commands run by hand, on Claude Code
2.1.331 and Codex 0.172.0. For Codex, those copied the Codex sign-in file from
`~/.codex` into the throwaway home. They shouldn't have, and the script no
longer does. The copies were deleted with the throwaway homes. The outputs
were scanned for token-shaped strings and none were found.
