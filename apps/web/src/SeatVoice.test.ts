// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import type { PlayerSnapshot, VoiceOption } from '@rpg/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SeatVoice from './SeatVoice.vue';

const voices: VoiceOption[] = [
  { id: 'eleven:fake-ada', name: 'Ada', group: 'clone', summary: 'female · young', previewUrl: null, tuned: true },
  { id: 'eleven:fake-bram', name: 'Bram', group: 'added', summary: 'male · old', previewUrl: null, tuned: false },
];
const loadVoices = vi.hoisted(() => vi.fn());
vi.mock('./voices', async () => {
  const real = await vi.importActual<typeof import('./voices')>('./voices');
  return { ...real, loadVoices };
});

const snapshot = (own: Record<string, unknown> | null = { voiceProfileId: null }, status = 'lobby'): PlayerSnapshot => ({
  role: 'player', session: { id: 'show', title: 'T', stateRevision: 1, status },
  characters: [], ownCharacter: own ? { id: 'pc-1', ...own } : null,
}) as unknown as PlayerSnapshot;
const mountVoice = (current: PlayerSnapshot, busy = false) => mount(SeatVoice, { props: { snapshot: current, busy } });
const open = async (w: ReturnType<typeof mountVoice>) => {
  const details = w.get('[data-testid="seat-voice"]');
  (details.element as HTMLDetailsElement).open = true;
  await details.trigger('toggle');
  await flushPromises();
};

beforeEach(() => { loadVoices.mockReset(); loadVoices.mockResolvedValue({ voices }); });

describe('SeatVoice', () => {
  it('loads nothing until the section is opened', async () => {
    const w = mountVoice(snapshot());
    expect(loadVoices).not.toHaveBeenCalled();
    expect(w.find('[data-testid="voice-picker"]').exists()).toBe(false);
    expect(w.get('summary').text()).toContain('Your voice');
    await open(w);
    expect(loadVoices).toHaveBeenCalledTimes(1);
  });

  it('shows the picker after opening, with the narrator label and the chosen name', async () => {
    const w = mountVoice(snapshot({ voiceProfileId: 'eleven:fake-bram' }));
    await open(w);
    expect(w.find('[data-testid="voice-picker"]').exists()).toBe(true);
    expect(w.get('[data-testid="voice-narrator"]').text()).toContain('The narrator reads my lines');
    expect(w.get('summary').text()).toContain('Bram');
    expect(w.text()).toContain('Your Say lines play in this voice. The narrator reads what you do.');
  });

  it('emits set_voice for a voice and null for the narrator', async () => {
    const w = mountVoice(snapshot({ voiceProfileId: 'eleven:fake-bram' }));
    await open(w);
    await w.findAll('[data-testid="voice-option"] .voice-choose')[0].trigger('click');
    await w.get('[data-testid="voice-narrator"] button').trigger('click');
    const sent = w.emitted('command')!.map(([c]) => c as Record<string, unknown>);
    expect(sent[0]).toMatchObject({ type: 'set_voice', voiceProfileId: 'eleven:fake-ada' });
    expect(typeof sent[0].commandId).toBe('string');
    expect(sent[1]).toMatchObject({ type: 'set_voice', voiceProfileId: null });
  });

  it('is hidden when the show has ended or there is no own character', () => {
    expect(mountVoice(snapshot({ voiceProfileId: null }, 'ended')).find('[data-testid="seat-voice"]').exists()).toBe(false);
    expect(mountVoice(snapshot(null)).find('[data-testid="seat-voice"]').exists()).toBe(false);
  });
});
