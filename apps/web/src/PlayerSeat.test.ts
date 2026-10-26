// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import PlayerSeat from './PlayerSeat.vue';
import { saveDraft } from './drafts';
import { createTable, PAUSE_REQUEST_TEXT, provideTable, type Table } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

const AudioPanelStub = { name: 'AudioPanel', props: ['sessionId', 'beatId', 'director', 'stage', 'compact'], template: '<div data-testid="audio-panel-stub" />' };

function beat(id: string, kind: 'conversation' | 'action', overrides: Record<string, unknown> = {}) {
  return {
    id, sessionId: 'show', kind, phase: 'collecting', revision: 1, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], classification: 'ordinary', stakesApproved: false, inputSnapshotHash: null,
    resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null, ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return { id: 's1', characterId: 'pc-1', kind: 'say', text: '', intent: '', approach: '', recipientNpcIds: [], stageDirection: '', status: 'queued', revision: 1, contextBeatId: null, ...overrides };
}

function snapshot(extra: Record<string, unknown> = {}, own: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, role: 'player', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' }, ...session },
    characters: [], npcs: [], tracks: [], facts: [], activeBeat: null, history: [],
    ownCharacter: { id: 'pc-1', displayName: 'Skooty', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 0, ...own },
    submissions: [],
    ...extra,
  };
}

let table: Table;
let wrapper: VueWrapper | undefined;
async function mountSeat(state: ReturnType<typeof snapshot>) {
  transport.snapshot.mockResolvedValue(state);
  const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(PlayerSeat); } });
  wrapper = mount(Host, { global: { stubs: { AudioPanel: AudioPanelStub } } });
  await table.refresh();
  await flushPromises();
  return wrapper;
}
async function refreshTo(state: ReturnType<typeof snapshot>) {
  transport.snapshot.mockResolvedValue(state);
  await table.refresh();
  await flushPromises();
}

const buttonNamed = (w: VueWrapper, name: string) => w.findAll('button').find(button => button.text() === name)!;
const click = async (w: VueWrapper, name: string) => { await buttonNamed(w, name).trigger('click'); await flushPromises(); };
const pressed = (w: VueWrapper, name: string) => buttonNamed(w, name).attributes('aria-pressed');
const submit = async (w: VueWrapper) => { await w.get('[data-testid="submission-form"]').trigger('submit'); await flushPromises(); };
const lastCommand = () => transport.command.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  transport.subscribe.mockReturnValue(() => {});
  transport.command.mockResolvedValue({});
  window.history.replaceState({}, '', '/sessions/show/play');
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  sessionStorage.clear();
});

describe('player seat', () => {
  it('sends Do something as one action text in both goal fields', async () => {
    const w = await mountSeat(snapshot());
    expect(pressed(w, 'Say something')).toBe('true');
    await click(w, 'Do something');
    await w.get('[data-testid="action-input"]').setValue('Climb the fire escape and look in the window');
    await submit(w);
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({
      type: 'save_submission', kind: 'act', text: '', intent: 'Climb the fire escape and look in the window', approach: 'Climb the fire escape and look in the window',
      recipientNpcIds: [], stageDirection: '', alreadySpokenAloud: true,
    }));
    const status = w.findAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0].text()).toBe('Saved. The director has your line.');
    expect((w.get('[data-testid="action-input"]').element as HTMLTextAreaElement).value).toBe('');
  });

  it('picks the mode that fits the turn until words are typed', async () => {
    const w = await mountSeat(snapshot({ activeBeat: beat('beat-a', 'action') }));
    expect(pressed(w, 'Do something')).toBe('true');
    expect(w.find('[data-testid="action-input"]').exists()).toBe(true);
    expect(w.find('[data-testid="speech-input"]').exists()).toBe(false);
    await refreshTo(snapshot({ activeBeat: beat('beat-b', 'conversation') }));
    expect(pressed(w, 'Say something')).toBe('true');
    expect(w.find('[data-testid="speech-input"]').exists()).toBe(true);
    await w.get('[data-testid="speech-input"]').setValue('Hello there');
    await refreshTo(snapshot({ activeBeat: beat('beat-c', 'action') }));
    expect(pressed(w, 'Say something')).toBe('true');
    expect((w.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Hello there');
  });

  it('keeps a private note apart from the words to say', async () => {
    const w = await mountSeat(snapshot());
    await w.get('[data-testid="speech-input"]').setValue('Hello Mara');
    await click(w, 'Ask the director privately');
    expect((w.get('[data-testid="note-input"]').element as HTMLTextAreaElement).value).toBe('');
    expect(pressed(w, 'Say something')).toBe('false');
    expect(pressed(w, 'Do something')).toBe('false');
    expect(w.get('button.send').text()).toBe('Send privately');
    await w.get('[data-testid="note-input"]').setValue('Can I step out for a minute?');
    await click(w, 'Say something');
    expect((w.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Hello Mara');
    await click(w, 'Ask the director privately');
    expect((w.get('[data-testid="note-input"]').element as HTMLTextAreaElement).value).toBe('Can I step out for a minute?');
    await submit(w);
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({
      type: 'save_submission', kind: 'ooc', text: 'Can I step out for a minute?', intent: '', approach: '', recipientNpcIds: [], stageDirection: '',
    }));
    expect(w.get('[role="status"]').text()).toBe('Saved. Only the director sees your note.');
    expect(pressed(w, 'Say something')).toBe('true');
    expect((w.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Hello Mara');
  });

  it('does not tie leftover say words to an old turn after an action is sent', async () => {
    const w = await mountSeat(snapshot({ activeBeat: beat('beat-a', 'conversation') }));
    await w.get('[data-testid="speech-input"]').setValue('Hello Mara');
    await click(w, 'Do something');
    expect(w.find('[data-testid="review-current-input"]').exists()).toBe(false);
    await w.get('[data-testid="action-input"]').setValue('Open the door');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({ kind: 'act', contextBeatId: 'beat-a', expectedInputEpoch: 0 }));
    await refreshTo(snapshot({ activeBeat: beat('beat-b', 'conversation', { inputEpoch: 1 }) }, {}, { inputEpoch: 1 }));
    expect(pressed(w, 'Say something')).toBe('true');
    expect((w.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Hello Mara');
    expect(w.find('[data-testid="review-current-input"]').exists()).toBe(true);
    await click(w, 'Do something');
    expect(w.find('[data-testid="review-current-input"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Not sent yet');
    await refreshTo(snapshot({ activeBeat: beat('beat-c', 'action', { inputEpoch: 2 }) }, {}, { inputEpoch: 2 }));
    await w.get('[data-testid="action-input"]').setValue('Pick the lock');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({ kind: 'act', contextBeatId: 'beat-c', expectedInputEpoch: 2 }));
  });

  it('keeps a note left by Cancel from blocking the next turn', async () => {
    const w = await mountSeat(snapshot({ activeBeat: beat('beat-a', 'conversation') }));
    await click(w, 'Ask the director privately');
    await w.get('[data-testid="note-input"]').setValue('Can I step out?');
    await click(w, 'Cancel');
    expect(pressed(w, 'Say something')).toBe('true');
    await refreshTo(snapshot({ activeBeat: beat('beat-b', 'action', { inputEpoch: 1 }) }, {}, { inputEpoch: 1 }));
    expect(pressed(w, 'Do something')).toBe('true');
    expect(w.find('[data-testid="review-current-input"]').exists()).toBe(false);
    expect(w.text()).not.toContain('The story moved on');
    await w.get('[data-testid="action-input"]').setValue('Climb the fire escape');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({ kind: 'act', contextBeatId: 'beat-b', expectedInputEpoch: 1 }));
    await click(w, 'Ask the director privately');
    expect((w.get('[data-testid="note-input"]').element as HTMLTextAreaElement).value).toBe('Can I step out?');
    expect(w.find('[data-testid="review-current-input"]').exists()).toBe(true);
  });

  it('asks for a pause with the pause request text', async () => {
    const w = await mountSeat(snapshot());
    await click(w, 'Ask for a pause');
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'save_submission', kind: 'ooc', text: PAUSE_REQUEST_TEXT }));
    expect(w.get('[role="status"]').text()).toBe('Pause requested. Say so on the voice call too.');
  });

  it('puts a sent line back in its box to change it and keeps its fields', async () => {
    const act = line({ kind: 'act', revision: 2, intent: 'Open it', approach: 'Pick the lock' });
    let w = await mountSeat(snapshot({ submissions: [act] }));
    await click(w, 'Change');
    expect((w.get('[data-testid="action-input"]').element as HTMLTextAreaElement).value).toBe('Open it\nPick the lock');
    expect(w.get('button.send').text()).toBe('Save changes');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({
      type: 'save_submission', submissionId: 's1', expectedSubmissionRevision: 2, kind: 'act', intent: 'Open it\nPick the lock', approach: 'Open it\nPick the lock',
    }));
    w.unmount();
    wrapper = undefined;
    transport.command.mockClear();
    sessionStorage.clear();

    const npcs = [{ id: 'mara', displayName: 'Mara', role: 'Bartender', status: 'present' }];
    const say = line({ kind: 'say', text: 'Who sent you?', recipientNpcIds: ['mara'], stageDirection: 'Taps the bar' });
    w = await mountSeat(snapshot({ npcs, submissions: [say] }));
    await click(w, 'Change');
    expect((w.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Who sent you?');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({ kind: 'say', submissionId: 's1', text: 'Who sent you?', recipientNpcIds: ['mara'], stageDirection: 'Taps the bar' }));
  });

  it('brings back an unsent draft in its own mode', async () => {
    saveDraft('show', 'pc-1', { kind: 'act', intent: 'Climb the fire escape', approach: '', speech: '', note: '', stageDirection: '', recipient: '', context: { epoch: 0, beatId: null } });
    const w = await mountSeat(snapshot());
    expect(pressed(w, 'Do something')).toBe('true');
    expect((w.get('[data-testid="action-input"]').element as HTMLTextAreaElement).value).toBe('Climb the fire escape');
    expect(w.get('.draft-restored').text()).toBe('Your unsent words are back.');
  });

  it('keeps unsent words safe while a sent line is changed or the change is cancelled', async () => {
    const w = await mountSeat(snapshot({ submissions: [line({ kind: 'say', text: 'Who sent you?' })] }));
    const value = (id: string) => (w.get(`[data-testid="${id}"]`).element as HTMLTextAreaElement).value;
    await w.get('[data-testid="speech-input"]').setValue('Fresh follow-up');
    await click(w, 'Change');
    expect(value('speech-input')).toBe('Who sent you?');
    await submit(w);
    expect(lastCommand()).toEqual(expect.objectContaining({ submissionId: 's1', text: 'Who sent you?' }));
    expect(value('speech-input')).toBe('Fresh follow-up');
    await click(w, 'Change');
    await click(w, 'Cancel');
    expect(value('speech-input')).toBe('Fresh follow-up');
  });

  it('returns to the mode the player was in after changing a line', async () => {
    const w = await mountSeat(snapshot({ submissions: [line({ kind: 'say', text: 'Hello' })] }));
    await click(w, 'Do something');
    await w.get('[data-testid="action-input"]').setValue('Climb the fire escape');
    await click(w, 'Change');
    expect(pressed(w, 'Say something')).toBe('true');
    await submit(w);
    expect(pressed(w, 'Do something')).toBe('true');
    expect((w.get('[data-testid="action-input"]').element as HTMLTextAreaElement).value).toBe('Climb the fire escape');
  });

  it('reads drafts from the old seat into the right boxes, and never misreads a current one', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ kind: 'ooc', speech: 'Can I step out?', intent: '', approach: '', stageDirection: '', recipient: '', context: null }, 'note-input', 'Can I step out?'],
      [{ kind: 'act', speech: '', intent: 'Open the hatch', approach: 'Pick the lock', stageDirection: '', recipient: '', context: null }, 'action-input', 'Open the hatch\nPick the lock'],
      [{ kind: 'ooc', speech: 'Who sent you?', intent: '', approach: '', note: '', stageDirection: '', recipient: '', context: null }, 'speech-input', 'Who sent you?'],
    ];
    for (const [stored, testid, expected] of cases) {
      sessionStorage.setItem('rpg-draft:show:pc-1', JSON.stringify(stored));
      const w = await mountSeat(snapshot());
      expect((w.get(`[data-testid="${testid}"]`).element as HTMLTextAreaElement).value).toBe(expected);
      w.unmount();
      wrapper = undefined;
      sessionStorage.clear();
    }
  });

  it('shows only the filled-in character card fields', async () => {
    const w = await mountSeat(snapshot({}, { pronouns: 'she/her', appearance: '', personality: 'Careful and dry', specialty: 'Locks', flaw: '', possessions: ['Lockpick', 'Map'], connection: '', secret: 'Owes a debt' }));
    expect(w.findAll('h2').map(heading => heading.text())).toEqual(['Skooty']);
    expect(w.get('h1').text()).toBe('The Velvet Static');
    expect(w.get('details summary').text()).toBe('Who is Skooty?');
    const labels = w.findAll('dt').map(term => term.text());
    expect(labels).toEqual(['Pronouns', 'Personality', 'Good at', 'Carrying', 'Your secret']);
    expect(w.findAll('dd')[labels.indexOf('Carrying')].text()).toBe('Lockpick, Map');
    const text = w.text();
    expect(text).not.toContain('Strain');
    for (const trait of ['force', 'finesse', 'wits', 'presence']) expect(text.toLowerCase()).not.toContain(trait);
  });
  describe('pictures', () => {
    const shown = { picturesEnabled: true, scenePicture: { imageId: '11111111-1111-4111-8111-111111111111', sceneId: 'bar' } };

    it('shows the small scene picture and the approved portrait when pictures are on', async () => {
      const w = await mountSeat(snapshot(shown, { pronouns: 'she/her', portraitId: '22222222-2222-4222-8222-222222222222' }));
      const scene = w.get('img.seat-scene-picture');
      expect(scene.attributes('alt')).toBe('The Velvet Static');
      expect(scene.attributes('src')).toContain('/api/sessions/show/images/11111111-1111-4111-8111-111111111111');
      expect(w.get('.seat-heading').classes()).toContain('with-picture');
      const portrait = w.get('details.card img.own-portrait');
      expect(portrait.attributes('alt')).toBe('Portrait of Skooty');
      expect(portrait.attributes('src')).toContain('/images/22222222-2222-4222-8222-222222222222');
    });

    it('shows neither when the picture is hidden, for another scene, or pictures are off', async () => {
      const own = { pronouns: 'she/her', portraitId: '22222222-2222-4222-8222-222222222222' };
      for (const extra of [{ picturesEnabled: true, scenePicture: null }, { picturesEnabled: true, scenePicture: { ...shown.scenePicture, sceneId: 'other' } }, { picturesEnabled: false, scenePicture: shown.scenePicture }, {}]) {
        const w = await mountSeat(snapshot(extra, own));
        expect(w.find('img.seat-scene-picture').exists()).toBe(false);
        expect(w.find('.seat-heading').classes()).not.toContain('with-picture');
        expect(w.find('img.own-portrait').exists()).toBe(extra.picturesEnabled === true);
        w.unmount(); wrapper = undefined;
      }
    });

    it('keeps a failed picture hidden while it stays shown and tries it again once it reappears', async () => {
      const w = await mountSeat(snapshot(shown, {}));
      await w.get('img.seat-scene-picture').trigger('error');
      expect(w.find('img.seat-scene-picture').exists()).toBe(false);
      await refreshTo(snapshot({ ...shown }, {}));
      expect(w.find('img.seat-scene-picture').exists()).toBe(false);
      await refreshTo(snapshot({ picturesEnabled: true, scenePicture: null }, {}));
      expect(w.find('img.seat-scene-picture').exists()).toBe(false);
      await refreshTo(snapshot(shown, {}));
      expect(w.find('img.seat-scene-picture').exists()).toBe(true);
    });

    it('tries the player\'s own portrait again after it changes, even back to one that failed before', async () => {
      const first = '22222222-2222-4222-8222-222222222222';
      const second = '33333333-3333-4333-8333-333333333333';
      const w = await mountSeat(snapshot(shown, { pronouns: 'she/her', portraitId: first }));
      await w.get('img.own-portrait').trigger('error');
      expect(w.find('img.own-portrait').exists()).toBe(false);
      await refreshTo(snapshot(shown, { pronouns: 'she/her', portraitId: second }));
      expect(w.get('img.own-portrait').attributes('src')).toContain(`/images/${second}`);
      await refreshTo(snapshot(shown, { pronouns: 'she/her', portraitId: first }));
      expect(w.get('img.own-portrait').attributes('src')).toContain(`/images/${first}`);
    });

    it('adds no headings or card rows', async () => {
      const w = await mountSeat(snapshot(shown, { pronouns: 'she/her', portraitId: '22222222-2222-4222-8222-222222222222' }));
      expect(w.findAll('h2').map(heading => heading.text())).toEqual(['Skooty']);
      expect(w.findAll('dt').map(term => term.text())).toEqual(['Pronouns']);
    });
  });
});
