// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GalleryStatus } from '@rpg/contracts';
import GalleryPanel from './GalleryPanel.vue';

const URL_ = 'http://localhost:3000/gallery/abc/';
function status(over: Partial<GalleryStatus> = {}): GalleryStatus {
  return { state: 'on', listed: false, url: URL_, listUrl: 'http://localhost:3000/gallery/', pictures: 42, pending: 0, writtenAt: '2026-10-25T20:14:00.000Z', message: null, local: false, ...over };
}
const mountPanel = (s: GalleryStatus | null, busy = false) => mount(GalleryPanel, { props: { status: s, busy }, attachTo: document.body });
const t = (id: string) => `[data-testid="gallery-${id}"]`;

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('GalleryPanel', () => {
  it('keeps the link outside a closed More gallery options fold that holds the rest', () => {
    const w = mountPanel(status({ local: true }));
    const fold = w.get(t('more'));
    expect(fold.element.tagName).toBe('DETAILS');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('More gallery options');
    for (const id of ['list', 'list-url', 'rewrite', 'new-link', 'off', 'local']) expect(fold.find(t(id)).exists()).toBe(true);
    for (const id of ['status', 'url', 'copy']) expect(fold.find(t(id)).exists()).toBe(false);
    expect(w.find(t('url')).exists() && w.find(t('copy')).exists() && w.find(t('status')).exists()).toBe(true);
    expect(mountPanel(status({ listed: true })).get(t('more')).find(t('unlist')).exists()).toBe(true);
    expect(mountPanel(status({ state: 'off', url: null })).find(t('more')).exists()).toBe(false);
  });
  it('renders nothing without a status', () => {
    expect(mountPanel(null).find(t('panel').replace('gallery-panel', 'gallery-panel')).exists()).toBe(false);
  });
  it('closed shows only its line', () => {
    const w = mountPanel(status({ state: 'closed', url: null }));
    expect(w.get(t('status')).text()).toBe('The gallery opens once the show has ended.');
    expect(w.findAll('button')).toHaveLength(0);
  });
  it('off offers Turn on gallery and emits on', async () => {
    const w = mountPanel(status({ state: 'off', url: null }));
    expect(w.text()).toContain('Writes a page of every picture from this show that anyone with the link can open.');
    await w.get(t('on')).trigger('click');
    expect(w.emitted('action')).toEqual([['on']]);
  });
  it('on shows the writing line, then the written line', () => {
    expect(mountPanel(status({ writtenAt: null })).get(t('status')).text()).toBe('Writing the gallery…');
    expect(mountPanel(status()).get(t('status')).text()).toMatch(/^Gallery on · 42 pictures · written \d{1,2}:\d{2} (am|pm)$/);
    expect(mountPanel(status({ pictures: 1 })).get(t('status')).text()).toContain('1 picture ·');
  });
  it('says not written yet when there is a message but no write time', () => {
    expect(mountPanel(status({ writtenAt: null, message: 'x' })).get(t('status')).text()).toBe('Gallery on · not written yet');
  });
  it('always offers the rewrite button while on', async () => {
    const w = mountPanel(status());
    expect(w.find(t('message')).exists()).toBe(false);
    await w.get(t('rewrite')).trigger('click');
    expect(w.emitted('action')).toEqual([['rewrite']]);
    expect(mountPanel(status(), true).get(t('rewrite')).attributes('disabled')).toBeDefined();
    expect(mountPanel(status({ state: 'off', url: null })).find(t('rewrite')).exists()).toBe(false);
    expect(mountPanel(status({ state: 'closed', url: null })).find(t('rewrite')).exists()).toBe(false);
  });
  it('shows the message above the rewrite button', () => {
    const html = mountPanel(status({ message: 'oops' })).html();
    expect(html.indexOf('gallery-message')).toBeGreaterThan(-1);
    expect(html.indexOf('gallery-message')).toBeLessThan(html.indexOf('gallery-rewrite'));
  });
  it('shows both pending sentences', () => {
    expect(mountPanel(status({ pending: 1 })).get(t('pending')).text()).toBe("1 picture is still being made. It'll be added when it finishes.");
    expect(mountPanel(status({ pending: 3 })).get(t('pending')).text()).toBe("3 pictures are still being made. They'll be added when they finish.");
    expect(mountPanel(status()).find(t('pending')).exists()).toBe(false);
  });
  it('shows the message and rewrites', async () => {
    const w = mountPanel(status({ message: 'The gallery could not be written: disk full' }));
    expect(w.get(t('message')).text()).toContain('disk full');
    await w.get(t('rewrite')).trigger('click');
    expect(w.emitted('action')).toEqual([['rewrite']]);
  });
  it('shows the link and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const w = mountPanel(status());
    const box = w.get(t('url')).element as HTMLInputElement;
    expect(box.value).toBe(URL_);
    expect(box.readOnly).toBe(true);
    await w.get(t('copy')).trigger('click');
    expect(writeText).toHaveBeenCalledWith(URL_);
  });
  it('selects the box when copying fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } });
    const w = mountPanel(status());
    await w.get(t('copy')).trigger('click');
    await new Promise(r => setTimeout(r, 0));
    const box = w.get(t('url')).element as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    expect(box.selectionEnd! - box.selectionStart!).toBe(URL_.length);
  });
  it('selects the box when the clipboard is missing', async () => {
    vi.stubGlobal('navigator', {});
    const w = mountPanel(status());
    await w.get(t('copy')).trigger('click');
    await new Promise(r => setTimeout(r, 0));
    expect(document.activeElement).toBe(w.get(t('url')).element);
  });
  it('lists and unlists', async () => {
    const w = mountPanel(status());
    await w.get(t('list')).trigger('click');
    expect(w.emitted('action')).toEqual([['list']]);
    const l = mountPanel(status({ listed: true }));
    expect(l.get(t('listed')).text()).toBe('On the public list');
    await l.get(t('unlist')).trigger('click');
    expect(l.emitted('action')).toEqual([['unlist']]);
    expect(l.get(t('list-url')).text()).toContain('Public list: ');
    expect(l.get(`${t('list-url')} a`).attributes('href')).toBe('http://localhost:3000/gallery/');
  });
  it.each([['new-link', 'new_link', 'Yes, make a new link'], ['off', 'off', 'Yes, turn it off']])('confirms %s before emitting', async (id, action, yes) => {
    const w = mountPanel(status());
    await w.get(t(id)).trigger('click');
    expect(w.emitted('action')).toBeUndefined();
    expect(w.get(t('confirm')).text()).toContain('This stops the link you may have posted in chat.');
    expect(w.find(t('new-link')).exists()).toBe(false);
    expect(w.find(t('off')).exists()).toBe(false);
    expect(w.get(t('confirm-yes')).text()).toBe(yes);
    await w.get(t('confirm-yes')).trigger('click');
    expect(w.emitted('action')).toEqual([[action]]);
    expect(w.find(t('confirm')).exists()).toBe(false);
  });
  it('Keep it cancels', async () => {
    const w = mountPanel(status());
    await w.get(t('off')).trigger('click');
    await w.get(t('keep')).trigger('click');
    expect(w.emitted('action')).toBeUndefined();
    expect(w.find(t('confirm')).exists()).toBe(false);
    expect(w.find(t('off')).exists()).toBe(true);
  });
  it('shows the local note only when local', () => {
    expect(mountPanel(status({ local: true })).get(t('local')).text()).toBe('These links only work on this computer until the app is deployed.');
    expect(mountPanel(status()).find(t('local')).exists()).toBe(false);
  });
  it('busy disables the action buttons', async () => {
    const w = mountPanel(status({ message: 'x' }), true);
    for (const id of ['rewrite', 'list', 'new-link', 'off']) expect(w.get(t(id)).attributes('disabled')).toBeDefined();
    expect(mountPanel(status({ state: 'off', url: null }), true).get(t('on')).attributes('disabled')).toBeDefined();
    const c = mountPanel(status({ listed: true }), true);
    expect(c.get(t('unlist')).attributes('disabled')).toBeDefined();
  });
});
