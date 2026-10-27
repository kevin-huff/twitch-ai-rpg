// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamLinkSummary } from '@rpg/contracts';

vi.mock('./api', () => ({
  api: { streamLinks: vi.fn(), streamLink: vi.fn(), createStreamLink: vi.fn(), revokeStreamLink: vi.fn() },
}));
import { api } from './api';
import MyStreamLink from './MyStreamLink.vue';

const mocked = vi.mocked(api, true);
const summary = (overrides: Partial<StreamLinkSummary> = {}): StreamLinkSummary => ({
  id: 'l1', sessionId: 's1', subject: 'player', label: 'Mara', characterId: 'c1', producerGrantId: null, canPresent: false,
  createdAt: '2026-10-26T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, ...overrides,
});
let wrapper: VueWrapper | null = null;
let writeText: ReturnType<typeof vi.fn>;

function mountPanel() {
  wrapper = mount(MyStreamLink, { props: { sessionId: 's1', ownCharacterId: 'c1' }, attachTo: document.body });
  return wrapper;
}
async function openPanel() {
  const el = wrapper!.get('details').element as HTMLDetailsElement;
  el.open = true;
  await wrapper!.get('details').trigger('toggle');
  await flushPromises();
}
const tid = (id: string) => wrapper!.get(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.resetAllMocks();
  window.location.hash = '';
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('MyStreamLink', () => {
  it('is closed by default and makes no requests', () => {
    mountPanel();
    expect((tid('my-stream-view').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper!.get('summary').text()).toBe('Stream this show');
    expect(mocked.streamLinks).not.toHaveBeenCalled();
    expect(mocked.createStreamLink).not.toHaveBeenCalled();
  });

  it('creates the link on first open when there is none', async () => {
    mocked.streamLinks.mockResolvedValue({ links: [summary({ id: 'x', characterId: 'other' }), summary({ id: 'old', revokedAt: '2026-10-25T00:00:00.000Z' })] });
    mocked.createStreamLink.mockResolvedValue({ link: summary({ id: 'new' }), token: 'tok-new' } as never);
    mountPanel();
    await openPanel();
    expect(mocked.createStreamLink).toHaveBeenCalledWith('s1', { subject: 'player', characterId: 'c1' });
    expect(mocked.streamLink).not.toHaveBeenCalled();
    expect(tid('stream-row-own').text()).toContain('Your own stream link');
  });

  it('reveals the existing link and copies in one press with listen sound', async () => {
    mocked.streamLinks.mockResolvedValue({ links: [summary()] });
    mocked.streamLink.mockResolvedValue({ link: summary(), token: 'tok1' } as never);
    mountPanel();
    await openPanel();
    expect(mocked.createStreamLink).not.toHaveBeenCalled();
    expect(mocked.streamLink).toHaveBeenCalledWith('s1', 'l1');
    await tid('copy-overlay').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('audio=listen');
    expect(writeText.mock.calls[0][0]).toContain('tok1');
  });

  it('turns off, then makes a new link', async () => {
    mocked.streamLinks.mockResolvedValue({ links: [summary()] });
    mocked.streamLink.mockResolvedValue({ link: summary(), token: 'tok1' } as never);
    mocked.revokeStreamLink.mockResolvedValue(summary({ revokedAt: '2026-10-26T11:00:00.000Z' }));
    mocked.createStreamLink.mockResolvedValue({ link: summary({ id: 'l2' }), token: 'tok2' } as never);
    mountPanel();
    await openPanel();
    await tid('turn-off').trigger('click');
    await tid('turn-off-confirm').trigger('click');
    await flushPromises();
    expect(mocked.revokeStreamLink).toHaveBeenCalledWith('s1', 'l1');
    expect(wrapper!.text()).toContain('Turned off.');
    await tid('make-new-link').trigger('click');
    await flushPromises();
    expect(mocked.createStreamLink).toHaveBeenCalledWith('s1', { subject: 'player', characterId: 'c1' });
    expect(wrapper!.find('[data-testid="stream-row-own"]').exists()).toBe(true);
  });

  it('shows a failure with Try again', async () => {
    mocked.streamLinks.mockRejectedValueOnce(new Error('x'));
    mountPanel();
    await openPanel();
    expect(wrapper!.text()).toContain('Your stream link could not be loaded. Try again in a moment.');
    mocked.streamLinks.mockResolvedValue({ links: [summary()] });
    mocked.streamLink.mockResolvedValue({ link: summary(), token: 'tok1' } as never);
    const retry = wrapper!.findAll('button').find(b => b.text() === 'Try again')!;
    await retry.trigger('click');
    await flushPromises();
    expect(wrapper!.find('[data-testid="stream-row-own"]').exists()).toBe(true);
  });

  it('opens and scrolls into view when the hash names it', async () => {
    mocked.streamLinks.mockResolvedValue({ links: [summary()] });
    mocked.streamLink.mockResolvedValue({ link: summary(), token: 'tok1' } as never);
    window.location.hash = '#my-stream-view';
    mountPanel();
    await flushPromises();
    expect((tid('my-stream-view').element as HTMLDetailsElement).open).toBe(true);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(mocked.streamLinks).toHaveBeenCalledTimes(1);
  });

  it('links to the OBS setup guide', () => {
    mountPanel();
    expect(wrapper!.get('a').attributes('href')).toContain('/help#streaming-your-own-obs');
  });
});
