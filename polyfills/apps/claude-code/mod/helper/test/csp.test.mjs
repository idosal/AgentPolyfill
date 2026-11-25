// CSP sources that name no one site aren't applied:
// the same cases as the Rust helper's policy tests.

import assert from "node:assert/strict";
import { test } from "node:test";
import { tooBroad } from "../csp.mjs";

test("broad sources are not applied, sites are", () => {
  const broad = ["*", "https:", "http://*", "https://*", "http://*:*", "https://*:443", "wss://*:*", "https://*.com", "*.com", "https://example.com:*", "https://*.*.example.com", "https://*.", "https://"];
  const named = ["https://*.example.com", "https://cdn.example.com", "https://example.com:8443", "wss://live.example.com", "blob:", "data:"];
  for (const source of broad) assert.ok(tooBroad(source), `${source} was taken as one site`);
  for (const source of named) assert.ok(!tooBroad(source), `${source} was refused`);
});
