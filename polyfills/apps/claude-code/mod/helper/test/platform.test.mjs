// What differs on Windows: reading claude's command line (quoted paths with
// spaces) and running npm (npm.cmd, through a shell).

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandWords, mcpConfigArgs, npmCommand } from "../platform.mjs";

test("a Windows command line's quoted path with spaces stays one word", () => {
  const line = '"C:\\Program Files\\Claude\\claude.exe" --model sonnet --mcp-config "C:\\Users\\Ada Lovelace\\mcp.json" --verbose';
  assert.deepEqual(commandWords(line), [
    "C:\\Program Files\\Claude\\claude.exe",
    "--model",
    "sonnet",
    "--mcp-config",
    "C:\\Users\\Ada Lovelace\\mcp.json",
    "--verbose",
  ]);
  assert.deepEqual(mcpConfigArgs(commandWords(line)), ["C:\\Users\\Ada Lovelace\\mcp.json"]);
});

test("--mcp-config takes several files, or one after =", () => {
  assert.deepEqual(mcpConfigArgs(commandWords("claude --mcp-config a.json b.json --strict-mcp-config")), ["a.json", "b.json"]);
  assert.deepEqual(mcpConfigArgs(commandWords("claude --mcp-config=c.json")), ["c.json"]);
  assert.deepEqual(mcpConfigArgs(commandWords("claude --model opus")), []);
});

test("npm is npm.cmd through a shell on Windows, npm elsewhere", () => {
  assert.deepEqual(npmCommand("win32"), { command: "npm.cmd", shell: true });
  assert.deepEqual(npmCommand("darwin"), { command: "npm", shell: false });
  assert.deepEqual(npmCommand("linux"), { command: "npm", shell: false });
});

// A file saved from an app is marked as downloaded.
test("a saved download is marked as downloaded (macOS: com.apple.quarantine)", { skip: process.platform !== "darwin" }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { markDownloaded } = await import("../platform.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-download-"));
  const file = path.join(dir, "report.command");
  fs.writeFileSync(file, "#!/bin/sh\necho hi\n");
  markDownloaded(file, { fs, execFileSync });
  const value = execFileSync("xattr", ["-p", "com.apple.quarantine", file], { encoding: "utf8" }).trim();
  assert.match(value, /^0081;[0-9a-f]{8};mcp-apps-cli;$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a saved download is marked as downloaded (Windows: Zone.Identifier, zone 3)", async () => {
  const { markDownloaded } = await import("../platform.mjs");
  const written = {};
  const file = "C:\\Users\\Ada\\Downloads\\report.docm";
  markDownloaded(file, { platform: "win32", fs: { writeFileSync: (f, t) => (written[f] = t) }, execFileSync: () => assert.fail("nothing to run") });
  assert.deepEqual(written, { [`${file}:Zone.Identifier`]: "[ZoneTransfer]\r\nZoneId=3\r\n" });
});

// The helper's own temporary folder is checked, not taken as found.
test("a private folder that is a link is refused; one open to others is closed", { skip: process.platform === "win32" }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { privateFolder } = await import("../platform.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-private-"));
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const link = path.join(root, "mcp-apps-cli-1.tmp");
  fs.symlinkSync(elsewhere, link);
  assert.throws(() => privateFolder(link, fs), /not a folder/);
  const open = path.join(root, "mcp-apps-cli-2.tmp");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  privateFolder(open, fs);
  assert.equal(fs.statSync(open).mode & 0o777, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});
