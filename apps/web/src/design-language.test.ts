import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const html = read('../index.html');
const fontsCss = read('../public/fonts/fonts.css');
const style = read('./style.css');

const colourTokens: Record<string, string> = {
  '--void': '#080810',
  '--night': '#181838',
  '--night-raised': '#282858',
  '--bone': '#f8f0d8',
  '--dust': '#a8a8c8',
  '--candle': '#f8c838',
  '--candle-deep': '#a87818',
  '--on-candle': '#080810',
  '--heart': '#e84058',
  '--herb': '#b0f888',
  '--mana': '#50a8f8',
};

describe('design language tokens and fonts', () => {
  it('index.html links the local fonts stylesheet exactly once and no Google font host', () => {
    const links = html.match(/<link[^>]*href="\/fonts\/fonts\.css"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('serves eight @font-face rules from absolute /fonts/ URLs only', () => {
    const faces = fontsCss.match(/@font-face/g) ?? [];
    expect(faces).toHaveLength(8);
    const urls = [...fontsCss.matchAll(/url\(([^)]*)\)/g)].map(match => match[1].replace(/['"]/g, ''));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('/fonts/')).toBe(true);
    }
  });

  it('declares each colour token with its exact value on :root', () => {
    const root = style.slice(0, style.indexOf('}') + 1);
    for (const [name, value] of Object.entries(colourTokens)) {
      expect(root).toContain(`${name}: ${value};`);
    }
  });
});
