// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCharacter, StreamLinkSummary } from '@rpg/contracts';
import StreamKit from './StreamKit.vue';
import { STAGE_PIECES, pieceUrl, streamUrl } from './stream';

const link = (overrides: Partial<StreamLinkSummary> = {}): StreamLinkSummary => ({
  id: 'l1', sessionId: 's1', subject: 'show', label: 'Main show', characterId: null, producerGrantId: null, canPresent: true,
  createdAt: '2026-10-26T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, ...overrides,
});
const player = () => link({ id: 'l2', subject: 'player', label: 'Mara', characterId: 'c1', canPresent: false });
const cast = (id: string, displayName: string) => ({ id, displayName } as unknown as PublicCharacter);
const characters = [cast('c1', 'Mara'), cast('c2', 'Tobias')];

let wrapper: VueWrapper | null = null;
let writeText: ReturnType<typeof vi.fn>;
const origin = () => window.location.origin;

function mountKit(props: Record<string, unknown> = {}) {
  wrapper = mount(StreamKit, { props: { link: link(), token: 'tok en', title: 'Main show link', characters, testid: 'kit-row', ...props }, attachTo: document.body });
  return wrapper;
}
const tid = (id: string) => wrapper!.get(`[data-testid="${id}"]`);
const inside = (card: string, id: string) => tid(card).get(`[data-testid="${id}"]`);
const copyUrl = (card: string) => inside(card, 'kit-copy').attributes('data-url');

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });

describe('StreamKit on a link that can present', () => {
  it('has no ready-made link and a Full layouts card with show audio and no turn off of its own', () => {
    mountKit();
    expect(wrapper!.find('[data-testid="kit-ready"]').exists()).toBe(false);
    expect(tid('kit-row').find('strong').text()).toBe('Main show link');
    expect(inside('kit-layouts', 'copy-overlay').attributes('data-url')).toBe(streamUrl(origin(), 'tok en', { layout: 'overlay', audio: 'present' }));
    expect(inside('kit-layouts', 'copy-scene').attributes('data-url')).toBe(streamUrl(origin(), 'tok en', { layout: 'scene', audio: 'present' }));
    expect(tid('kit-layouts').find('[data-testid="turn-off"]').exists()).toBe(false);
    expect(wrapper!.findAll('[data-testid="turn-off"]')).toHaveLength(1);
    expect(tid('kit-layouts').element.closest('details')).toBeNull();
  });

  it('lists nine piece cards in order with names, sizes and Shared tags', () => {
    mountKit();
    const pieces = tid('kit-pieces');
    expect(pieces.find('summary').text()).toBe('Pieces for your own scenes');
    expect((pieces.element as HTMLDetailsElement).open).toBe(false);
    const cards = pieces.findAll('[data-testid^="kit-piece-"]').filter((card) => card.attributes('data-testid') !== 'kit-piece-steps');
    expect(cards.map((card) => card.attributes('data-testid'))).toEqual(STAGE_PIECES.map((piece) => `kit-piece-${piece.view}`));
    STAGE_PIECES.forEach((piece, index) => {
      const card = cards[index]!;
      expect(card.find('.kit-title').text()).toBe(piece.name);
      expect(card.get('[data-testid="kit-size"]').text()).toBe(`${piece.box.width} × ${piece.box.height}`);
      expect(card.get('[data-testid="kit-tag"]').text()).toBe('Shared');
      expect(card.text()).toContain(piece.about);
    });
  });

  it('offers Who it shows only on dice, stakes and party', () => {
    mountKit();
    const withSelect = STAGE_PIECES.filter((piece) => wrapper!.find(`[data-testid="kit-piece-${piece.view}"] [data-testid="kit-who"]`).exists()).map((piece) => piece.view);
    expect(withSelect).toEqual(['dice', 'stakes', 'party']);
    const select = inside('kit-piece-dice', 'kit-who');
    expect(select.element.closest('label')!.textContent).toContain('Who it shows');
    expect(select.findAll('option').map((option) => option.text())).toEqual(['Everyone', 'Mara', 'Tobias']);
    expect(select.findAll('option')[0]!.attributes('value')).toBe('');
  });

  it('copies the piece and sound addresses and adds who= when a person is picked', async () => {
    mountKit();
    for (const piece of STAGE_PIECES) {
      expect(copyUrl(`kit-piece-${piece.view}`)).toBe(pieceUrl(origin(), 'tok en', { view: piece.view }));
    }
    expect(copyUrl('kit-sound')).toBe(streamUrl(origin(), 'tok en', { layout: 'audio' }));
    expect(copyUrl('kit-sound')).not.toContain('audio=');
    await inside('kit-piece-dice', 'kit-who').setValue('c2');
    expect(copyUrl('kit-piece-dice')).toBe(pieceUrl(origin(), 'tok en', { view: 'dice', who: 'c2' }));
    expect(copyUrl('kit-piece-dice')).toContain('&who=c2');
    expect(inside('kit-piece-dice', 'kit-tag').text()).toBe('Just for Tobias');
    expect(inside('kit-piece-stakes', 'kit-tag').text()).toBe('Shared');
    await inside('kit-piece-dice', 'kit-who').setValue('');
    expect(inside('kit-piece-dice', 'kit-tag').text()).toBe('Shared');
    await inside('kit-piece-dice', 'kit-copy').trigger('click');
    expect(writeText).toHaveBeenLastCalledWith(pieceUrl(origin(), 'tok en', { view: 'dice' }));
  });

  it('previews a piece silently on the checker background', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountKit();
    await inside('kit-piece-picture', 'kit-preview').trigger('click');
    expect(open).toHaveBeenLastCalledWith(pieceUrl(origin(), 'tok en', { view: 'picture', audio: 'off', checker: true }), '_blank', 'noopener');
    expect(open.mock.calls[0]![0]).toContain('&audio=off&bg=checker#token=');
    await inside('kit-piece-party', 'kit-who').setValue('c1');
    await inside('kit-piece-party', 'kit-preview').trigger('click');
    expect(open).toHaveBeenLastCalledWith(pieceUrl(origin(), 'tok en', { view: 'party', who: 'c1', audio: 'off', checker: true }), '_blank', 'noopener');
    expect(wrapper!.find('[data-testid="kit-sound"] [data-testid="kit-preview"]').exists()).toBe(false);
  });

  it('explains the sound link, the AI badge and how to add pieces', () => {
    mountKit();
    expect(inside('kit-sound', 'kit-copy').text()).toBe('Copy sound link');
    expect(tid('kit-sound').text()).toContain('carries the show audio for the whole stream');
    expect(tid('kit-sound').text()).toContain('Only one OBS should load it');
    expect(tid('kit-sound').text()).toContain('use the sound link only with pieces');
    expect(tid('kit-badge-note').text().startsWith('Keep the AI badge on screen')).toBe(true);
    expect(tid('kit-pieces').text()).toContain('Each piece is its own Browser source');
    expect(tid('kit-pieces').text()).toContain('Pieces never play sound');
    const steps = tid('kit-pieces').findAll('details').find((item) => item.find('summary').text() === 'How to add pieces in OBS')!;
    expect(steps.exists()).toBe(true);
    expect((steps.element as HTMLDetailsElement).open).toBe(false);
    expect(steps.text()).toContain('Control audio via OBS');
  });
});

describe('StreamKit on a player link', () => {
  it('shows the ready-made listen-only link first and defaults per-person pieces to that player', async () => {
    mountKit({ link: player(), title: 'Mara', testid: 'kit-player' });
    const ready = tid('kit-ready');
    expect(ready.get('.kit-title').text()).toBe('Ready-made link');
    const copies = wrapper!.findAll('[data-testid="kit-copy"]');
    expect(copies[0]!.text()).toBe('Copy ready-made link');
    expect(copies[0]!.attributes('data-url')).toBe(streamUrl(origin(), 'tok en', { layout: 'overlay', audio: 'listen' }));
    expect(copies[0]!.attributes('data-url')).toContain('layout=overlay&audio=listen');
    expect(ready.text()).toContain('One Browser source with the overlay and the narration');
    expect(wrapper!.findAll('[data-testid="kit-ready"], [data-testid="kit-layouts"]').map((item) => item.attributes('data-testid'))).toEqual(['kit-ready', 'kit-layouts']);
    expect(copyUrl('kit-piece-dice')).toBe(pieceUrl(origin(), 'tok en', { view: 'dice', who: 'c1' }));
    expect(inside('kit-piece-dice', 'kit-tag').text()).toBe('Just for Mara');
    expect((inside('kit-piece-party', 'kit-who').element as HTMLSelectElement).value).toBe('c1');
    expect(copyUrl('kit-piece-captions')).toBe(pieceUrl(origin(), 'tok en', { view: 'captions' }));
    expect(inside('kit-layouts', 'copy-overlay').attributes('data-url')).toContain('audio=listen');
    expect(tid('kit-sound').text()).toContain('plays the narration where it is opened and never carries the show audio');
    expect(tid('kit-pieces').text()).not.toContain('Tick Control audio via OBS');
  });
});

describe('StreamKit copy and turn off', () => {
  it('says Copied after a copy and shows the address to copy by hand after a failure', async () => {
    mountKit();
    await inside('kit-piece-tracks', 'kit-copy').trigger('click');
    await vi.waitFor(() => expect(inside('kit-piece-tracks', 'kit-copy').element.closest('article')!.textContent).toContain('Copied'));
    expect(tid('kit-piece-tracks').find('[data-testid="kit-copy-fallback"]').exists()).toBe(false);

    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn().mockReturnValue(false);
    await inside('kit-piece-badge', 'kit-copy').trigger('click');
    await vi.waitFor(() => expect(tid('kit-piece-badge').text()).toContain('Copy failed. Select the link and copy it.'));
    const fallback = inside('kit-piece-badge', 'kit-copy-fallback').element as HTMLInputElement;
    expect(fallback.value).toBe(pieceUrl(origin(), 'tok en', { view: 'badge' }));
    expect(fallback.readOnly).toBe(true);
  });

  it('asks before turning off and then emits turn-off', async () => {
    mountKit();
    expect(wrapper!.emitted('turn-off')).toBeUndefined();
    await tid('turn-off').trigger('click');
    expect(wrapper!.text()).toContain('Turn off this link? OBS sources using it switch to a holding screen, and its pieces go blank, within seconds.');
    expect(wrapper!.emitted('turn-off')).toBeUndefined();
    await tid('turn-off-keep').trigger('click');
    expect(wrapper!.find('[data-testid="turn-off-confirm"]').exists()).toBe(false);
    await tid('turn-off').trigger('click');
    await tid('turn-off-confirm').trigger('click');
    expect(wrapper!.emitted('turn-off')).toHaveLength(1);
  });

  it('hides Turn off when it cannot turn off, and disables it while busy', async () => {
    mountKit({ canTurnOff: false });
    expect(wrapper!.find('[data-testid="turn-off"]').exists()).toBe(false);
    wrapper!.unmount();
    mountKit({ busy: true });
    expect(tid('turn-off').attributes('disabled')).toBeDefined();
  });
});

describe('StreamKit structure', () => {
  it('gives every select and input of its own a help line over 20 characters outside its label', async () => {
    mountKit({ link: player(), title: 'Mara' });
    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn().mockReturnValue(false);
    await inside('kit-piece-tracks', 'kit-copy').trigger('click');
    await vi.waitFor(() => expect(wrapper!.find('[data-testid="kit-copy-fallback"]').exists()).toBe(true));
    const own = [...wrapper!.element.querySelectorAll('select, input')].filter((field) => !field.closest('[data-testid="kit-layouts"]'));
    expect(own.length).toBeGreaterThan(3);
    const ids = own.map((field) => field.getAttribute('aria-describedby'));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const help = wrapper!.element.querySelector(`[id="${id}"]`)!;
      expect(help.classList.contains('field-help')).toBe(true);
      expect(help.textContent!.length).toBeGreaterThan(20);
      expect(help.closest('label')).toBeNull();
    }
  });

  it('has no h4, no a element, and none of the old link wording', () => {
    mountKit({ link: player(), title: 'Mara' });
    expect(wrapper!.find('h4').exists()).toBe(false);
    expect(wrapper!.find('a').exists()).toBe(false);
    expect(wrapper!.text()).not.toContain('Show link');
    expect(wrapper!.text()).not.toContain('Revoke');
    const labels = [...wrapper!.element.querySelectorAll('label')].map((label) => label.textContent!.trim());
    expect(labels.some((label) => label.startsWith('Layout') || label.startsWith('Audio'))).toBe(false);
  });
});
