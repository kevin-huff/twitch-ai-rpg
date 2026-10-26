// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCharacter } from '@rpg/contracts';
import StreamLinks from './StreamLinks.vue';

const transport = vi.hoisted(() => ({ me: vi.fn(), producers: vi.fn(), streamLinks: vi.fn(), createStreamLink: vi.fn(), streamLink: vi.fn(), revokeStreamLink: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const characters = [{ id: 'pc-1', displayName: 'Aster' }, { id: 'pc-2', displayName: 'Briar' }] as unknown as PublicCharacter[];
const future = '2027-01-01T00:00:00.000Z';
const summary = (over: Record<string, unknown> = {}) => ({ id: 'link-show', sessionId: 'show', subject: 'show', label: 'Main show link', characterId: null, producerGrantId: null, canPresent: true, createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, revokedAt: null, ...over });
const viewer = (role: 'host' | 'producer') => ({ role, sessionId: null, characterId: null, producer: role === 'producer' ? { grantId: 'grant-me', label: 'Sam', expiresAt: future } : null, streamLinkId: null, expiresAt: future });
const producer = { id: 'grant-1', label: 'Robin', createdAt: '2026-10-22T12:00:00.000Z', expiresAt: future, revokedAt: null, lastSignedInAt: null, activeSignIns: 0 };

async function openPanel(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('button[aria-expanded]').trigger('click'); await flushPromises();
}
const button = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-23T12:00:00.000Z').getTime());
  window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}`);
  transport.me.mockResolvedValue(viewer('host'));
  transport.producers.mockResolvedValue({ producers: [producer] });
  transport.streamLinks.mockResolvedValue({ links: [] });
  transport.createStreamLink.mockResolvedValue({ link: summary(), token: 'tok/en+1' });
  transport.streamLink.mockResolvedValue({ link: summary(), token: 'existing-token' });
  transport.revokeStreamLink.mockResolvedValue(summary({ revokedAt: '2026-10-23T12:00:00.000Z' }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Stage & OBS links panel', () => {
  it('is closed by default with no controls and no requests', async () => {
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await flushPromises();
    expect(wrapper.attributes('id')).toBe('stage-links');
    expect(wrapper.get('h3').text()).toBe('Stage & OBS links');
    expect(wrapper.get('button[aria-expanded]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('a').text()).toBe('OBS setup guide');
    expect(wrapper.get('a').attributes('href')).toBe(`/help?identity=${'a'.repeat(32)}#stage-and-obs`);
    expect(wrapper.findAll('input, select, textarea')).toHaveLength(0);
    for (const fn of Object.values(transport)) expect(fn).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('loads links when opened and creates the main show link', async () => {
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    expect(transport.streamLinks).toHaveBeenCalledWith('show');
    await button(wrapper, 'Create main show link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'show' });
    expect(button(wrapper, 'Create main show link')).toBeUndefined();
    wrapper.unmount();
  });

  it('lists only active links and offers producers to the host', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), summary({ id: 'old', revokedAt: '2026-10-01T00:00:00.000Z', label: 'Old link' }), summary({ id: 'late', expiresAt: '2026-10-01T00:00:00.000Z', label: 'Late link' })] });
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    expect(wrapper.text()).toContain('Main show link');
    expect(wrapper.text()).not.toContain('Old link');
    expect(wrapper.text()).not.toContain('Late link');
    const options = wrapper.findAll('select')[0]!.findAll('option').map(option => option.text());
    expect(options).toEqual(['You', 'Producer Robin', 'Aster', 'Briar']);
    wrapper.unmount();
  });

  it('offers Host to a producer and uses the producer grant for You', async () => {
    transport.me.mockResolvedValue(viewer('producer'));
    transport.createStreamLink.mockResolvedValue({ link: summary({ id: 'link-p', subject: 'producer', producerGrantId: 'grant-me', canPresent: false, label: 'Sam' }), token: 'p-token' });
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    expect(transport.producers).not.toHaveBeenCalled();
    expect(wrapper.findAll('select')[0]!.findAll('option').map(option => option.text())).toEqual(['You', 'Host', 'Aster', 'Briar']);
    await button(wrapper, 'Create link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'producer', producerGrantId: 'grant-me' });
    await wrapper.findAll('select')[0]!.setValue('host');
    await button(wrapper, 'Create link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenLastCalledWith('show', { subject: 'host' });
    wrapper.unmount();
  });

  it('creates links for a producer and a character', async () => {
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await wrapper.findAll('select')[0]!.setValue('producer:grant-1');
    await button(wrapper, 'Create link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenLastCalledWith('show', { subject: 'producer', producerGrantId: 'grant-1' });
    await wrapper.findAll('select')[0]!.setValue('player:pc-2');
    await button(wrapper, 'Create link').trigger('click'); await flushPromises();
    expect(transport.createStreamLink).toHaveBeenLastCalledWith('show', { subject: 'player', characterId: 'pc-2' });
    wrapper.unmount();
  });

  it('keeps the token after # and puts layout and audio in the query', async () => {
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await button(wrapper, 'Create main show link').trigger('click'); await flushPromises();
    const url = () => (wrapper.get('input[readonly]').element as HTMLInputElement).value;
    expect(url()).toBe(`${window.location.origin}/stream?layout=scene&audio=present#token=tok%2Fen%2B1`);
    const [, layout, audio] = wrapper.findAll('select');
    expect(audio!.findAll('option').map(option => option.text())).toEqual(['Broadcast audio', 'Listen only', 'Off']);
    await layout!.setValue('overlay'); await audio!.setValue('listen');
    expect(url()).toBe(`${window.location.origin}/stream?layout=overlay&audio=listen#token=tok%2Fen%2B1`);
    wrapper.unmount();
  });

  it('offers personal links only listen and off, and shows an existing link on request', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary({ id: 'link-pc', subject: 'player', characterId: 'pc-1', canPresent: false, label: 'Aster' })] });
    transport.streamLink.mockResolvedValue({ link: summary({ id: 'link-pc', subject: 'player', characterId: 'pc-1', canPresent: false, label: 'Aster' }), token: 'later-token' });
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    expect(wrapper.find('input[readonly]').exists()).toBe(false);
    expect(wrapper.findAll('select')[2]!.findAll('option').map(option => option.text())).toEqual(['Listen only', 'Off']);
    await button(wrapper, 'Show link').trigger('click'); await flushPromises();
    expect(transport.streamLink).toHaveBeenCalledWith('show', 'link-pc');
    expect((wrapper.get('input[readonly]').element as HTMLInputElement).value).toContain('audio=listen#token=later-token');
    wrapper.unmount();
  });

  it('copies the link and always previews with audio off', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await button(wrapper, 'Create main show link').trigger('click'); await flushPromises();
    await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/stream?layout=scene&audio=present#token=tok%2Fen%2B1`);
    expect(wrapper.get('.copied').text()).toBe('Copied');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    await button(wrapper, 'Open preview').trigger('click');
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/stream?layout=scene&audio=off#token=tok%2Fen%2B1`, '_blank', 'noopener');
    wrapper.unmount();
  });

  it('reports a failed copy and clears it after a later success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const exec = vi.fn().mockReturnValue(false);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await button(wrapper, 'Create main show link').trigger('click'); await flushPromises();
    await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(wrapper.get('.copied').text()).toBe('Copy failed. Select the link and copy it.');
    expect(wrapper.text()).not.toContain('Copied');
    exec.mockReturnValue(true);
    await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
    expect(wrapper.get('.copied').text()).toBe('Copied');
    wrapper.unmount();
  });

  it('opens and scrolls into view when the page address ends in #stage-links', async () => {
    const scroll = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}#stage-links`);
    try {
      const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await flushPromises();
      expect(wrapper.find('.links-body').exists()).toBe(true);
      expect(transport.streamLinks).toHaveBeenCalled();
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      wrapper.unmount();
    } finally {
      window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}`);
      delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('needs a confirmation before turning a link off', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary()] });
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await button(wrapper, 'Revoke').trigger('click');
    expect(transport.revokeStreamLink).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Turn off this link? OBS sources using it switch to a holding screen within seconds.');
    await button(wrapper, 'Keep link').trigger('click');
    expect(transport.revokeStreamLink).not.toHaveBeenCalled();
    await button(wrapper, 'Revoke').trigger('click');
    await button(wrapper, 'Turn off link').trigger('click'); await flushPromises();
    expect(transport.revokeStreamLink).toHaveBeenCalledWith('show', 'link-show');
    expect(wrapper.text()).not.toContain('Main show link');
    wrapper.unmount();
  });

  it('shows a plain message when links cannot be loaded', async () => {
    transport.streamLinks.mockRejectedValue(new Error('boom'));
    transport.me.mockRejectedValue(new Error('Sign in'));
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    expect(wrapper.text()).toContain('The stream links could not be loaded');
    expect(wrapper.findAll('select')).toHaveLength(0);
    wrapper.unmount();
  });

  it('explains every control with its own help outside the label', async () => {
    transport.streamLinks.mockResolvedValue({ links: [summary(), summary({ id: 'link-pc', subject: 'player', characterId: 'pc-1', canPresent: false, label: 'Aster' })] });
    const wrapper = mount(StreamLinks, { props: { sessionId: 'show', characters } }); await openPanel(wrapper);
    await wrapper.findAll('button').filter(item => item.text() === 'Show link')[0]!.trigger('click'); await flushPromises();
    const controls = wrapper.findAll('input, select');
    expect(controls.length).toBeGreaterThanOrEqual(6);
    const seen = new Set<string>();
    for (const control of controls) {
      const ids = control.attributes('aria-describedby')?.split(/\s+/) ?? [];
      expect(ids, control.element.outerHTML).toHaveLength(1);
      expect(seen.has(ids[0]!)).toBe(false); seen.add(ids[0]!);
      const nodes = wrapper.findAll('[id]').filter(node => node.attributes('id') === ids[0]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.classes()).toContain('field-help');
      expect(nodes[0]!.text().length).toBeGreaterThan(20);
      expect(nodes[0]!.element.closest('label')).toBeNull();
    }
    wrapper.unmount();
  });
  describe('player mode', () => {
    const own = (over: Record<string, unknown> = {}) => summary({ id: 'link-own', subject: 'player', characterId: 'pc-1', canPresent: false, label: 'Aster', ...over });
    const mountPlayer = () => mount(StreamLinks, { props: { sessionId: 'show', characters, mode: 'player', ownCharacterId: 'pc-1' } });

    it('is closed by default and makes no requests', async () => {
      const wrapper = mountPlayer(); await flushPromises();
      expect(wrapper.attributes('id')).toBe('my-stream-view');
      expect(wrapper.get('h3').text()).toBe('My stream view');
      expect(wrapper.get('button[aria-expanded]').text()).toBe('Show my stream view');
      expect(wrapper.findAll('input, select, textarea')).toHaveLength(0);
      for (const fn of Object.values(transport)) expect(fn).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it('shows only the own link and never offers Broadcast audio', async () => {
      transport.streamLinks.mockResolvedValue({ links: [summary(), own(), own({ id: 'other', characterId: 'pc-2', label: 'Briar' })] });
      const wrapper = mountPlayer(); await openPanel(wrapper);
      expect(transport.me).not.toHaveBeenCalled();
      expect(transport.producers).not.toHaveBeenCalled();
      expect(wrapper.text()).not.toContain('Main show link');
      expect(wrapper.text()).not.toContain('Briar');
      expect(wrapper.text()).not.toContain('Broadcast audio');
      expect(wrapper.text()).toContain('you will hear the narration twice');
      const audio = wrapper.findAll('select')[1]!;
      expect(audio.findAll('option').map(option => option.text())).toEqual(['Listen only', 'Off']);
      wrapper.unmount();
    });

    it('creates the player link for its own character', async () => {
      transport.createStreamLink.mockResolvedValue({ link: own(), token: 'own-token' });
      const wrapper = mountPlayer(); await openPanel(wrapper);
      expect(button(wrapper, 'Create main show link')).toBeUndefined();
      await button(wrapper, 'Create my stream link').trigger('click'); await flushPromises();
      expect(transport.createStreamLink).toHaveBeenCalledWith('show', { subject: 'player', characterId: 'pc-1' });
      expect((wrapper.get('input[readonly]').element as HTMLInputElement).value).toBe(`${window.location.origin}/stream?layout=scene&audio=listen#token=own-token`);
      expect(wrapper.find('[role="status"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it('previews with audio off and revokes after confirming', async () => {
      transport.streamLinks.mockResolvedValue({ links: [own()] });
      transport.streamLink.mockResolvedValue({ link: own(), token: 'own-token' });
      transport.revokeStreamLink.mockResolvedValue(own({ revokedAt: '2026-10-23T12:00:00.000Z' }));
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const wrapper = mountPlayer(); await openPanel(wrapper);
      await button(wrapper, 'Show link').trigger('click'); await flushPromises();
      await button(wrapper, 'Open preview').trigger('click');
      expect(open).toHaveBeenCalledWith(`${window.location.origin}/stream?layout=scene&audio=off#token=own-token`, '_blank', 'noopener');
      await button(wrapper, 'Revoke').trigger('click');
      await button(wrapper, 'Turn off link').trigger('click'); await flushPromises();
      expect(transport.revokeStreamLink).toHaveBeenCalledWith('show', 'link-own');
      expect(button(wrapper, 'Create my stream link')).toBeDefined();
      wrapper.unmount();
    });

    it('gives every control its own help', async () => {
      transport.streamLinks.mockResolvedValue({ links: [own()] });
      transport.streamLink.mockResolvedValue({ link: own(), token: 'own-token' });
      const wrapper = mountPlayer(); await openPanel(wrapper);
      await button(wrapper, 'Show link').trigger('click'); await flushPromises();
      const seen = new Set<string>();
      for (const control of wrapper.findAll('input, select')) {
        const id = control.attributes('aria-describedby')!;
        expect(seen.has(id)).toBe(false); seen.add(id);
        const node = wrapper.findAll('[id]').find(item => item.attributes('id') === id)!;
        expect(node.classes()).toContain('field-help');
        expect(node.text().length).toBeGreaterThan(20);
        expect(node.element.closest('label')).toBeNull();
      }
      expect(seen.size).toBe(3);
      wrapper.unmount();
    });
  });
});
