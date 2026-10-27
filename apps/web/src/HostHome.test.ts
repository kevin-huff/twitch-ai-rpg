// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(), me: vi.fn(), create: vi.fn(), invitePreview: vi.fn(), redeem: vi.fn(), navigate: vi.fn(),
  table: { inviteToken: '' },
}));
const sessions = mocks.sessions;
vi.mock('./api', () => ({
  api: { sessions: mocks.sessions, me: mocks.me, create: mocks.create, invitePreview: mocks.invitePreview, redeem: mocks.redeem },
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock('./navigate', () => ({ navigate: mocks.navigate }));
vi.mock('./table', () => ({ useTable: () => ({ inviteToken: mocks.table.inviteToken, error: ref(''), busy: ref(false), work: (fn: () => unknown) => fn() }) }));

import { ApiError } from './api';
import HostHome from './HostHome.vue';

const entries = [
  { id: 'a', title: 'Listed show', status: 'ended', gallery: { listed: true, url: 'https://x.test/gallery/aaa/' } },
  { id: 'b', title: 'Private show', status: 'ended', gallery: { listed: false, url: 'https://x.test/gallery/bbb/' } },
  { id: 'c', title: 'No gallery', status: 'ended', gallery: null },
  { id: 'd', title: 'Live show', status: 'live', gallery: { listed: false, url: 'https://x.test/gallery/ddd/' } },
];

async function load() {
  mocks.me.mockResolvedValue({ role: 'host' });
  sessions.mockResolvedValue(entries);
  const wrapper = mount(HostHome, { global: { stubs: { FieldGenerator: true, ProducerAccess: true, ErrorNotice: true } }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('HostHome gallery tags', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  beforeEach(() => { sessions.mockReset(); mocks.table.inviteToken = ''; });
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
    document.body.innerHTML = '';
  });

  it('shows the listed and private tag texts, only for ended shows with a gallery', async () => {
    const wrapper = await load();
    const labels = wrapper.findAll('[data-testid="session-gallery-label"]').map(l => l.text());
    expect(labels).toEqual(['Gallery: on the public list', 'Gallery: link only']);
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

describe('HostHome invitation page', () => {
  beforeEach(() => { Object.values(mocks).forEach(item => { if (typeof item === 'function') item.mockReset(); }); mocks.table.inviteToken = 'tok-1'; });
  afterEach(() => { mocks.table.inviteToken = ''; document.body.innerHTML = ''; });
  const mountPage = async () => { const wrapper = mount(HostHome, { global: { stubs: { ProducerAccess: true, ErrorNotice: { props: ['message'], template: '<p data-testid="notice">{{ message }}</p>' } } }, attachTo: document.body }); await flushPromises(); return wrapper; };

  it('names the show and offers Join, then redeems and goes to the seat', async () => {
    mocks.invitePreview.mockResolvedValue({ title: 'The Ledger Job', role: 'player' });
    mocks.redeem.mockResolvedValue({ sessionId: 's1', role: 'player', identityId: 'i' });
    const wrapper = await mountPage();
    expect(mocks.invitePreview).toHaveBeenCalledWith('tok-1');
    expect(wrapper.text()).toContain("You've been invited to play The Ledger Job.");
    expect(wrapper.text()).toContain('Press Join to take your seat.');
    expect(wrapper.get('[data-testid="join"]').text()).toBe('Join');
    await wrapper.get('[data-testid="join"]').trigger('click');
    await flushPromises();
    expect(mocks.redeem).toHaveBeenCalledWith('tok-1');
    expect(mocks.navigate).toHaveBeenCalledWith('/sessions/s1/play', { replace: true });
  });

  it('words a stage invitation for the stage', async () => {
    mocks.invitePreview.mockResolvedValue({ title: 'The Ledger Job', role: 'stage' });
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("You've been invited to open the stage for The Ledger Job.");
    expect(wrapper.text()).toContain('Press Join to open the stage.');
    expect(wrapper.text()).not.toContain('take your seat');
  });

  it('sends a stage invitation to the stage', async () => {
    mocks.invitePreview.mockResolvedValue({ title: 'The Ledger Job', role: 'stage' });
    mocks.redeem.mockResolvedValue({ sessionId: 's1', role: 'stage', identityId: 'i' });
    const wrapper = await mountPage();
    await wrapper.get('[data-testid="join"]').trigger('click');
    await flushPromises();
    expect(mocks.navigate).toHaveBeenCalledWith('/sessions/s1/stage', { replace: true });
  });

  it('shows only the pinned sentence and no Join on a 401', async () => {
    mocks.invitePreview.mockRejectedValue(new ApiError('This invitation is expired, already redeemed, or invalid.', 401));
    const wrapper = await mountPage();
    expect(wrapper.get('[data-testid="invite-error"]').text()).toBe('This invitation has already been used or has expired. Ask your host for a new link.');
    expect(wrapper.find('[data-testid="join"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false);
  });

  it('shows the message and keeps Join on other errors', async () => {
    mocks.invitePreview.mockRejectedValue(new ApiError('Server is busy.', 500));
    const wrapper = await mountPage();
    expect(wrapper.get('[data-testid="notice"]').text()).toBe('Server is busy.');
    expect(wrapper.find('[data-testid="join"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="invite-error"]').exists()).toBe(false);
  });
});

describe('HostHome signed in', () => {
  beforeEach(() => { Object.values(mocks).forEach(item => { if (typeof item === 'function') item.mockReset(); }); mocks.table.inviteToken = ''; mocks.sessions.mockResolvedValue([{ id: 'a', title: 'Old show', status: 'live', gallery: null }]); });
  afterEach(() => { document.body.innerHTML = ''; });
  const mountPage = async (role: 'host' | 'producer') => { mocks.me.mockResolvedValue({ role }); const wrapper = mount(HostHome, { global: { stubs: { ProducerAccess: true, ErrorNotice: true } }, attachTo: document.body }); await flushPromises(); return wrapper; };

  it('starts The Ledger Job and goes straight to its director page', async () => {
    mocks.create.mockResolvedValue({ sessionId: 'new1', invites: [] });
    const wrapper = await mountPage('host');
    expect(wrapper.find('input[maxlength="160"]').exists()).toBe(false);
    await wrapper.get('[data-testid="try-it-now"]').trigger('click');
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith('The Ledger Job');
    expect(mocks.navigate).toHaveBeenCalledWith('/sessions/new1/director');
  });

  it('shows Make a show, the library link and Your shows with no practice-show poster', async () => {
    const wrapper = await mountPage('host');
    expect(wrapper.get('[data-testid="make-a-show"]').attributes('href')).toContain('/make');
    expect(wrapper.get('[data-testid="library-link"]').text()).toBe('Library & custom shows');
    expect(wrapper.find('h3').text()).toBe('Your shows');
    expect(wrapper.text()).not.toContain('A good story');
  });

  it('gives the host rows a plain title and an Open the director page link, keeping the gallery tag', async () => {
    mocks.sessions.mockResolvedValue([{ id: 'a', title: 'Old show', status: 'ended', gallery: { listed: false, url: 'https://x.test/g/' } }]);
    const wrapper = await mountPage('host');
    const row = wrapper.get('[data-testid="open-director-a"]');
    expect(row.text()).toBe('Open the director page');
    expect(row.attributes('href')).toContain('/sessions/a/director');
    expect(row.element.parentElement!.textContent).toContain('Old show');
    expect(wrapper.find('[data-testid="session-gallery-tag"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="shows-you-can-run"]').exists()).toBe(false);
  });

  it('leads a producer home with Shows you can run, one row per show', async () => {
    const wrapper = await mountPage('producer');
    const section = wrapper.get('[data-testid="shows-you-can-run"]');
    expect(section.get('h3').text()).toBe('Shows you can run');
    expect(section.get('[data-testid="open-director-a"]').text()).toBe('Open the director page');
    expect(wrapper.findAll('h3').map(h => h.text())).toEqual(['Shows you can run']);
    expect(wrapper.html().indexOf('shows-you-can-run')).toBeLessThan(wrapper.html().indexOf('try-it-now'));
  });

  it('tells a producer there are no shows yet', async () => {
    mocks.sessions.mockResolvedValue([]);
    const wrapper = await mountPage('producer');
    expect(wrapper.get('[data-testid="shows-you-can-run"]').text()).toContain('No shows yet.');
  });

  it('shows More with producer access for the host only', async () => {
    const host = await mountPage('host');
    const more = host.get('[data-testid="home-more"]');
    expect(more.element.tagName).toBe('DETAILS');
    expect(more.get('summary').text()).toBe('More');
    expect((more.element as HTMLDetailsElement).open).toBe(false);
    expect(more.findComponent({ name: 'ProducerAccess' }).exists()).toBe(true);
    host.unmount();
    const producer = await mountPage('producer');
    expect(producer.find('[data-testid="home-more"]').exists()).toBe(false);
  });
});

describe('HostHome signed out', () => {
  beforeEach(() => { Object.values(mocks).forEach(item => { if (typeof item === 'function') item.mockReset(); }); mocks.table.inviteToken = ''; mocks.sessions.mockRejectedValue(new Error('no')); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('shows the neutral line above the sign-in form', async () => {
    const wrapper = mount(HostHome, { global: { stubs: { ProducerAccess: true, ErrorNotice: true } }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain('The Story Table runs live roleplay shows: your cast sends lines from their seats, the AI voices everyone else, and you review every beat before the audience sees it.');
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  });
});
