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

/**
 * A folder made or found private: a folder, not a link, owned by this user
 * and closed to others. Throws otherwise. Its name may be one another local
 * user can guess (the helper's own temporary folder, in a shared /tmp on
 * Linux), so it is checked, not taken as found (security review, A6).
 */
export function privateFolder(dir, fsImpl) {
  const fs = fsImpl;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} is not a folder`);
  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) throw new Error(`${dir} is owned by someone else`);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  return dir;
}

/**
 * Marks a file the person saved from an app as downloaded from the internet,
 * the way browsers do (security review, A5): macOS's com.apple.quarantine
 * attribute, which Gatekeeper reads, or Windows' Zone.Identifier stream
 * (zone 3, the internet). Linux has no such mark.
 */
export function markDownloaded(file, { fs, execFileSync, platform = process.platform, now = Date.now() }) {
  if (platform === "darwin") {
    const value = `0081;${Math.floor(now / 1000).toString(16).padStart(8, "0")};mcp-apps-cli;`;
    execFileSync("xattr", ["-w", "com.apple.quarantine", value, file]);
  } else if (platform === "win32") {
    fs.writeFileSync(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  }
}
