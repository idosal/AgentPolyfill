// CDP bindings return no value. Preserve exposeBinding's Promise contract,
// with the response delivered in the very execution context that called.
(() => {
  const send = window.__cliHost;
  const pending = new Map();
  let next = 0;
  const binding = (kind, payload) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    send(JSON.stringify({ id, kind, payload }));
  });
  binding.__answer = (id, ok, result) => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (ok) waiting.resolve(result);
    else waiting.reject(new Error(result));
  };
  window.__cliHost = binding;
})();
