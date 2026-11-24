// Each open of a view has its own generation (from 0.1.3): the mod's nonce,
// sent with /open and with every request about the view, and carried by
// everything the helper says of the view's page. The same rules as the Rust
// helper's (helper-rs/src/views.rs; model/AppsViews.tla, FixGen).

/** The generation a request names; "" where none is given (a driver that predates them, whose opens name none either). */
export function genOf(body) {
  return typeof body?.gen === "string" ? body.gen : "";
}

/** Whether a request (or a reply) is for the open a page is of: anything for another generation is refused. */
export function sameOpen(pageGen, body) {
  return pageGen === genOf(body);
}

/**
 * What an /open does with the page the helper holds for its id: "same", the
 * same open asked again, gets it back; "other", a page of another open, is
 * closed and this open makes its own; "none", there is none.
 */
export function pageHeld(pageGen, gen) {
  if (pageGen === undefined) return "none";
  return pageGen === gen ? "same" : "other";
}
