"""Makes a recorded run fit to share: python3 scrub-run.py <run-dir> <repo-root>

The screen pictures (*.txt) and the scenario of a run are kept in the repository; the raw
recording is not. This takes out of them what is the recorder's own and no part of the
demonstration:

- the plan and account named beside the model in Claude Code's banner, and the banner's
  folder unless it is inside the repository;
- any line about their usage or its limits;
- the names of the session's servers that /mcp-skills says it did not look at (the
  recording account's claude.ai connectors, its plugins' servers), and how many more there
  were, and any claude.ai connector or plugin server named elsewhere;
- the command menu Claude Code draws under the prompt while a command is typed (it lists
  the account's own commands and skills);
- e-mail addresses, and the absolute paths of their machine.

Running it again over its own output changes nothing.
"""

import json
import os
import re
import sys

NOTE = "[names of the recording account's claude.ai connectors removed]"
MENU = "[command menu removed]"
FOLDER = "<project folder>"
# The sentence /mcp-skills ends its status with, before the names (mod/hooks/register.ts).
UNSEEN = "Not looked at, because they are not in your MCP configuration files (a plugin's servers, claude.ai connectors):"
# The sentences the status can go on with after it: where a list cut off by the screen ends.
AFTER = ("Approved by you", "Loaded in this conversation", "The helper runs on", "Read one before it is loaded")
SCREEN_START = re.compile(r"^===== .* @ \d\d:\d\d:\d\d$")
RULE = re.compile(r"^─{20,}$")
NAMES_ONLY = re.compile(r'^\s*(?:"[^"\n]*",?\s*)+(?:and \d+ more)?\.?\s*$|^\s*and \d+ more\.\s*$')
SERVER_NAME = re.compile(r"(?<![A-Za-z0-9])(?:claude_ai|plugin)_[A-Za-z0-9_-]+")
USAGE = re.compile(
    r"You've used \d+%|You've hit your|usage limit|limit reached|of your (?:weekly|daily|monthly|session|5-hour) limit|\bresets? (?:at )?(?:\w{3} )?\d{1,2}(?::\d\d)?\s?(?:am|pm)\b",
    re.I,
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


def unseen_servers(lines):
    """Replaces the names after UNSEEN with NOTE, however the screen wrapped the sentence."""
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        at = line.find("Not looked at, because")
        if at < 0:
            out.append(line)
            i += 1
            continue
        indent = line[: len(line) - len(line.lstrip())]
        # The sentence runs on to where its names end ('".' or 'and N more.'), or to where the
        # next sentence or the end of the answer is, if the screen cut it.
        block, j = [line], i + 1
        if not re.search(r'(?:"|more)\.\s*$', line):
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip() or not nxt.startswith(indent) or nxt.strip().startswith(AFTER):
                    break
                block.append(nxt)
                j += 1
                if re.search(r'(?:"|more)\.\s*$', nxt):
                    break
        # What comes before the names is kept as drawn: up to "connectors):".
        kept = []
        for part in block:
            cut = part.find("connectors):")
            if cut >= 0:
                kept.append(part[: cut + len("connectors):")])
                break
            kept.append(part)
        else:
            # The colon was never reached on screen: keep the start only.
            kept = [line[: at + len("Not looked at, because")] + " …"]
        out.extend(kept)
        if not (j < len(lines) and lines[j].strip() == NOTE):
            out.append(indent + NOTE)
        i = j
    return out


def names_at_top(lines):
    """The end of such a list whose start is above the top of a screen: lines of names only."""
    out, top = [], True
    for line in lines:
        if SCREEN_START.match(line):
            out.append(line)
            top = True
            continue
        if top and NAMES_ONLY.match(line) and line.strip():
            indent = line[: len(line) - len(line.lstrip())]
            if not (out and out[-1].strip() == NOTE):
                out.append(indent + NOTE)
            continue
        top = top and not line.strip()
        out.append(line)
    return out


def command_menu(lines):
    """What is under the prompt's box while a command is typed: the account's commands and skills."""
    out, i = [], 0
    while i < len(lines):
        out.append(lines[i])
        # A box: a rule, the prompt line(s), a rule.
        if RULE.match(lines[i]) and i + 1 < len(lines) and lines[i + 1].startswith("❯"):
            j = i + 1
            while j < len(lines) and not RULE.match(lines[j]):
                j += 1
            if j < len(lines):
                out.extend(lines[i + 1 : j + 1])
                k = j + 1
                while k < len(lines) and re.match(r"^\s+/\S", lines[k]):
                    k += 1
                if k > j + 1:
                    out.append("  " + MENU)
                i = k
                continue
        i += 1
    return out


def scrub_screen(text, root, root_short, home):
    text = text.replace("account\\'s", "account's")
    text = text.replace(root, "<repo>").replace(root_short, "<repo>").replace(home, "~")
    lines = text.split("\n")
    kept = []
    for line in lines:
        if USAGE.search(line):
            continue
        # The banner: the model, then " · " and the plan (and the account's organisation).
        if re.search(r"▝▜█+▀ ", line):
            line = re.sub(r" · .*$", "", line)
        # The banner's folder, unless it is inside the repository.
        banner_folder = re.match(r"^(\s*▝▝\s+▝▝\s+)(\S.*)$", line)
        if banner_folder and not banner_folder.group(2).startswith("<repo>"):
            line = banner_folder.group(1) + FOLDER
        kept.append(line)
    lines = command_menu(names_at_top(unseen_servers(kept)))
    text = "\n".join(lines)
    text = SERVER_NAME.sub("[name removed]", text)
    text = EMAIL.sub("<e-mail>", text)
    return text


def main():
    run, root = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    home = os.path.expanduser("~")
    # Claude Code's banner shows the folder it runs in with the home folder as "~".
    root_short = "~" + root[len(home) :] if root.startswith(home + os.sep) else root
    for name in sorted(os.listdir(run)):
        path = os.path.join(run, name)
        if name.endswith(".txt"):
            text = open(path, encoding="utf-8").read()
            open(path, "w", encoding="utf-8").write(scrub_screen(text, root, root_short, home))
        elif name == "scenario.json":
            text = open(path, encoding="utf-8").read().replace(root, "<repo>").replace(home, "~")
            json.loads(text)
            open(path, "w", encoding="utf-8").write(text)


if __name__ == "__main__":
    main()
