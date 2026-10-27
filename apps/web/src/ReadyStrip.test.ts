// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReadyStrip from './ReadyStrip.vue';

const transport = vi.hoisted(() => ({ invites: vi.fn(), inviteLink: vi.fn(), streamLinks: vi.fn(), streamLink: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const future = '2099-01-01T00:00:00.000Z';
const seats = [
  { id: 'pc-1', displayName: 'Rook', hasCard: true },
  { id: 'pc-2', displayName: 'Briar', hasCard: false },
  { id: 'pc-3', displayName: 'Wren', hasCard: true },
];
const invite = (id: string, characterId: string | null, over: Record<string, unknown> = {}) => ({ id, role: 'player', characterId, status: 'waiting', createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, redeemedAt: null, revokedAt: null, replacedBy: null, signedIn: false, ...over });
const link = (id: string, over: Record<string, unknown> = {}) => ({ id, sessionId: 'show', subject: 'show', label: 'Main show link', characterId: null, producerGrantId: null, canPresent: true, createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, revokedAt: null, ...over });
const mountIt = (props: Record<string, unknown> = {}) => mount(ReadyStrip, { props: { sessionId: 'show', seats, showStart: true, busy: false, linksKey: 1, ...props }, attachTo: document.body });
const stubClipboard = (write: (text: string) => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });

beforeEach(() => {
  vi.resetAllMocks();
  transport.invites.mockResolvedValue({ invites: [
    invite('inv-3', 'pc-3'),
    invite('inv-2', 'pc-2'),
    invite('inv-1', 'pc-1'),
    invite('inv-s', null, { role: 'stage' }),
  ] });
  transport.inviteLink.mockImplementation(async (_: string, id: string) => ({ invite: invite(id, null), token: `tok-${id}` }));
  transport.streamLinks.mockResolvedValue({ links: [link('old', { createdAt: '2026-10-20T12:00:00.000Z' }), link('new', { createdAt: '2026-10-22T12:00:00.000Z', canPresent: false }), link('gone', { createdAt: '2026-10-23T12:00:00.000Z', revokedAt: '2026-10-23T13:00:00.000Z' }), link('mine', { subject: 'host', createdAt: '2026-10-24T12:00:00.000Z' })] });
  transport.streamLink.mockResolvedValue({ link: link('new'), token: 'show/token' });
});

describe('ReadyStrip', () => {
  it('shows the seat count and enables Start show only when every seat has a card', async () => {
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.get('h3').text()).toBe('Ready to start');
    expect(wrapper.get('[data-testid="seats-with-card"]').text()).toBe('Seats with a card: 2 of 3');
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ seats: seats.map(seat => ({ ...seat, hasCard: true })) });
    expect(wrapper.get('[data-testid="seats-with-card"]').text()).toBe('Seats with a card: 3 of 3');
    const start = wrapper.get('[data-testid="start-session"]');
    expect(start.text()).toBe('Start show');
    expect(start.attributes('disabled')).toBeUndefined();
    await start.trigger('click');
    expect(wrapper.emitted('start')).toHaveLength(1);
    await wrapper.setProps({ busy: true });
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined();
  });

  it('hides the count and Start show when the show has started or is practice', async () => {
    const wrapper = mountIt({ showStart: false }); await flushPromises();
    expect(wrapper.get('h3').text()).toBe('Invitations and show link');
    expect(wrapper.find('[data-testid="seats-with-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="start-session"]').exists()).toBe(false);
  });

  it('copies one line per waiting player invitation in seat order, skipping the stage invitation', async () => {
    const written: string[] = [];
    stubClipboard(async text => { written.push(text); });
    const wrapper = mountIt(); await flushPromises();
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    const origin = window.location.origin;
    expect(written).toEqual([`Rook: ${origin}/join/tok-inv-1\nBriar: ${origin}/join/tok-inv-2\nWren: ${origin}/join/tok-inv-3`]);
    expect(transport.inviteLink).toHaveBeenCalledTimes(3);
    expect(wrapper.text()).toContain('Copied');
    expect(wrapper.find('[data-testid="invitations-text"]').exists()).toBe(false);
  });

  it('leaves out invitations that are not waiting and says so when none are', async () => {
    const written: string[] = [];
    stubClipboard(async text => { written.push(text); });
    transport.invites.mockResolvedValue({ invites: [invite('inv-1', 'pc-1', { status: 'joined' }), invite('inv-3', 'pc-3')] });
    const wrapper = mountIt(); await flushPromises();
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    expect(written[0]).toBe(`Wren: ${window.location.origin}/join/tok-inv-3`);
    transport.invites.mockResolvedValue({ invites: [] });
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('No invitations are waiting.');
    expect(wrapper.text()).not.toContain('Copied');
  });

  it('falls back to a selected read-only box when the clipboard fails', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    document.execCommand = vi.fn(() => false);
    const wrapper = mountIt(); await flushPromises();
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    const box = wrapper.get('[data-testid="invitations-text"]');
    expect(box.attributes('readonly')).toBeDefined();
    expect((box.element as HTMLTextAreaElement).value).toContain(`Rook: ${window.location.origin}/join/tok-inv-1`);
    expect(wrapper.text()).toContain('Copy failed');
    expect(wrapper.text()).not.toContain('Copied');
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('Copied');
  });

  it('shows the newest active show link in a compact card with the two copy buttons', async () => {
    const written: string[] = [];
    stubClipboard(async text => { written.push(text); });
    const wrapper = mountIt(); await flushPromises();
    expect(transport.streamLink).toHaveBeenCalledWith('show', 'new');
    const card = wrapper.get('[data-testid="ready-show-link"]');
    expect(card.text()).toContain('Main show link');
    expect(card.find('[data-testid="turn-off"]').exists()).toBe(false);
    expect(card.find('[data-testid="preview-overlay"]').exists()).toBe(false);
    const origin = window.location.origin;
    expect(card.get('[data-testid="copy-scene"]').attributes('data-url')).toBe(`${origin}/stream?layout=scene&audio=listen#token=show%2Ftoken`);
    expect(card.get('[data-testid="copy-overlay"]').attributes('data-url')).toBe(`${origin}/stream?layout=overlay&audio=listen#token=show%2Ftoken`);
    await card.get('[data-testid="copy-scene"]').trigger('click'); await flushPromises();
    expect(written).toEqual([`${origin}/stream?layout=scene&audio=listen#token=show%2Ftoken`]);
    expect(wrapper.text()).toContain('Copied');
    expect(wrapper.text()).not.toContain('No main show link yet');
    expect(wrapper.text()).not.toContain('Copy show link');
  });

  it('uses present audio for a link that can present', async () => {
    transport.streamLinks.mockResolvedValue({ links: [link('new')] });
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.get('[data-testid="copy-scene"]').attributes('data-url')).toContain('audio=present');
  });

  it('points to Stream this show when a successful load found no main show link', async () => {
    transport.streamLinks.mockResolvedValue({ links: [] });
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.find('[data-testid="ready-show-link"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="show-link-none"]').text()).toBe('No main show link yet. Make one under Stream this show.');
    expect(wrapper.find('[data-testid="show-link-error"]').exists()).toBe(false);
    expect(transport.streamLink).not.toHaveBeenCalled();
  });

  it('shows the failure, not the none message, when the first load fails, and Try again reloads', async () => {
    transport.streamLinks.mockRejectedValueOnce(new Error('down'));
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.get('[data-testid="show-link-error"]').text()).toContain('The main show link could not be loaded.');
    expect(wrapper.find('[data-testid="show-link-none"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('No main show link yet');
    await wrapper.get('[data-testid="show-link-retry"]').trigger('click'); await flushPromises();
    expect(transport.streamLinks).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="show-link-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ready-show-link"]').exists()).toBe(true);
  });

  it('shows the failure when the link token cannot be read', async () => {
    transport.streamLink.mockRejectedValueOnce(new Error('down'));
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.find('[data-testid="show-link-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="show-link-none"]').exists()).toBe(false);
  });

  it('reloads the show link when linksKey changes, and drops it when it is turned off', async () => {
    transport.streamLinks.mockResolvedValue({ links: [] });
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.find('[data-testid="ready-show-link"]').exists()).toBe(false);
    transport.streamLinks.mockResolvedValue({ links: [link('new')] });
    await wrapper.setProps({ linksKey: 2 }); await flushPromises();
    expect(wrapper.find('[data-testid="ready-show-link"]').exists()).toBe(true);
    transport.streamLinks.mockResolvedValue({ links: [link('new', { revokedAt: '2026-10-23T13:00:00.000Z' })] });
    await wrapper.setProps({ linksKey: 3 }); await flushPromises();
    expect(wrapper.find('[data-testid="ready-show-link"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No main show link yet');
  });

  it('names invitation lines by the seat display name, not list position', async () => {
    const written: string[] = [];
    stubClipboard(async text => { written.push(text); });
    transport.invites.mockResolvedValue({ invites: [invite('inv-a', 'pc-a'), invite('inv-b', 'pc-b')] });
    const wrapper = mountIt({ seats: [{ id: 'pc-a', displayName: 'Seat 3', hasCard: false }, { id: 'pc-b', displayName: 'Rook', hasCard: true }] }); await flushPromises();
    await wrapper.get('[data-testid="copy-all-invitations"]').trigger('click'); await flushPromises();
    const origin = window.location.origin;
    expect(written).toEqual([`Seat 3: ${origin}/join/tok-inv-a\nRook: ${origin}/join/tok-inv-b`]);
  });

  it('never says links are shown only once', async () => {
    const wrapper = mountIt(); await flushPromises();
    expect(wrapper.text().toLowerCase()).not.toMatch(/only once|shown once|one time/);
  });
});
