(() => {
  if (window.parent === window || window.parent !== window.top) return;
  const write = async (text) => {
    window.parent.postMessage({ type: "mcp-apps-cli/copy", text: String(text) }, "*");
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write, write: async () => {} } });
  } catch {}
})();
