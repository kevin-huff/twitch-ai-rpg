// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCharacter } from '@rpg/contracts';
import StreamLinks from './StreamLinks.vue';

const transport = vi.hoisted(() => ({ me: vi.fn(), producers: vi.fn(), streamLinks: vi.fn(), createStreamLink: vi.fn(), streamLink: vi.fn(), revokeStreamLink: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const characters = [{ id: 'pc-1', displayName: 'Aster' }, { id: 'pc-2', displayName: 'Briar' }] as unknown as PublicCharacter[];
const future = '2027-01-01T00:00:00.000Z';
const summary = (over: Record<string, unknown> = {}) => ({ id: 'link-show', sessionId: 'show', subject: 'show', label: 'Main show link', characterId: null, producerGrantId: null, canPresent: true, createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, revokedAt: null, ...over });
const playerLink = (n: number, over: Record<string, unknown> = {}) => summary({ id: `link-pc-${n}`, subject: 'player', label: `Player ${n}`, characterId: `pc-${n}`, canPresent: false, ...over });
const viewer = (role: 'host' | 'producer') => ({ role, sessionId: null, characterId: null, producer: role === 'producer' ? { grantId: 'grant-me', label: 'Sam', expiresAt: future } : null, streamLinkId: null, expiresAt: future });
const producer = { id: 'grant-1', label: 'Robin', createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, revokedAt: null, lastSignedInAt: null, activeSignIns: 0 };

let wrapper: VueWrapper | null = null;
function mountPanel(props: Record<string, unknown> = {}) {
  wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters, ...props }, attachTo: document.body });
  return wrapper;
}
async function openPanel() {
  (wrapper!.get('details').element as HTMLDetailsElement).open = true;
  await wrapper!.get('details').trigger('toggle'); await flushPromises();
}
const tid = (id: string) => wrapper!.find(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-23T12:00:00.000Z').getTime());
  window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}`);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  transport.me.mockResolvedValue(viewer('host'));
  transport.producers.mockResolvedValue({ producers: [producer] });
  transport.streamLinks.mockResolvedValue({ links: [] });
  transport.createStreamLink.mockImplementation(async (_s: string, body: { subject: string; characterId?: string; producerGrantId?: string }) => ({
    link: body.subject === 'player' ? playerLink(Number(body.characterId?.slice(3)), { id: `new-${body.characterId}` }) : body.subject === 'producer' ? summary({ id: 'new-own', subject: 'producer', label: 'Producer Sam', producerGrantId: body.producerGrantId, canPresent: false }) : summary({ id: 'new-show' }),
    token: `token-${body.characterId ?? body.subject}`,
  }));
  transport.streamLink.mockImplementation(async (_s: string, id: string) => ({ link: summary({ id }), token: `token-of-${id}` }));
  transport.revokeStreamLink.mockImplementation(async (_s: string, id: string) => (id.startsWith('link-pc-') ? playerLink(Number(id.slice(-1)), { revokedAt: '2026-10-23T12:00:00.000Z' }) : summary({ id, revokedAt: '2026-10-23T12:00:00.000Z' })));
});
afterEach(() => { wrapper?.unmount(); wrapper = null; window.location.hash = ''; vi.restoreAllMocks(); });

describe('Stream this show (director)', () => {
  it('is a closed fold named Stream this show and asks for nothing until opened', async () => {
    mountPanel(); await flushPromises();
    expect(wrapper!.get('details').attributes('id')).toBe('stage-links');
    expect(tid('stream-setup').exists()).toBe(true);
    expect(wrapper!.get('summary').text()).toBe('Stream this show');
    expect(wrapper!.get('details').attributes('open')).toBeUndefined();
    expect(wrapper!.get('a').text()).toBe('OBS setup guide');
    expect(wrapper!.get('a').attributes('href')).toBe(`/help?identity=${'a'.repeat(32)}#stage-and-obs`);
    for (const fn of Object.values(transport)) expect(fn).not.toHaveBeenCalled();
  });

  it('reveals every active token on first open but makes no cast link and no main show link', async () => {
    transport.streamLinks.mockResolvedValue({ links: [playerLink(1)] });
    mountPanel(); await openPanel();
    expect(transport.me).toHaveBeenCalled();
    expect(transport.producers).toHaveBeenCalled();
    expect(transport.streamLink).toHaveBeenCalledWith('show', 'link-pc-1');
    expect(transport.createStreamLink).not.toHaveBeenCalled();
    expect(tid('stream-row-player-pc-1').text()).toContain('Aster');
    expect(tid('stream-row-player-pc-1').find('[data-testid="copy-overlay"]').attributes('data-url')).toContain('token-of-link-pc-1');
    expect(tid('stream-row-player-pc-2').text()).toContain('Briar');
    expect(tid('stream-row-player-pc-2').find('[data-testid="copy-overlay"]').exists()).toBe(false);
  });

  it('makes exactly one link for one press of a row Make a link', async () => {
    mountPanel(); await openPanel();
    expect(transport.createStreamLink).not.toHaveBeenCalled();
    await tid('stream-row-player-pc-2').get('button').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledTimes(1);
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'player', characterId: 'pc-2' });
    expect(tid('stream-row-player-pc-2').find('[data-testid="copy-overlay"]').exists()).toBe(true);
    expect(tid('stream-row-player-pc-1').find('[data-testid="copy-overlay"]').exists()).toBe(false);
  });

  it('shows the new group wording and the one-OBS note', async () => {
    mountPanel(); await openPanel();
    const text = wrapper!.text();
    expect(text).toContain("Every link shows the same picture. A cast member's link only listens to the show audio.");
    expect(text).toContain('Only one OBS should load the Main show link: it carries the show audio.');
  });

  it('loads only the first time it opens', async () => {
    mountPanel(); await openPanel();
    (wrapper!.get('details').element as HTMLDetailsElement).open = false;
    await wrapper!.get('details').trigger('toggle');
    (wrapper!.get('details').element as HTMLDetailsElement).open = true;
    await wrapper!.get('details').trigger('toggle'); await flushPromises();
    expect(transport.streamLinks).toHaveBeenCalledTimes(1);
  });

  it('shows the group headings and offers the main show link when none is active', async () => {
    mountPanel(); await openPanel();
    const headings = wrapper!.findAll('h4').map(item => item.text());
    expect(headings).toEqual(['For your stream', 'For a cast member who streams too']);
    expect(tid('stream-row-show').exists()).toBe(false);
    await tid('make-show-link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'show' });
    expect(tid('make-show-link').exists()).toBe(false);
    expect(tid('stream-row-show').text()).toContain('Main show link');
  });

  it('shows an existing main show link with its card and a canPresent sound line', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), playerLink(1), playerLink(2)] });
    mountPanel(); await openPanel();
    expect(tid('make-show-link').exists()).toBe(false);
    expect(tid('stream-row-show').text()).toContain('Main show link');
    expect(tid('stream-row-show').text()).toContain('This link carries the show audio.');
    expect(transport.createStreamLink).not.toHaveBeenCalled();
  });

  it('lists only active links, plus host and producer personal links for the host', async () => {
    transport.streamLinks.mockResolvedValue({ links: [
      summary(), playerLink(1), playerLink(2),
      summary({ id: 'old', subject: 'player', characterId: 'pc-1', revokedAt: '2026-10-01T00:00:00.000Z', label: 'Old link' }),
      summary({ id: 'host-link', subject: 'host', label: 'Host', canPresent: false }),
      summary({ id: 'prod-link', subject: 'producer', label: 'Producer', producerGrantId: 'grant-1', canPresent: false }),
    ] });
    mountPanel(); await openPanel();
    expect(wrapper!.text()).not.toContain('Old link');
    expect(tid('stream-row-host').text()).toContain('Host view');
    expect(tid('stream-row-producer-grant-1').text()).toContain('Producer Robin');
    expect(wrapper!.findAll('h4').map(item => item.text())).not.toContain('For your own stream');
    expect(tid('stream-row-own-producer').exists()).toBe(false);
  });

  it('has none of the old controls', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary()] });
    mountPanel(); await openPanel();
    const text = wrapper!.text();
    expect(text).not.toContain('Create a personal link for');
    expect(text).not.toContain('Show link');
    expect(text).not.toContain('Revoke');
    expect(wrapper!.findAll('label').some(label => label.text().startsWith('Layout'))).toBe(false);
    expect(wrapper!.findAll('label').some(label => label.text().startsWith('Audio'))).toBe(false);
  });

  it('gives a producer viewer their own link, created on first open, and no producer list', async () => {
    transport.me.mockResolvedValue(viewer('producer'));
    mountPanel(); await openPanel();
    expect(transport.producers).not.toHaveBeenCalled();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'producer', producerGrantId: 'grant-me' });
    expect(wrapper!.findAll('h4').map(item => item.text())).toContain('For your own stream');
    expect(tid('stream-row-own-producer').text()).toContain('Your own stream link');
    expect(tid('stream-row-own-producer').find('[data-testid="copy-scene"]').attributes('data-url')).toContain('token-producer');
  });

  it('does not make a second own link for a producer who already has one', async () => {
    transport.me.mockResolvedValue(viewer('producer'));
    transport.streamLinks.mockResolvedValue({ links: [summary({ id: 'mine', subject: 'producer', producerGrantId: 'grant-me', label: 'Producer Sam', canPresent: false }), playerLink(1), playerLink(2)] });
    mountPanel(); await openPanel();
    expect(transport.createStreamLink).not.toHaveBeenCalled();
    expect(tid('stream-row-own-producer').exists()).toBe(true);
  });

  it('turns a link off and leaves Turned off with Make a new link, then makes a new one', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), playerLink(1), playerLink(2)] });
    mountPanel(); await openPanel();
    const row = tid('stream-row-player-pc-1');
    await row.get('[data-testid="turn-off"]').trigger('click');
    await row.get('[data-testid="turn-off-confirm"]').trigger('click'); await flushPromises();
    expect(transport.revokeStreamLink).toHaveBeenCalledWith('show', 'link-pc-1');
    expect(tid('stream-row-player-pc-1').text()).toContain('Turned off.');
    expect(transport.createStreamLink).not.toHaveBeenCalled();
    await tid('make-new-link-link-pc-1').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'player', characterId: 'pc-1' });
    expect(tid('stream-row-player-pc-1').text()).not.toContain('Turned off.');
    expect(tid('stream-row-player-pc-1').find('[data-testid="copy-overlay"]').exists()).toBe(true);
  });

  it('turns the main show link off and offers a new one, never recreating it by itself', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), playerLink(1), playerLink(2)] });
    mountPanel(); await openPanel();
    const row = tid('stream-row-show');
    await row.get('[data-testid="turn-off"]').trigger('click');
    await row.get('[data-testid="turn-off-confirm"]').trigger('click'); await flushPromises();
    expect(tid('stream-row-show').text()).toContain('Turned off.');
    expect(transport.createStreamLink).not.toHaveBeenCalled();
    await tid('make-new-link-link-show').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'show' });
  });

  it('says so when a link could not be turned off', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), playerLink(1), playerLink(2)] });
    transport.revokeStreamLink.mockRejectedValue(new Error('no'));
    mountPanel(); await openPanel();
    const row = tid('stream-row-player-pc-1');
    await row.get('[data-testid="turn-off"]').trigger('click');
    await row.get('[data-testid="turn-off-confirm"]').trigger('click'); await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toBe('This link could not be turned off. Try again.');
    expect(tid('stream-row-player-pc-1').text()).not.toContain('Turned off.');
  });

  it('shows a load failure with a way to try again', async () => {
    transport.streamLinks.mockRejectedValue(new Error('down'));
    mountPanel(); await openPanel();
    expect(wrapper!.get('[role="alert"]').text()).toContain('The stream links could not be loaded.');
    transport.streamLinks.mockResolvedValue({ links: [] });
    transport.streamLinks.mockClear();
    await tid('stream-links-retry').trigger('click'); await flushPromises();
    expect(transport.streamLinks).toHaveBeenCalledTimes(1);
    expect(tid('stream-row-player-pc-1').exists()).toBe(true);
  });

  it('offers a retry when a cast link could not be created', async () => {
    transport.createStreamLink.mockRejectedValueOnce(new Error('no'));
    transport.streamLinks.mockResolvedValue({ links: [playerLink(2)] });
    mountPanel(); await openPanel();
    await tid('stream-row-player-pc-1').get('button').trigger('click'); await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toContain('The link could not be created. Try again.');
    await tid('stream-row-player-pc-1').get('button').trigger('click'); await flushPromises();
    expect(tid('stream-row-player-pc-1').find('[data-testid="copy-overlay"]').exists()).toBe(true);
  });

  it('opens and scrolls into view when the page address names #stage-links, on load', async () => {
    window.location.hash = '#stage-links';
    mountPanel(); await flushPromises();
    expect(wrapper!.get('details').attributes('open')).toBeDefined();
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(transport.streamLinks).toHaveBeenCalledTimes(1);
  });

  it('opens when the hash changes to #stage-links later', async () => {
    mountPanel(); await flushPromises();
    expect(wrapper!.get('details').attributes('open')).toBeUndefined();
    window.location.hash = '#stage-links';
    window.dispatchEvent(new HashChangeEvent('hashchange')); await flushPromises();
    expect(wrapper!.get('details').attributes('open')).toBeDefined();
    expect(transport.streamLinks).toHaveBeenCalledTimes(1);
  });
});

describe('Stream this show (reopen by link)', () => {
  it('reopens the closed fold when a #stage-links link is pressed with the hash unchanged', async () => {
    window.location.hash = '#stage-links';
    mountPanel(); await flushPromises();
    const details = wrapper!.get('details').element as HTMLDetailsElement;
    details.open = false;
    vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();
    const link = document.createElement('a');
    link.href = '#stage-links';
    document.body.appendChild(link);
    link.click();
    await new Promise(resolve => setTimeout(resolve, 5)); await flushPromises();
    link.remove();
    expect(details.open).toBe(true);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('Stream this show (player)', () => {
  it('renders only the player\'s own stream panel', async () => {
    mountPanel({ mode: 'player', ownCharacterId: 'pc-1' }); await flushPromises();
    expect(wrapper!.get('details').attributes('id')).toBe('my-stream-view');
    expect(tid('my-stream-view').exists()).toBe(true);
    expect(tid('stream-setup').exists()).toBe(false);
    expect(wrapper!.get('summary').text()).toBe('Stream this show');
    for (const fn of Object.values(transport)) expect(fn).not.toHaveBeenCalled();
  });

  it('does not react to #stage-links', async () => {
    window.location.hash = '#stage-links';
    mountPanel({ mode: 'player', ownCharacterId: 'pc-1' }); await flushPromises();
    expect(transport.streamLinks).not.toHaveBeenCalled();
  });
});
