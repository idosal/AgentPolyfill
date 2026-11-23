// What differs between macOS, Linux and Windows, kept apart so it can be tested
// on any of them.

/** A command line's words, a double-quoted one (a Windows path with spaces) kept whole. */
export function commandWords(line) {
  const words = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) words.push(m[1] ?? m[2]);
  return words;
}

/**
 * `--mcp-config` values in a `claude` command line: each word after the flag
 * up to the next flag, or the flag's own `=value`.
 */
export function mcpConfigArgs(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--mcp-config") {
      for (let j = i + 1; j < words.length && !words[j].startsWith("--"); j++) found.push(words[j]);
    } else if (words[i].startsWith("--mcp-config=")) {
      found.push(words[i].slice("--mcp-config=".length));
    }
  }
  return found;
}

/** How to run npm: on Windows it's npm.cmd, which Node runs only through a shell. */
export function npmCommand(platform = process.platform) {
  return platform === "win32" ? { command: "npm.cmd", shell: true } : { command: "npm", shell: false };
}
