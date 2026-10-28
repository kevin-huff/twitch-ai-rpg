import { readdirSync, readFileSync } from 'node:fs';
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

// Guards that keep the language from drifting: every stylesheet the app ships is style.css plus each
// component's <style> block, and templates must not use characters the three pixel fonts cannot draw.
const components = readdirSync(fileURLToPath(new URL('./', import.meta.url))).filter(name => name.endsWith('.vue')).sort();
const sources = [
  { name: 'style.css', css: style, template: '' },
  ...components.map(name => {
    const text = read(`./${name}`);
    return { name, css: [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n'), template: text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '') };
  }),
];
const findings = (pattern: RegExp, keep: (match: RegExpMatchArray) => boolean = () => true) =>
  sources.flatMap(({ name, css }) => [...css.matchAll(pattern)].filter(keep).map(match => `${name}: ${match[0].trim()}`));

describe('design language guards', () => {
  it('reads every component stylesheet', () => {
    expect(components.length).toBeGreaterThan(40);
  });

  it('uses no retired colour variable', () => {
    expect(findings(/var\(--(gold|muted|panel|line|teal)\)/g)).toEqual([]);
  });

  it('rounds no corner', () => {
    expect(findings(/border-radius\s*:\s*([^;}]+)/g, match => !/^0(px)?(\s*!important)?$/.test(match[1].trim()))).toEqual([]);
  });

  it('uses no see-through colour, blur or filter', () => {
    expect(findings(/rgba\(|hsla\(|#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{4}\b|blur\(|(?<![-\w])filter\s*:\s*(?!none)[^;}]*/g)).toEqual([]);
  });

  it('moves only in steps', () => {
    expect(findings(/transition\s*:\s*([^;}]+)/g, match => !/^none\b/.test(match[1].trim()) && !/steps\(/.test(match[1]))).toEqual([]);
  });

  it('puts no arrow the fonts cannot draw in a template', () => {
    expect(sources.filter(({ template }) => /[←-⇿]/.test(template)).map(({ name }) => name)).toEqual([]);
  });
});
