// The generation rules (generations.mjs), the same cases as the Rust
// helper's (helper-rs/src/views.rs tests): before 0.1.3 both helpers matched
// a view's requests, answers and closes by its id alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { genOf, pageHeld, sameOpen } from "../generations.mjs";

test("an open takes only a page of its own generation", () => {
  assert.equal(pageHeld("a", "a"), "same");
  assert.equal(pageHeld("a", "b"), "other");
  assert.equal(pageHeld(undefined, "b"), "none");
});

test("a request is for its page only if it names that page's generation", () => {
  assert.equal(sameOpen("a", { viewId: "v", gen: "a" }), true);
  assert.equal(sameOpen("a", { viewId: "v", gen: "b" }), false);
  assert.equal(sameOpen("a", { viewId: "v" }), false);
  assert.equal(sameOpen("a", { viewId: "v", gen: 7 }), false);
  assert.equal(sameOpen("", { viewId: "v" }), true);
  assert.equal(genOf(null), "");
});
