// Shared by the palette tests: a busy animated scene, and a model of how
// Claude Code's Raster painter admits colour pairs.

import { DEFAULT } from "./pixels.mjs";

export const COLS = 90;
export const ROWS = 30;
export const CW = 8;
export const CH = 16;

/** A busy, moving scene: shaded hue bands that jump every 8 frames, and a ring. */
export function scene(t) {
  const w = COLS * CW;
  const h = ROWS * CH;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hue = ((x / w) * 720 + (y / h) * 300 + Math.floor(t / 8) * 137 + (((x >> 3) * 31 + (y >> 2) * 17 + t * 7) % 40)) % 360;
      const v = 0.25 + 0.75 * (y / h);
      const ring = Math.abs(Math.hypot(x - w / 2 - 80 * Math.cos(t / 7), y - h / 2) - 90) < 12;
      const channel = (n) => {
        const k = (n + hue / 60) % 6;
        return (v - v * 0.85 * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
      };
      data.set(ring ? [255, 240, 200, 255] : [channel(5), channel(3), channel(1), 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** Claude Code's painter, as far as admission goes. */
export function painter() {
  const held = new Map();
  let tokens = 4096;
  let paint = 0;
  const level = (c) =>
    c === DEFAULT
      ? 4096
      : (Math.round(((c >> 16) & 255) / 17) << 8) | (Math.round(((c >> 8) & 255) / 17) << 4) | Math.round((c & 255) / 17);
  return {
    /** Paints one frame `elapsed` ms after the last; returns the pairs it couldn't admit. */
    paint(words, elapsed) {
      tokens = Math.min(4096, tokens + (elapsed * 160) / 1000);
      paint++;
      let starved = 0;
      for (let i = 0; i < words.length; i += 3) {
        const key = (words[i] === 32 ? 4096 : level(words[i + 1])) * 8192 + level(words[i + 2]);
        if (held.has(key)) {
          held.set(key, paint);
          continue;
        }
        if (held.size < 1024 && tokens >= 1) {
          tokens--;
          held.set(key, paint);
          continue;
        }
        if (held.size >= 1024 && tokens >= 1025) {
          let oldest = null;
          let oldestPaint = Infinity;
          for (const [k, p] of held) if (p < paint && p < oldestPaint) [oldest, oldestPaint] = [k, p];
          if (oldest !== null) {
            held.delete(oldest);
            tokens--;
            held.set(key, paint);
            continue;
          }
        }
        starved++;
      }
      return starved;
    },
  };
}

