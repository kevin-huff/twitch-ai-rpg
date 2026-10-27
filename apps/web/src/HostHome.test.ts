// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const sessions = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: { sessions, me: vi.fn().mockResolvedValue({ role: 'producer' }) } }));
vi.mock('./table', () => ({ useTable: () => ({ inviteToken: '', error: ref(''), busy: ref(false), work: (fn: () => unknown) => fn() }) }));

import HostHome from './HostHome.vue';

const entries = [
  { id: 'a', title: 'Listed show', status: 'ended', gallery: { listed: true, url: 'https://x.test/gallery/aaa/' } },
  { id: 'b', title: 'Private show', status: 'ended', gallery: { listed: false, url: 'https://x.test/gallery/bbb/' } },
  { id: 'c', title: 'No gallery', status: 'ended', gallery: null },
  { id: 'd', title: 'Live show', status: 'live', gallery: { listed: false, url: 'https://x.test/gallery/ddd/' } },
];

async function load() {
  sessions.mockResolvedValue(entries);
  const wrapper = mount(HostHome, { global: { stubs: { FieldGenerator: true, ProducerAccess: true, ErrorNotice: true } }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('HostHome gallery tags', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  beforeEach(() => sessions.mockReset());
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
    document.body.innerHTML = '';
  });

  it('shows the listed and private tag texts, only for ended shows with a gallery', async () => {
    const wrapper = await load();
    const labels = wrapper.findAll('[data-testid="session-gallery-label"]').map(l => l.text());
    expect(labels).toEqual(['Gallery: on the public list', 'Gallery: private link']);
    expect(wrapper.findAll('[data-testid="session-gallery-tag"]')).toHaveLength(2);
  });

  it('copies the link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = await load();
    await wrapper.findAll('[data-testid="session-gallery-copy"]')[0]!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('https://x.test/gallery/aaa/');
    expect(wrapper.find('[data-testid="session-gallery-url"]').exists()).toBe(false);
  });

  it('falls back to a selected read-only box when the clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('no')) }, configurable: true });
    const wrapper = await load();
    await wrapper.findAll('[data-testid="session-gallery-copy"]')[1]!.trigger('click');
    await flushPromises();
    const box = wrapper.get('[data-testid="session-gallery-url"]').element as HTMLInputElement;
    expect(box.value).toBe('https://x.test/gallery/bbb/');
    expect(box.readOnly).toBe(true);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
  });

  it('falls back when the clipboard API is missing', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    const wrapper = await load();
    await wrapper.findAll('[data-testid="session-gallery-copy"]')[0]!.trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-testid="session-gallery-url"]').element as HTMLInputElement).value).toBe('https://x.test/gallery/aaa/');
  });
});
