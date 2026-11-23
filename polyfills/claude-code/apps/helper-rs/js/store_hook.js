(() => {
  let writes = 0;
  // Each write is counted, and the helper hears of it (its binding), so it
  // saves the store about a second later, before a helper ended outright
  // loses it.
  let soon = 0;
  const count = (proto, names) => {
    for (const name of names) {
      const real = proto && proto[name];
      if (typeof real !== "function") continue;
      proto[name] = function () {
        writes++;
        if (!soon) soon = setTimeout(() => { soon = 0; try { window.__cliChanged?.("store"); } catch {} }, 50);
        return real.apply(this, arguments);
      };
    }
  };
  count(window.Storage && Storage.prototype, ["setItem", "removeItem", "clear"]);
  count(window.IDBObjectStore && IDBObjectStore.prototype, ["put", "add", "delete", "clear"]);
  Object.defineProperty(window, "__cliStoreWrites", { get: () => writes });
})()
