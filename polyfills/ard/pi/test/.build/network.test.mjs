// ../../server-cards/pi/test/network.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeFetch } from "../../extension/dist/index.js";
var stubFetch = (hops) => {
  const seen = [];
  const impl = (async (url, init) => {
    seen.push({ url, method: String(init.method) });
    const h = hops[url];
    if (!h) return new Response("missing", { status: 404 });
    return new Response(h.body ?? "", { status: h.status, headers: h.location ? { location: h.location } : {} });
  });
  return { impl, seen };
};
test("F-1 a redirect from a public origin to a private address is not followed", async () => {
  for (const to of ["http://127.0.0.1/x", "https://10.0.0.5/x", "https://localhost/x", "https://[::1]/x", "https://intranet/x", "https://0x7f.1/x"]) {
    const { impl, seen } = stubFetch({ "https://public.example/a": { status: 302, location: to } });
    await assert.rejects(nodeFetch({ fetchImpl: impl })("https://public.example/a"), /not HTTPS on a public host/, to);
    assert.equal(seen.length, 1, to);
  }
});
test("F-2 a redirect between public HTTPS origins is followed, and the answer is the last hop", async () => {
  const { impl, seen } = stubFetch({
    "https://neon.tech/.well-known/ai-catalog.json": { status: 301, location: "https://neon.com/.well-known/ai-catalog.json" },
    "https://neon.com/.well-known/ai-catalog.json": { status: 200, body: '{"ok":1}' }
  });
  const r = await nodeFetch({ fetchImpl: impl })("https://neon.tech/.well-known/ai-catalog.json");
  assert.deepEqual([r.status, r.text], [200, '{"ok":1}']);
  assert.deepEqual(seen.map((s) => s.url), ["https://neon.tech/.well-known/ai-catalog.json", "https://neon.com/.well-known/ai-catalog.json"]);
});
test("F-3 a redirect from HTTPS to plain HTTP is not followed; loopback to loopback is (local development)", async () => {
  const a = stubFetch({ "https://a.example/": { status: 302, location: "http://b.example/" } });
  await assert.rejects(nodeFetch({ fetchImpl: a.impl })("https://a.example/"), /not HTTPS/);
  const b = stubFetch({ "http://127.0.0.1:9/a": { status: 307, location: "/b" }, "http://127.0.0.1:9/b": { status: 200, body: "ok" } });
  assert.equal((await nodeFetch({ fetchImpl: b.impl })("http://127.0.0.1:9/a")).text, "ok");
});
test("F-4 at most five redirects", async () => {
  const hops = {};
  for (let i = 0; i < 7; i++) hops[`https://a.example/${i}`] = { status: 302, location: `https://a.example/${i + 1}` };
  await assert.rejects(nodeFetch({ fetchImpl: stubFetch(hops).impl })("https://a.example/0"), /more than 5 redirects/);
});
test("F-5 a request with a body (a search) is never redirected to another origin, nor turned into a GET", async () => {
  const a = stubFetch({ "https://r.example/search": { status: 307, location: "https://other.example/search" } });
  await assert.rejects(nodeFetch({ fetchImpl: a.impl })("https://r.example/search", { method: "POST", body: "{}" }), /not sent to an origin the person was not shown/);
  assert.equal(a.seen.length, 1);
  const b = stubFetch({ "https://r.example/search": { status: 303, location: "/results" } });
  await assert.rejects(nodeFetch({ fetchImpl: b.impl })("https://r.example/search", { method: "POST", body: "{}" }), /answered 303/);
  const c = stubFetch({ "https://r.example/search": { status: 308, location: "/v2/search" }, "https://r.example/v2/search": { status: 200, body: "ok" } });
  assert.equal((await nodeFetch({ fetchImpl: c.impl })("https://r.example/search", { method: "POST", body: "{}" })).text, "ok");
  assert.deepEqual(c.seen.map((s) => s.method), ["POST", "POST"]);
});
test("F-6 an answer larger than the cap is not read (413), whatever its Content-Length says", async () => {
  const big = "x".repeat(2e3);
  const impl = (async () => new Response(big, { status: 200 }));
  assert.equal((await nodeFetch({ fetchImpl: impl, maxBody: 1e3 })("https://a.example/")).status, 413);
  const chunked = (async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode("y".repeat(400)));
    c.close();
  } }), { status: 200 }));
  assert.equal((await nodeFetch({ fetchImpl: chunked, maxBody: 1e3 })("https://a.example/")).status, 413);
});
