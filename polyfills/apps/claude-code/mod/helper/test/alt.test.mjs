// Alt text for picture views, from the app's aria snapshot.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALT_CHARS, altFromSnapshot, altFromTree } from "../alt.mjs";

test("names and text in order, controls said as such, structure left out", () => {
  const snapshot = [
    '- heading "System Monitor" [level=1]',
    '- button "Stop"',
    '- text: "CPU 38%"',
    "- img",
    "- list:",
    "  - listitem: P0 38%",
    '- link "Docs":',
    "  - /url: https://example.com",
    '- checkbox "Live" [checked]',
  ].join("\n");
  assert.equal(altFromSnapshot(snapshot), "System Monitor. Stop (button). CPU 38%. P0 38%. Docs (link). Live (checkbox)");
});

test("an app's text can't reach the terminal as control sequences or hidden marks", () => {
  const text = altFromSnapshot('- text: "a\u001b]52;c;aGk=\u0007b‮c​d\u009be"');
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/);
  assert.match(text, /^a ]52;c;aGk= b c d e$/);
});

test("long text is cut at a word, within the limit", () => {
  const text = altFromSnapshot(`- paragraph: ${"word ".repeat(200)}`);
  assert.ok(text.length <= ALT_CHARS);
  assert.ok(text.endsWith("word…"));
});

test("from Chrome's accessibility tree: tree order, controls said as such, each once (as the Rust helper)", () => {
  const tree = { nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "4", "5"] },
    { nodeId: "4", role: { value: "StaticText" }, name: { value: "waiting" } },
    { nodeId: "2", role: { value: "heading" }, name: { value: "Echo" } },
    { nodeId: "3", role: { value: "button" }, name: { value: "Again" }, childIds: ["6"] },
    { nodeId: "5", role: { value: "StaticText" }, name: { value: "waiting" } },
    { nodeId: "6", role: { value: "StaticText" }, name: { value: "Again" } },
  ] };
  assert.equal(altFromTree(tree), "Echo. Again (button). waiting");
  assert.equal(altFromTree({ nodes: [{ nodeId: "1", role: { value: "textbox" }, value: { value: "typed\u001b[31m" } }] }), "typed [31m (textbox)");
  assert.ok(altFromTree({ nodes: [{ nodeId: "1", role: { value: "StaticText" }, name: { value: "word ".repeat(200) } }] }).length <= ALT_CHARS);
});
