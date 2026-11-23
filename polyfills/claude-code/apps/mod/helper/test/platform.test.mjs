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
