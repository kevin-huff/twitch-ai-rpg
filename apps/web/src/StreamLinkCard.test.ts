// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamLinkSummary } from '@rpg/contracts';
import StreamLinkCard from './StreamLinkCard.vue';
import { streamUrl } from './stream';

const link = (overrides: Partial<StreamLinkSummary> = {}): StreamLinkSummary => ({
  id: 'l1', sessionId: 's1', subject: 'show', label: 'Main show', characterId: null, producerGrantId: null, canPresent: true,
  createdAt: '2026-10-26T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, ...overrides,
});
const personal = () => link({ id: 'l2', subject: 'player', label: 'Mara', characterId: 'c1', canPresent: false });

let wrapper: VueWrapper | null = null;
let writeText: ReturnType<typeof vi.fn>;
const origin = () => window.location.origin;

function mountCard(props: Record<string, unknown> = {}) {
  wrapper = mount(StreamLinkCard, { props: { link: link(), token: 'tok en', title: 'Main show link', ...props }, attachTo: document.body });
  return wrapper;
}
const tid = (id: string) => wrapper!.get(`[data-testid="${id}"]`);

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });

describe('streamUrl', () => {
  it('keeps the address format and adds bg=checker only when asked', () => {
    expect(streamUrl('https://x.test', 'a b', { layout: 'scene', audio: 'present' })).toBe('https://x.test/stream?layout=scene&audio=present#token=a%20b');
    expect(streamUrl('https://x.test', 'a b', { layout: 'overlay', audio: 'off', checker: false })).toBe('https://x.test/stream?layout=overlay&audio=off#token=a%20b');
    expect(streamUrl('https://x.test', 'a b', { layout: 'overlay', audio: 'off', checker: true })).toBe('https://x.test/stream?layout=overlay&audio=off&bg=checker#token=a%20b');
  });
});

describe('StreamLinkCard copy buttons', () => {
  it('copies the overlay and full-scene addresses with the show audio for the main link, never bg', async () => {
    mountCard();
    const overlay = streamUrl(origin(), 'tok en', { layout: 'overlay', audio: 'present' });
    const scene = streamUrl(origin(), 'tok en', { layout: 'scene', audio: 'present' });
    expect(tid('copy-overlay').attributes('data-url')).toBe(overlay);
    expect(tid('copy-scene').attributes('data-url')).toBe(scene);
    expect(wrapper!.text()).toContain('Captions, cast and dice over your own camera, on a see-through background.');
    expect(wrapper!.text()).toContain('The whole show as one 1920×1080 picture.');
    expect(wrapper!.text()).toContain('This link carries the show audio.');
    await tid('copy-overlay').trigger('click');
    expect(writeText).toHaveBeenLastCalledWith(overlay);
    await tid('copy-scene').trigger('click');
    expect(writeText).toHaveBeenLastCalledWith(scene);
    expect(wrapper!.text()).toContain('Copied');
    expect(overlay).not.toContain('bg=');
    expect(scene).not.toContain('bg=');
  });

  it('listens only for a personal link', () => {
    mountCard({ link: personal(), title: 'Mara' });
    expect(tid('copy-scene').attributes('data-url')).toContain('audio=listen');
    expect(tid('copy-overlay').attributes('data-url')).toContain('audio=listen');
    expect(wrapper!.text()).toContain('This link plays the narration only where it is opened.');
  });

  it('changes both copy addresses when the sound changes', async () => {
    mountCard();
    const select = tid('sound-select');
    expect(select.findAll('option').map(option => option.text())).toEqual(['Show audio', 'Listen only', 'Off']);
    await select.setValue('off');
    expect(tid('copy-overlay').attributes('data-url')).toContain('audio=off');
    expect(tid('copy-scene').attributes('data-url')).toContain('audio=off');
    await select.setValue('listen');
    expect(tid('copy-scene').attributes('data-url')).toContain('audio=listen');
    await tid('copy-scene').trigger('click');
    expect(writeText).toHaveBeenLastCalledWith(streamUrl(origin(), 'tok en', { layout: 'scene', audio: 'listen' }));
  });

  it('offers no show audio choice for a link that cannot present', () => {
    mountCard({ link: personal() });
    expect(tid('sound-select').findAll('option').map(option => option.text())).toEqual(['Listen only', 'Off']);
  });

  it('shows a selected read-only box when copying fails', async () => {
    writeText.mockRejectedValue(new Error('blocked'));
    Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(false), configurable: true });
    mountCard();
    await tid('copy-scene').trigger('click');
    await vi.waitFor(() => expect(wrapper!.find('[data-testid="copy-fallback"]').exists()).toBe(true));
    const box = tid('copy-fallback').element as HTMLInputElement;
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe(streamUrl(origin(), 'tok en', { layout: 'scene', audio: 'present' }));
    expect(wrapper!.text()).toContain('Copy failed. Select the link and copy it.');
    expect(box.selectionEnd! - box.selectionStart!).toBe(box.value.length);
  });
});

describe('StreamLinkCard previews', () => {
  it('opens silent previews, with the checker only on the overlay', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountCard();
    await tid('preview-overlay').trigger('click');
    expect(open).toHaveBeenLastCalledWith(streamUrl(origin(), 'tok en', { layout: 'overlay', audio: 'off', checker: true }), '_blank', 'noopener');
    expect(String(open.mock.calls[0]![0])).toContain('bg=checker');
    await tid('preview-scene').trigger('click');
    const sceneCall = String(open.mock.calls[1]![0]);
    expect(sceneCall).toBe(streamUrl(origin(), 'tok en', { layout: 'scene', audio: 'off' }));
    expect(sceneCall).not.toContain('bg=');
    expect(tid('preview-overlay').text()).toContain('Preview (silent)');
  });
});

describe('StreamLinkCard folds', () => {
  it('keeps sound options and OBS steps closed, with Control audio via OBS only on a main link', () => {
    mountCard();
    expect((tid('sound-options').element as HTMLDetailsElement).open).toBe(false);
    expect((tid('obs-steps').element as HTMLDetailsElement).open).toBe(false);
    expect(tid('sound-options').text()).toContain("If this computer also plays the story, turn this link's sound off or you'll hear it twice.");
    const steps = tid('obs-steps').findAll('li').map(item => item.text());
    expect(steps).toEqual([
      'In OBS, open Sources, press +, and choose Browser.',
      'Paste the link into URL.',
      'Set Width to 1920 and Height to 1080.',
      'Untick Shutdown source when not visible and Refresh browser when scene becomes active.',
      'Tick Control audio via OBS.',
    ]);
  });

  it('leaves out Control audio via OBS for a personal link', () => {
    mountCard({ link: personal() });
    const steps = tid('obs-steps').findAll('li').map(item => item.text());
    expect(steps).toHaveLength(4);
    expect(tid('obs-steps').text()).not.toContain('Control audio via OBS');
  });

  it('hides previews, folds and turn off in compact mode but keeps the copy buttons', () => {
    mountCard({ compact: true });
    for (const id of ['preview-overlay', 'preview-scene', 'sound-options', 'obs-steps', 'turn-off']) expect(wrapper!.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(wrapper!.find('[data-testid="copy-overlay"]').exists()).toBe(true);
    expect(wrapper!.find('[data-testid="copy-scene"]').exists()).toBe(true);
  });

  it('puts the test id on the card', () => {
    mountCard({ testid: 'ready-show-link' });
    expect(wrapper!.find('[data-testid="ready-show-link"]').exists()).toBe(true);
    expect(wrapper!.text()).toContain('Main show link');
  });
});

describe('StreamLinkCard turn off', () => {
  it('asks first and emits turn-off only after the confirmation', async () => {
    mountCard();
    await tid('turn-off').trigger('click');
    expect(wrapper!.text()).toContain('Turn off this link? OBS sources using it switch to a holding screen within seconds.');
    expect(wrapper!.emitted('turn-off')).toBeUndefined();
    await tid('turn-off-keep').trigger('click');
    expect(wrapper!.emitted('turn-off')).toBeUndefined();
    expect(wrapper!.find('[data-testid="turn-off"]').exists()).toBe(true);
    await tid('turn-off').trigger('click');
    await tid('turn-off-confirm').trigger('click');
    expect(wrapper!.emitted('turn-off')).toHaveLength(1);
  });

  it('hides Turn off when it is not allowed and disables it while busy', async () => {
    mountCard({ canTurnOff: false });
    expect(wrapper!.find('[data-testid="turn-off"]').exists()).toBe(false);
    wrapper!.unmount();
    mountCard({ busy: true });
    expect((tid('turn-off').element as HTMLButtonElement).disabled).toBe(true);
  });
});
