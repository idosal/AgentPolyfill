// What an app's CSP may name: no npm packages, so the Node helper's tests
// import this file directly. The same rule as the Rust helper's too_broad
// (helper-rs/src/policy.rs).

/**
 * A source that names no one site, and so isn't applied (security review,
 * A4): `*`; a scheme alone (`https:`); a wildcard host (`*`, or `*.` over
 * fewer than two labels, such as `*.com`); a wildcard port (`:*`). Without
 * the public suffix list, a wildcard over a two-label suffix such as
 * `*.co.uk` still passes.
 */
export function tooBroad(source) {
  const lower = String(source).toLowerCase();
  if (lower === "*" || ["http:", "https:", "ws:", "wss:"].includes(lower)) return true;
  const at = lower.indexOf("://");
  const authority = at >= 0 ? lower.slice(at + 3) : lower;
  let end;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    end = close >= 0 ? close + 1 : authority.length;
  } else {
    const stop = authority.search(/[:/]/);
    end = stop >= 0 ? stop : authority.length;
  }
  const host = authority.slice(0, end);
  const rest = authority.slice(end);
  if (!host || (rest.startsWith(":") && rest.slice(1).split("/")[0] === "*")) return true;
  if (!host.includes("*")) return false;
  if (!host.startsWith("*.")) return true;
  const under = host.slice(2);
  return under.includes("*") || under.split(".").filter(Boolean).length < 2;
}
