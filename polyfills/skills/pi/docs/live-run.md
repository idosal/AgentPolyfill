# A live run of mcp-skills in Pi

A real Pi and a real model, against Hugging Face's public MCP server
(`https://huggingface.co/mcp`), which serves skills: a server this project
didn't write. Asked a question, Pi read the stubs of the served skills it
found in its own skill list (from a codemode script), called `load_skill` for
two of them, and the extension asked the user once for each. Pi then read two
of the skill's reference files through codemode (`read_skill_file`, checked
against their digests) and answered from them.

Recorded on 24 November 2026 (UTC) with Pi 1.6.0 from this folder's
devDependencies, run in RPC mode by the script below, with its own home and
state folder. The model was `gpt-6.2-sol` through Pi's `openai-codex` provider,
signed in with `/login` in an agent directory of its own; the script never
reads that directory's credentials. The script answers the extension's
questions with the yes it asks for, and prints what Pi did. Local paths are
replaced with `<agent dir>` and `<temp>`; tool results are cut at a few hundred
characters, as the script prints them.


The agent folder is a throwaway one, never your own: make it with
`node live/run.ts --new-agent-dir <path>`, sign in to it (`PI_CODING_AGENT_DIR=<path> pi`,
then `/login`), then run. The script refuses any other folder, writes `mcp.json`
only where a live run left the one there, and prints servers by name and
origin only ([`live/agent-dir.ts`](../live/agent-dir.ts)). Afterwards, sign out with
`PI_CODING_AGENT_DIR=<path> pi auth logout <provider>` and delete the folder.

```bash
PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node live/run.ts
```

```text
[user] Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?

[Pi asks the user] Load the skill "hf-mem" from the MCP server "huggingface"?

It is not a local skill: the server serves it, and its text will reach the model as that server's content. Once it is loaded, the model may act on it as on a skill on your disk.
URI: skill://hf-mem/SKILL.md
1 file, 1901 bytes, each checked against the server's SHA-256 digest when read.
The server's description: Estimate the GPU memory needed to run a Hugging Face model (weights, KV cache and inference overhead) and whether it fits on given GPUs, without downloading it. Use when asked how much VRAM a model needs, whether it fits on a GPU, the longest context that fits, or which GGUF quantization to pick.
  options: Don't load it | Show me its SKILL.md first | Load it

[user answers] Load it

[Pi asks the user] Load the skill "huggingface-local-models" from the MCP server "huggingface"?

It is not a local skill: the server serves it, and its text will reach the model as that server's content. Once it is loaded, the model may act on it as on a skill on your disk.
URI: skill://huggingface-local-models/SKILL.md
4 files, 15849 bytes, each checked against the server's SHA-256 digest when read.
The server's description: Use to select models to run locally with llama.cpp and GGUF on CPU, Mac Metal, CUDA, or ROCm. Covers finding GGUFs, quant selection, running servers, exact GGUF file lookup, conversion, and OpenAI-compatible local serving.
  options: Don't load it | Show me its SKILL.md first | Load it

[user answers] Load it

[tool call] codemode {"code":"const root=\"<temp>/state/served/huggingface-d203a2/\";\nawait Promise.all([\"74d8640e89f964df\",\"c483b0880c0e2bac\",\"515269081734d025\",\"5c29596833af251a\"].map(async x=>text(await tools.read({path:root+x+\"/SKILL

[tool call] read {"path":"<temp>/state/served/huggingface-d203a2/74d8640e89f964df/SKILL.md","offset":null,"limit":null}

[tool call] read {"path":"<temp>/state/served/huggingface-d203a2/c483b0880c0e2bac/SKILL.md","offset":null,"limit":null}

[tool call] read {"path":"<temp>/state/served/huggingface-d203a2/515269081734d025/SKILL.md","offset":null,"limit":null}

[tool call] read {"path":"<temp>/state/served/huggingface-d203a2/5c29596833af251a/SKILL.md","offset":null,"limit":null}

[tool result] --- name: "mcp-huggingface-hf-mem" description: "[MCP server \"huggingface\", not a local skill] Estimate the GPU memory needed to run a Hugging Face model (weights, KV cache and inference overhead) and whether it fits on given GPUs, without downloading it. Use when asked how much VRAM a model needs

[tool result] --- name: "mcp-huggingface-hf-cli" description: "[MCP server \"huggingface\", not a local skill] Hugging Face Hub CLI (`hf`) for downloading, uploading, and managing models, datasets, spaces, buckets, repos, papers, jobs, and more on the Hugging Face Hub. Use when: handling authentication; managing 

[tool result] --- name: "mcp-huggingface-huggingface-local-models" description: "[MCP server \"huggingface\", not a local skill] Use to select models to run locally with llama.cpp and GGUF on CPU, Mac Metal, CUDA, or ROCm. Covers finding GGUFs, quant selection, running servers, exact GGUF file lookup, conversion,

[tool result] --- name: "mcp-huggingface-huggingface-best" description: "[MCP server \"huggingface\", not a local skill] Use when the user asks about finding the best, top, or recommended model for a task, wants to know what AI model to use, or wants to compare models by benchmark scores. Triggers on: \"best mode

[tool result] Script completed Wall time 0.1 seconds Output: ==> text 1/4 <== --- name: "mcp-huggingface-hf-mem" description: "[MCP server \"huggingface\", not a local skill] Estimate the GPU memory needed to run a Hugging Face model (weights, KV cache and inference overhead) and whether it fits on given GPUs, wi

[tool call] load_skill {"server":"huggingface","uri":"skill://hf-mem/SKILL.md"}

[tool result] Loaded the skill "hf-mem" from the MCP server "huggingface" (skill://hf-mem/SKILL.md), which the user approved just now. Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. That shows the server is consistent, not that the content can be trusted. What follows 

[tool call] load_skill {"server":"huggingface","uri":"skill://huggingface-local-models/SKILL.md"}

[tool result] Loaded the skill "huggingface-local-models" from the MCP server "huggingface" (skill://huggingface-local-models/SKILL.md), which the user approved just now. Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. That shows the server is consistent, not that the c

[tool call] codemode {"code":"await Promise.all([\"references/quantization.md\",\"references/hardware.md\"].map(async path=>text(await tools.read_skill_file({server:\"huggingface\",skill:\"skill://huggingface-local-models/SKILL.md\",path}))));\n"}

[tool call] read_skill_file {"server":"huggingface","skill":"skill://huggingface-local-models/SKILL.md","path":"references/quantization.md"}

[tool call] read_skill_file {"server":"huggingface","skill":"skill://huggingface-local-models/SKILL.md","path":"references/hardware.md"}

[tool result] "references/quantization.md" of the skill "huggingface-local-models", from the MCP server "huggingface" (6136 bytes, matched the size and SHA-256 digest in the skill's entry). Content from that server: <mcp-skill-file id="cac78c550e78" server="huggingface" uri="skill://huggingface-local-models/refer

[tool result] "references/hardware.md" of the skill "huggingface-local-models", from the MCP server "huggingface" (623 bytes, matched the size and SHA-256 digest in the skill's entry). Content from that server: <mcp-skill-file id="71b39bed4290" server="huggingface" uri="skill://huggingface-local-models/references

[tool result] Script completed Wall time 0.2 seconds Output: ==> text 1/2 <== "references/quantization.md" of the skill "huggingface-local-models", from the MCP server "huggingface" (6136 bytes, matched the size and SHA-256 digest in the skill's entry). Content from that server: <mcp-skill-file id="cac78c550e78" 

[Pi] Start with **`Q4_K_M`** for a 7B model on a 16 GB Mac. The weights are typically **4–4.5 GB**, leaving room for macOS, other apps, and the context cache.

| Quantization | Typical 7B file size | When to pick it |
|---|---:|---|
| **`Q4_K_M`** | 4–4.5 GB | Best default for everyday use or longer contexts |
| `Q5_K_M` | 4.8–5.2 GB | A modest quality bump, especially worth trying for coding |
| `Q6_K` | 5.5–6 GB | More quality if you have memory to spare |

File size isn’t total RAM usage: the context cache grows with context length. Start at **4,096 tokens** and increase it if macOS memory pressure stays green.
```

## Shown first, then loaded

Recorded on 25 November 2026 (UTC), the same way, after the core began holding
a load to the read it showed (`preview` with `keep`, `load` with `shown`). The
script was run with `PI_LIVE_SHOW=1`, so the user answers each question with
"Show me its SKILL.md first" and then "Load it". For both skills Pi loaded
(`huggingface-local-models` and `hf-mem`), the user was shown the `SKILL.md`,
checked against its digest, and the load that followed was held to it and
went through. Pi then read the same two reference files and gave the same
answer. In an earlier run the same day the model loaded three skills from one
codemode script at once. That's why the extension now takes loads one after
another: the core keeps one showing for the load that follows it.

```bash
PI_LIVE_SHOW=1 PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node live/run.ts
```

```text
[Pi asks the user] Load the skill "huggingface-local-models" from the MCP server "huggingface"?
  options: Don't load it | Show me its SKILL.md first | Load it
[user answers] Show me its SKILL.md first
[Pi asks the user] The SKILL.md of "huggingface-local-models", from the MCP server "huggingface", checked against its digest. This is shown to you only; the model has not seen it. …
  options: Don't load it | Load it
[user answers] Load it
[Pi asks the user] Load the skill "hf-mem" from the MCP server "huggingface"?
  options: Don't load it | Show me its SKILL.md first | Load it
[user answers] Show me its SKILL.md first
[Pi asks the user] The SKILL.md of "hf-mem", from the MCP server "huggingface", checked against its digest. This is shown to you only; the model has not seen it. …
  options: Don't load it | Load it
[user answers] Load it
[tool call] load_skill {"server":"huggingface","uri":"skill://huggingface-local-models/SKILL.md"}
[tool result] Loaded the skill "huggingface-local-models" from the MCP server "huggingface" (skill://huggingface-local-models/SKILL.md), which the user approved just now. Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. …
[tool call] load_skill {"server":"huggingface","uri":"skill://hf-mem/SKILL.md"}
[tool result] Loaded the skill "hf-mem" from the MCP server "huggingface" (skill://hf-mem/SKILL.md), which the user approved just now. Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. …
```
