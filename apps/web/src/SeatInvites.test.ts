// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCharacter } from '@rpg/contracts';
import SeatInvites from './SeatInvites.vue';

const transport = vi.hoisted(() => ({ invites: vi.fn(), inviteLink: vi.fn(), reissueInvite: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const characters = [{ id: 'pc-1', displayName: 'Aster' }, { id: 'pc-2', displayName: 'Briar' }] as unknown as PublicCharacter[];
const invite = (over: Record<string, unknown> = {}) => ({ id: 'inv-1', role: 'player', characterId: 'pc-1', status: 'waiting', createdAt: '2026-10-22T12:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', redeemedAt: null, revokedAt: null, replacedBy: null, signedIn: false, ...over });
const mountIt = () => mount(SeatInvites, { props: { sessionId: 'show', characters }, attachTo: document.body });
const button = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;
const open = async (wrapper: ReturnType<typeof mount>) => { await wrapper.get('button[aria-expanded]').trigger('click'); await flushPromises(); };

beforeEach(() => {
  vi.resetAllMocks();
  transport.invites.mockResolvedValue({ invites: [
    invite(),
    invite({ id: 'inv-2', characterId: 'pc-2', status: 'joined', signedIn: true }),
    invite({ id: 'inv-3', role: 'stage', characterId: null, status: 'expired' }),
    invite({ id: 'inv-4', status: 'revoked' }),
    invite({ id: 'inv-5', status: 'replaced' }),
  ] });
  transport.inviteLink.mockResolvedValue({ invite: invite(), token: 'tok/1' });
  transport.reissueInvite.mockResolvedValue({ invite: invite({ id: 'inv-9' }), token: 'new-token' });
});

describe('SeatInvites', () => {
  it('is closed by default and makes no api calls', () => {
    const wrapper = mountIt();
    expect(wrapper.findAll('button')).toHaveLength(1);
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.text()).toContain('Show seats & invitation links');
    expect(transport.invites).not.toHaveBeenCalled();
  });

  it('shows names and status words, hiding replaced and stage invitations', async () => {
    const wrapper = mountIt(); await open(wrapper);
    expect(wrapper.findAll('article')).toHaveLength(3);
    const text = wrapper.text();
    for (const word of ['Waiting', 'Joined', 'Revoked', 'Signed in now', 'Aster', 'Briar']) expect(text).toContain(word);
    for (const word of ['Replaced', 'Stage', 'Expired']) expect(text).not.toContain(word);
  });

  it('shows a waiting link again', async () => {
    const wrapper = mountIt(); await open(wrapper);
    await button(wrapper, 'Show link').trigger('click'); await flushPromises();
    expect(transport.inviteLink).toHaveBeenCalledWith('show', 'inv-1');
    expect((wrapper.get('input[readonly]').element as HTMLInputElement).value).toBe(`${window.location.origin}/join/tok%2F1`);
  });

  it('reissues with the sign-out choice and shows the new link', async () => {
    const wrapper = mountIt(); await open(wrapper);
    await wrapper.findAll('button').filter(item => item.text() === 'Reissue link')[0]!.trigger('click');
    expect(wrapper.text()).toContain('The old link stops working. Send the new one to the player.');
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await button(wrapper, 'Reissue').trigger('click'); await flushPromises();
    expect(transport.reissueInvite).toHaveBeenCalledWith('show', 'inv-1', true);
    expect(transport.invites).toHaveBeenCalledTimes(2);
  });

  describe('copy and hash', () => {
    const reveal = async () => {
      const wrapper = mountIt(); await open(wrapper);
      await button(wrapper, 'Show link').trigger('click'); await flushPromises();
      return wrapper;
    };
    const stubClipboard = (write: () => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });

    it('reports failure when the clipboard and the fallback both fail', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      document.execCommand = vi.fn(() => false);
      const wrapper = await reveal();
      await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
      const text = wrapper.get('.copied').text();
      expect(text).toBe('Copy failed. Select the link and copy it.');
      expect(text).not.toContain('Copied');
    });

    it('says Copied when the fallback works, and clears an earlier failure', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      const exec = vi.fn(() => false);
      document.execCommand = exec;
      const wrapper = await reveal();
      await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
      expect(wrapper.get('.copied').text()).toContain('Copy failed');
      exec.mockReturnValue(true);
      await button(wrapper, 'Copy link').trigger('click'); await flushPromises();
      expect(wrapper.get('.copied').text()).toBe('Copied');
    });

    it('opens and scrolls into view when the page address ends in #seat-links', async () => {
      window.location.hash = '#seat-links';
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        const wrapper = mountIt(); await flushPromises();
        expect(wrapper.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
        expect(wrapper.find('.links-body').exists()).toBe(true);
        expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      } finally { window.location.hash = ''; }
    });
  });

  it('gives every input its own field help outside labels', async () => {
    const wrapper = mountIt(); await open(wrapper);
    await button(wrapper, 'Show link').trigger('click'); await flushPromises();
    await wrapper.findAll('button').filter(item => item.text() === 'Reissue link')[1]!.trigger('click');
    const inputs = wrapper.findAll('input');
    expect(inputs.length).toBe(2);
    const ids = inputs.map(item => item.attributes('aria-describedby')!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const help = document.getElementById(id)!;
      expect(help.tagName).toBe('P'); expect(help.classList.contains('field-help')).toBe(true);
      expect(help.textContent!.length).toBeGreaterThan(20);
      expect(help.closest('label')).toBeNull();
    }
  });
});
