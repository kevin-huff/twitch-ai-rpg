// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeHtml, galleryMissingPage, GALLERY_CSS, GALLERY_SCRIPT } from '../src/gallery-html';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (input, output) => {
    expect(escapeHtml(input)).toBe(output);
  });

  it('escapes a string holding all of them, ampersand first', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;',
    );
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('The Canal Gate')).toBe('The Canal Gate');
  });
});

describe('galleryMissingPage', () => {
  const page = galleryMissingPage();

  it('is a noindex page that links the shared stylesheet', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).toContain('<link rel="stylesheet" href="/gallery/gallery.css">');
    expect(page).toContain('<title>Gallery not available</title>');
  });

  it('says both sentences and has no script', () => {
    expect(page).toContain('<main class="gallery gallery-missing">');
    expect(page).toContain("This gallery isn't available.");
    expect(page).toContain('The link may have been turned off, or it may be wrong.');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+=|style=|<style/i);
  });
});

describe('GALLERY_SCRIPT', () => {
  it('parses as a function body', () => {
    expect(() => new Function(GALLERY_SCRIPT)).not.toThrow();
  });

  it('does nothing without gallery links or dialog support', () => {
    const fake = { querySelectorAll: () => [], createElement: () => { throw new Error('should not build'); } };
    expect(() => new Function('document', GALLERY_SCRIPT)(fake)).not.toThrow();
  });

  it('mentions the pieces the viewer depends on', () => {
    for (const word of ['a.gallery-link', 'data-caption', 'data-model', 'data-prompt', 'showModal', 'ArrowLeft', 'ArrowRight']) {
      expect(GALLERY_SCRIPT).toContain(word);
    }
  });

  it('uses no unsafe calls and no style attribute', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(GALLERY_SCRIPT).not.toContain(bad);
    }
    expect(GALLERY_SCRIPT).not.toMatch(/style/i);
  });

  it('has no backticks or template placeholders', () => {
    expect(GALLERY_SCRIPT).not.toContain('`');
    expect(GALLERY_SCRIPT).not.toContain('${');
  });
});

describe('GALLERY_SCRIPT in a page', () => {
  function open(html = [1, 2, 3].map(n => `<a class="gallery-link" href="/gallery/s/p/${n}.jpg" data-caption="Caption ${n}" data-model="Model ${n}" data-prompt="Prompt ${n}"><img src="/gallery/s/p/${n}.jpg"></a>`).join('')) {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = html;
    const proto = HTMLDialogElement.prototype as unknown as { showModal(): void; close(): void };
    proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
    new Function('document', GALLERY_SCRIPT)(doc);
    const q = <T extends Element>(s: string) => doc.querySelector(s) as T;
    return { doc, q };
  }

  it('builds the dialog once and shows the clicked picture', () => {
    const { doc, q } = open();
    expect(doc.querySelectorAll('dialog.gallery-viewer')).toHaveLength(1);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    doc.querySelectorAll('a.gallery-link')[1].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(q('dialog').hasAttribute('open')).toBe(true);
    expect(q('.viewer-image').getAttribute('src')).toBe('/gallery/s/p/2.jpg');
    expect(q('.viewer-image').getAttribute('alt')).toBe('Prompt 2');
    expect(q('.viewer-caption').textContent).toBe('Caption 2');
    expect(q('.viewer-model').textContent).toBe('Model: Model 2');
    expect(q('.viewer-prompt').textContent).toBe('Prompt 2');
  });

  it('closes when pressed and released on the backdrop, not in the padding or after selecting text', () => {
    const { doc, q } = open();
    const dialog = q<HTMLDialogElement>('dialog');
    dialog.getBoundingClientRect = () => ({ left: 100, right: 500, top: 50, bottom: 350, width: 400, height: 300, x: 100, y: 50, toJSON() {} }) as DOMRect;
    const show = () => doc.querySelectorAll('a.gallery-link')[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const press = (target: Element, x: number, y: number) => target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    const click = (x: number, y: number) => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    show();
    expect(dialog.hasAttribute('open')).toBe(true);
    press(dialog, 200, 100);
    click(200, 100);
    expect(dialog.hasAttribute('open')).toBe(true);
    press(q('.viewer-prompt'), 200, 300);
    click(50, 100);
    expect(dialog.hasAttribute('open')).toBe(true);
    for (const [x, y] of [[50, 100], [600, 100], [200, 10], [200, 400]]) {
      press(dialog, x, y);
      click(x, y);
      expect(dialog.hasAttribute('open')).toBe(false);
      show();
    }
  });

  it('leaves modified clicks to the browser', () => {
    const { doc, q } = open();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    doc.querySelector('a.gallery-link')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(q('dialog').hasAttribute('open')).toBe(false);
  });

  it('steps with the buttons and arrow keys without wrapping', () => {
    const { doc, q } = open();
    doc.querySelector('a.gallery-link')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(q<HTMLButtonElement>('.viewer-prev').disabled).toBe(true);
    expect(q<HTMLButtonElement>('.viewer-next').disabled).toBe(false);
    q<HTMLButtonElement>('.viewer-next').click();
    expect(q('.viewer-caption').textContent).toBe('Caption 2');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(q('.viewer-caption').textContent).toBe('Caption 3');
    expect(q<HTMLButtonElement>('.viewer-next').disabled).toBe(true);
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(q('.viewer-caption').textContent).toBe('Caption 3');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(q('.viewer-caption').textContent).toBe('Caption 2');
    q<HTMLButtonElement>('.viewer-close').click();
    expect(q('dialog').hasAttribute('open')).toBe(false);
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(q('.viewer-caption').textContent).toBe('Caption 2');
  });

  it('does nothing when the page has no gallery links', () => {
    const { doc } = open('<p>none</p>');
    expect(doc.querySelector('dialog')).toBeNull();
  });
});

describe('GALLERY_CSS', () => {
  it('styles the main parts of the markup', () => {
    for (const selector of ['.picture-grid', '.cast-initials', '.picture-tag', '.gallery-card', '.gallery-viewer', '.gallery-viewer::backdrop', '.gallery-missing']) {
      expect(GALLERY_CSS).toContain(selector);
    }
  });

  it('uses system fonts and loads nothing from outside', () => {
    expect(GALLERY_CSS).not.toMatch(/@import|@font-face|url\(/);
  });
});
