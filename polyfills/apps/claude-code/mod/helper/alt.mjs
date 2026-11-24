// Alt text for a picture view: what the app shows, as one short line, from
// Chrome's accessibility tree of its frame (as the Rust helper reads it,
// helper-rs/src/alt.rs), or from Playwright's aria snapshot. Claude Code reads an Image's alt
// to a screen reader and draws it where the terminal can't show pictures.
// The app's text is untrusted: no control characters reach the terminal.

/** At most this many characters. */
export const ALT_CHARS = 300;

/** Roles named with what they are: a person acts on them. */
const ALT_CONTROLS = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "textbox", "combobox", "slider", "menuitem", "searchbox", "spinbutton"]);

/** Text from an app for the terminal: no control characters, and no bidi or invisible marks. */
export function plainText(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Playwright's aria snapshot (YAML) as one short line: names and text, controls said as such. */
export function altFromSnapshot(snapshot) {
  const parts = [];
  for (const raw of String(snapshot).split("\n")) {
    const line = raw.replace(/^\s*-\s*/, "").trim();
    if (!line || line.startsWith("/")) continue;
    const named = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]]*\])*:?\s*(.*)$/.exec(line);
    if (!named) continue;
    const [, role, name = "", quoted = ""] = named;
    // YAML quotes a value that needs it.
    const rest = /^".*"$/.test(quoted) ? quoted.slice(1, -1) : quoted;
    const text = plainText(`${name} ${role === "text" || !name ? rest : ""}`.replace(/\\"/g, '"'));
    if (!text) continue;
    parts.push(ALT_CONTROLS.has(role) ? `${text} (${role})` : text);
  }
  const all = [...new Set(parts)].join(". ");
  return all.length <= ALT_CHARS ? all : `${all.slice(0, ALT_CHARS - 1).replace(/\s+\S*$/, "")}…`;
}


/** Roles that are structure, not something to say. */
const ALT_STRUCTURE = new Set(["RootWebArea", "WebArea", "generic", "none", "InlineTextBox", "LineBreak"]);

/** At most ALT_CHARS UTF-16 units, cut at a word. */
function shorten(text) {
  return text.length <= ALT_CHARS ? text : `${text.slice(0, ALT_CHARS - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * Chrome's accessibility tree (Accessibility.getFullAXTree) as one short
 * line, in tree order: names and text, controls said as such, each once.
 */
export function altFromTree(tree) {
  const nodes = tree?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visited = new Set();
  const parts = [];
  const walk = (node) => {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = node.role?.value ?? "";
    const name = plainText(node.name?.value ?? "");
    const ignored = node.ignored === true;
    if (!ignored && !ALT_STRUCTURE.has(role) && name) parts.push(ALT_CONTROLS.has(role) ? `${name} (${role})` : name);
    // A control is said by its name, not its text children again; a text
    // field with no name by its value.
    if (!ignored && ALT_CONTROLS.has(role)) {
      if (["textbox", "searchbox", "spinbutton"].includes(role)) {
        const value = plainText(node.value?.value ?? "");
        if (!name && value) parts.push(`${value} (${role})`);
      }
      return;
    }
    if (!ignored && ["heading", "img", "StaticText"].includes(role) && name) return;
    for (const child of node.childIds ?? []) walk(byId.get(child));
  };
  walk(nodes[0]);
  return shorten([...new Set(parts)].join(". "));
}
