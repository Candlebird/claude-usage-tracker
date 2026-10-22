// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

const lightBlock = css.slice(css.indexOf(":root[data-theme='light']"));

function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:[ \\t]*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`missing --${name}`);
  return m[1]!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('light theme status tokens', () => {
  for (const status of ['good', 'warning', 'serious', 'critical']) {
    it(`--${status} reaches 3:1 on surfaces and the meter track`, () => {
      const fg = token(lightBlock, status);
      for (const bg of ['surface', 'surface-2', 'track']) expect(contrast(fg, token(lightBlock, bg))).toBeGreaterThanOrEqual(3);
    });
  }

  it('defines the same status colors in the OS-preference light block', () => {
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: light)'), css.indexOf(":root[data-theme='light']"));
    for (const status of ['good', 'warning', 'serious', 'critical']) expect(token(media, status)).toBe(token(lightBlock, status));
  });
});
