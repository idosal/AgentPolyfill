(() => {
  const lines = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_TEXT);
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION", "TITLE"]);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || skip.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const bold = Number(cs.fontWeight) >= 600;
    // SVG text is painted with fill, not color.
    const color =
      el instanceof SVGElement && cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url(")
        ? cs.fill
        : cs.color;
    const text = node.data;
    // As drawn: CSS text-transform changes case, not layout (one character
    // stays one character for these).
    const transform = cs.textTransform;
    const shown = (i) =>
      transform === "uppercase"
        ? text[i].toUpperCase()
        : transform === "lowercase"
          ? text[i].toLowerCase()
          : transform === "capitalize" && (i === 0 || /\s/.test(text[i - 1]))
            ? text[i].toUpperCase()
            : text[i];
    let line = null;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      const shownChar = shown(i);
      const ch = /\s/.test(text[i]) ? " " : shownChar.length === 1 ? shownChar : text[i];
      const cy = rect.top + rect.height / 2;
      if (line && Math.abs(cy - line.cy) < rect.height / 2 && rect.left >= line.right - 1) {
        line.t += ch;
        line.right = rect.right;
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        if (line) lines.push(line);
        line = {
          x: rect.left,
          cy,
          t: ch,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          color,
          bold,
        };
      }
    }
    if (line) lines.push(line);
  }
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const padLeft = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const padTop = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
    const focused = document.activeElement === el;
    if (type === "checkbox" || type === "radio") {
      const mark = type === "checkbox" ? (el.checked ? "[x]" : "[ ]") : el.checked ? "(•)" : "( )";
      lines.push({ x: rect.left, cy: rect.top + rect.height / 2, t: mark, color: cs.color });
      continue;
    }
    if (["hidden", "range", "color", "file", "button", "submit", "reset", "image"].includes(type)) continue;
    let value = el.tagName === "SELECT" ? (el.selectedOptions[0]?.text ?? "") : el.value;
    let dim = false;
    if (!value && el.placeholder) {
      value = el.placeholder;
      dim = true;
    }
    if (type === "password") value = "•".repeat(value.length);
    const caret = focused && !dim && typeof el.selectionStart === "number" ? el.selectionStart : null;
    const rowsOfText = el.tagName === "TEXTAREA" ? value.split("\n") : [value];
    let offset = 0;
    const isSelect = el.tagName === "SELECT";
    // A dropdown's arrow is drawn by the browser or a background image, a few
    // pixels that would come out as a dash: draw it as a character instead.
    // The arrow goes in the last cell inside the border, and the label may run
    // up to it: a terminal font is wider than the page's, so every cell counts.
    const arrowWidth = 10;
    const arrowed =
      isSelect && !el.multiple && el.size <= 1 && (cs.appearance !== "none" || cs.backgroundImage !== "none");
    rowsOfText.forEach((t, i) => {
      const lineCaret =
        caret != null && caret >= offset && caret <= offset + t.length ? caret - offset : null;
      lines.push({
        x: rect.left + padLeft,
        cy: isSelect ? rect.top + rect.height / 2 : rect.top + padTop + lineHeight * (i + 0.5),
        t,
        color: cs.color,
        dim,
        maxX: arrowed ? rect.right - (parseFloat(cs.borderRightWidth) || 0) - arrowWidth : rect.right - padLeft,
        caret: isSelect ? null : focused && dim && i === 0 ? 0 : lineCaret,
        inverse: isSelect && focused,
      });
      offset += t.length + 1;
    });
    if (arrowed) {
      const right = rect.right - (parseFloat(cs.borderRightWidth) || 0);
      lines.push({
        x: right - arrowWidth,
        cy: rect.top + rect.height / 2,
        t: "▾",
        color: cs.color,
        top: rect.top + rect.height * 0.2,
        bottom: rect.bottom - rect.height * 0.2,
        right: right - 1,
        inverse: focused,
      });
    }
  }
  if (typeof window.__cliCanvasTexts === "function") {
    for (const t of window.__cliCanvasTexts()) {
      if (t.bottom < 0 || t.top > vh || t.right < 0 || t.x > vw) continue;
      lines.push({ ...t, source: "canvas" });
    }
  }
  return lines;
})()
