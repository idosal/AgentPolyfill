(() => {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("*, *::before, *::after { transition-duration: 1ms !important; transition-delay: 0s !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
})();
