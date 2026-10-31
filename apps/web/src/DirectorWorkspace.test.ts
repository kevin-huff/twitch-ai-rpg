// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import DirectorWorkspace from './DirectorWorkspace.vue';
import { createTable, provideTable, type Table } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), galleryAction: vi.fn(), hideScenePicture: vi.fn(), showScenePicture: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

const stub = (name: string, extra: Record<string, unknown> = {}) => ({ name, template: `<div data-testid="${name}-stub" />`, ...extra });
const stubs = {
  BeatPanel: { name: 'BeatPanel', props: ['selected', 'showAudio', 'playbackError'], emits: ['published', 'start-playback'], template: '<div data-testid="beat-panel-stub" />' },
  AudioPanel: { name: 'AudioPanel', props: ['sessionId', 'beatId', 'director', 'autoPlayBeatId'], emits: ['playback-failed'], template: '<div data-testid="audio-panel-stub" />' },
  DirectorStatusStrip: { name: 'DirectorStatusStrip', props: ['snapshot', 'sessionId'], emits: ['audio'], template: '<div data-testid="status-strip-stub" />' },
  DirectorQueue: stub('DirectorQueue', { props: ['modelValue', 'snapshot'] }),
  GalleryPanel: { name: 'GalleryPanel', props: ['status', 'busy'], emits: ['action'], template: '<div data-testid="gallery-stub" />' },
  Story: stub('Story', { props: ['history', 'characters', 'corrections'] }),
  LiveControls: stub('LiveControls'), CorrectionControls: stub('CorrectionControls'), BeatSteering: stub('BeatSteering'), OperationsPanel: stub('OperationsPanel'),
  ScenePicturePanel: stub('ScenePicturePanel'), NpcPortraitControls: stub('NpcPortraitControls'), PictureAvatar: stub('PictureAvatar'),
};

const PAUSE_TEXT = 'Pause requested. Please check in with the table.';
const submission = (id: string, kind = 'say', status = 'queued') => ({ id, characterId: 'pc-1', kind, status, text: 'Hello', revision: 1 });

function snapshot(status = 'live', submissions: Array<Record<string, unknown>> = [], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 4, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [{ id: 'pc-1', displayName: 'Skooty' }], npcs: [], tracks: [], facts: [], activeBeat: null, history: [{ id: 'beat-1', segments: [] }],
    submissions, npcDetails: [], characterDetails: [], jobs: [], directorNotes: '', gallery: null, setup: null,
    ...extra,
  };
}

let table: Table;
async function mountWorkspace(state: ReturnType<typeof snapshot>) {
  transport.snapshot.mockResolvedValue(state);
  const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(DirectorWorkspace); } });
  const wrapper = mount(Host, { global: { stubs } });
  await table.refresh();
  await flushPromises();
  return wrapper;
}

const testid = (wrapper: VueWrapper, id: string) => wrapper.find(`[data-testid="${id}"]`);
const buttonNamed = (wrapper: VueWrapper, name: string) => wrapper.findAll('button').find(button => button.text() === name);

beforeEach(() => {
  vi.clearAllMocks();
  transport.subscribe.mockReturnValue(() => {});
  transport.command.mockResolvedValue({});
  transport.hideScenePicture.mockResolvedValue({});
  transport.showScenePicture.mockResolvedValue({});
  try { sessionStorage.clear(); } catch { /* no storage */ }
  window.history.replaceState({}, '', '/sessions/show/director');
});
afterEach(() => { document.body.innerHTML = ''; });

describe('director top bar', () => {
  it('is one row: title, state, lines waiting, pause, end, Cast & lobby and the warning chip', async () => {
    const wrapper = await mountWorkspace(snapshot());
    const bar = wrapper.get('[aria-label="Show bar"]');
    expect(bar.get('h1').text()).toBe('The Ledger Job');
    expect(testid(wrapper, 'show-state').text()).toBe('Live');
    expect(testid(wrapper, 'lines-waiting').text()).toBe('No lines waiting');
    expect(testid(wrapper, 'top-pause').text()).toBe('Pause show');
    expect(testid(wrapper, 'end-show').text()).toBe('End show');
    const link = bar.findAll('a').find(a => a.text() === 'Cast & lobby')!;
    expect(link.attributes('href')).toBe('/sessions/show/lobby');
    expect(link.classes()).toContain('quiet');
    expect(bar.find('[data-testid="status-strip-stub"]').exists()).toBe(true);
    expect(bar.findAll('h1')).toHaveLength(1);
    wrapper.unmount();
  });

  it('no longer has Go to beat, the Step chip or the beat count line', async () => {
    const wrapper = await mountWorkspace(snapshot());
    expect(buttonNamed(wrapper, 'Go to beat')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Step:');
    expect(wrapper.text()).not.toMatch(/\d+ published/);
    wrapper.unmount();
  });

  it('puts the scene title and its description fold above the beat column, outside the bar', async () => {
    const wrapper = await mountWorkspace(snapshot());
    const bar = wrapper.get('[aria-label="Show bar"]');
    expect(bar.text()).not.toContain('The Velvet Static');
    expect(bar.text()).not.toContain('Scene description');
    expect(testid(wrapper, 'scene-title').text()).toBe('The Velvet Static');
    const fold = wrapper.get('details.scene-description');
    expect(fold.text()).toContain('Find the missing ledger.');
    const html = wrapper.html();
    expect(html.indexOf('The Velvet Static')).toBeLessThan(html.indexOf('beat-panel-stub'));
    wrapper.unmount();
  });

  it('reads Live for the practice show that is still in the lobby, and lets it be paused', async () => {
    const wrapper = await mountWorkspace(snapshot('lobby'));
    expect(testid(wrapper, 'show-state').text()).toBe('Live');
    const pause = testid(wrapper, 'top-pause');
    expect(pause.text()).toBe('Pause show');
    expect(pause.attributes('disabled')).toBeUndefined();
    await pause.trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'paused', expectedStateRevision: 4 }));
    wrapper.unmount();
  });

  it('keeps pause off for a set-up show that has not started', async () => {
    const wrapper = await mountWorkspace(snapshot('lobby', [], { setup: { started: false } }));
    expect(testid(wrapper, 'top-pause').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('reads Paused with Resume show, and resume sends live', async () => {
    const wrapper = await mountWorkspace(snapshot('paused'));
    expect(testid(wrapper, 'show-state').text()).toBe('Paused');
    expect(testid(wrapper, 'top-pause').text()).toBe('Resume show');
    await testid(wrapper, 'top-pause').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'live' }));
    wrapper.unmount();
  });

  it.each([
    ['none', [], 'No lines waiting'],
    ['one', [submission('a')], '1 line waiting'],
    ['two, counting selected ones', [submission('a'), submission('b', 'act', 'selected')], '2 lines waiting'],
    ['only out-of-character, used or dismissed ones', [submission('a', 'ooc'), submission('b', 'say', 'used'), submission('c', 'say', 'dismissed')], 'No lines waiting'],
  ])('counts lines waiting: %s', async (_label, submissions, text) => {
    const wrapper = await mountWorkspace(snapshot('live', submissions));
    expect(testid(wrapper, 'lines-waiting').text()).toBe(text);
    wrapper.unmount();
  });
});

describe('ending the show', () => {
  it('asks first and Keep going cancels without sending anything', async () => {
    const wrapper = await mountWorkspace(snapshot());
    expect(testid(wrapper, 'end-show-confirm-row').exists()).toBe(false);
    await testid(wrapper, 'end-show').trigger('click');
    const row = testid(wrapper, 'end-show-confirm-row');
    expect(row.text()).toContain("End the show? Players will see that it's over, and it can't be restarted.");
    expect(testid(wrapper, 'end-show-confirm').text()).toBe('End show');
    await testid(wrapper, 'end-show-keep').trigger('click');
    expect(testid(wrapper, 'end-show-confirm-row').exists()).toBe(false);
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('sends set_status ended with the current revision when confirmed, then shows the ended view', async () => {
    const wrapper = await mountWorkspace(snapshot());
    await testid(wrapper, 'end-show').trigger('click');
    transport.snapshot.mockResolvedValue(snapshot('ended'));
    await testid(wrapper, 'end-show-confirm').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'ended', expectedStateRevision: 4 }));
    expect(testid(wrapper, 'show-state').text()).toBe('Ended');
    expect(testid(wrapper, 'end-show-confirm-row').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the server's refusal in the bar, not as the page error", async () => {
    const wrapper = await mountWorkspace(snapshot());
    transport.command.mockRejectedValue(new Error('Publish or abandon the beat in progress before ending the show.'));
    await testid(wrapper, 'end-show').trigger('click');
    await testid(wrapper, 'end-show-confirm').trigger('click');
    await flushPromises();
    const message = testid(wrapper, 'end-show-error');
    expect(message.text()).toBe('Publish or abandon the beat in progress before ending the show.');
    expect(message.attributes('role')).toBe('alert');
    expect(wrapper.get('[aria-label="Show bar"]').find('[data-testid="end-show-error"]').exists()).toBe(true);
    expect(table.error.value).toBe('');
    await testid(wrapper, 'end-show-keep').trigger('click');
    expect(testid(wrapper, 'end-show-error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('after the end has no pause, end, beat panel, queue or pause notices, and the gallery sits right below the bar', async () => {
    const wrapper = await mountWorkspace(snapshot('ended', [submission('p', 'ooc', 'queued')].map(item => ({ ...item, text: PAUSE_TEXT }))));
    expect(testid(wrapper, 'top-pause').exists()).toBe(false);
    expect(testid(wrapper, 'end-show').exists()).toBe(false);
    expect(wrapper.find('[data-testid="beat-panel-stub"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="DirectorQueue-stub"]').exists()).toBe(false);
    expect(wrapper.find('.pause-notice').exists()).toBe(false);
    expect(wrapper.get('[aria-label="Show bar"]').findAll('a').some(a => a.text() === 'Cast & lobby')).toBe(true);
    const gallery = wrapper.get('[data-testid="ended-gallery"]');
    expect(gallery.find('[data-testid="gallery-stub"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="gallery-stub"]')).toHaveLength(1);
    expect(wrapper.get('[aria-label="Show bar"]').element.nextElementSibling).toBe(gallery.element);
    expect(gallery.element.nextElementSibling).toBe(wrapper.get('[data-testid="director-controls"]').element);
    wrapper.unmount();
  });

  it('has no warning chip strip after the end, and keeps it before', async () => {
    const live = await mountWorkspace(snapshot());
    expect(live.find('[data-testid="status-strip-stub"]').exists()).toBe(true);
    live.unmount();
    const ended = await mountWorkspace(snapshot('ended'));
    expect(ended.find('[data-testid="status-strip-stub"]').exists()).toBe(false);
    ended.unmount();
  });

  it('has no gallery panel before the end, and keeps the beat panel, queue and pause notices', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [{ ...submission('p', 'ooc'), text: PAUSE_TEXT }]));
    expect(wrapper.find('[data-testid="gallery-stub"]').exists()).toBe(false);
    expect(testid(wrapper, 'ended-gallery').exists()).toBe(false);
    expect(wrapper.find('[data-testid="beat-panel-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="DirectorQueue-stub"]').exists()).toBe(true);
    expect(wrapper.find('.pause-notice').text()).toContain('Skooty asked for a pause.');
    wrapper.unmount();
  });
});

describe('wiring to the beat panel and the audio panel', () => {
  it("passes the status strip's audio state to the beat panel as show-audio", async () => {
    const wrapper = await mountWorkspace(snapshot());
    const beatPanel = wrapper.getComponent({ name: 'BeatPanel' });
    expect(beatPanel.props('showAudio')).toBe('checking');
    wrapper.getComponent({ name: 'DirectorStatusStrip' }).vm.$emit('audio', 'none');
    await flushPromises();
    expect(beatPanel.props('showAudio')).toBe('none');
    wrapper.getComponent({ name: 'DirectorStatusStrip' }).vm.$emit('audio', 'presenting');
    await flushPromises();
    expect(beatPanel.props('showAudio')).toBe('presenting');
    wrapper.unmount();
  });

  it("sets the audio panel's auto-play id only for a voiced publish", async () => {
    const wrapper = await mountWorkspace(snapshot());
    const audio = wrapper.getComponent({ name: 'AudioPanel' });
    const beatPanel = wrapper.getComponent({ name: 'BeatPanel' });
    expect(audio.props('autoPlayBeatId')).toBeNull();
    expect(audio.props('director')).toBe(true);
    beatPanel.vm.$emit('published', 'beat-2', false);
    await flushPromises();
    expect(audio.props('autoPlayBeatId')).toBeNull();
    beatPanel.vm.$emit('published', 'beat-3', true);
    await flushPromises();
    expect(audio.props('autoPlayBeatId')).toBe('beat-3');
    wrapper.unmount();
  });
});

describe('ticked lines', () => {
  const selectedIds = (wrapper: VueWrapper) => wrapper.getComponent({ name: 'BeatPanel' }).props('selected') as string[];
  const pushSnapshot = async (state: ReturnType<typeof snapshot>) => { transport.snapshot.mockResolvedValue(state); await table.refresh(); await flushPromises(); };

  it('ticks queued and selected in-character lines in the first snapshot, never questions or pause requests', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [submission('a'), submission('b', 'act', 'selected'), submission('q', 'ooc'), { ...submission('p', 'ooc'), text: PAUSE_TEXT }, submission('u', 'say', 'used')]));
    expect(selectedIds(wrapper)).toEqual(['a', 'b']);
    wrapper.unmount();
  });

  it('ticks lines that arrive later and keeps them in snapshot order', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [submission('a')]));
    await pushSnapshot(snapshot('live', [submission('c'), submission('a'), submission('q', 'ooc'), submission('b')]));
    expect(selectedIds(wrapper)).toEqual(['c', 'a', 'b']);
    wrapper.unmount();
  });

  it('keeps a line the director unticked unticked through later snapshots', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
    wrapper.getComponent({ name: 'DirectorQueue' }).vm.$emit('update:modelValue', ['b']);
    await flushPromises();
    expect(selectedIds(wrapper)).toEqual(['b']);
    await pushSnapshot(snapshot('live', [submission('a'), submission('b'), submission('d')]));
    expect(selectedIds(wrapper)).toEqual(['b', 'd']);
    await pushSnapshot(snapshot('live', [submission('a'), submission('b'), submission('d')]));
    expect(selectedIds(wrapper)).toEqual(['b', 'd']);
    wrapper.unmount();
  });

  it('drops lines that are no longer pending', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
    await pushSnapshot(snapshot('live', [submission('a'), submission('b', 'say', 'used')]));
    expect(selectedIds(wrapper)).toEqual(['a']);
    wrapper.unmount();
  });
});

describe('unticked lines survive a reload', () => {
  const selectedIds = (wrapper: VueWrapper) => wrapper.getComponent({ name: 'BeatPanel' }).props('selected') as string[];

  it('keeps an unticked line unticked after the page is mounted again, and ticks new lines', async () => {
    const first = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
    first.getComponent({ name: 'DirectorQueue' }).vm.$emit('update:modelValue', ['b']);
    await flushPromises();
    expect(JSON.parse(sessionStorage.getItem('story-table-unticked:show')!)).toEqual(['a']);
    first.unmount();
    const second = await mountWorkspace(snapshot('live', [submission('a'), submission('b'), submission('c')]));
    expect(selectedIds(second)).toEqual(['b', 'c']);
    second.unmount();
  });

  it('forgets a line that is ticked again', async () => {
    const first = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
    first.getComponent({ name: 'DirectorQueue' }).vm.$emit('update:modelValue', ['b']);
    await flushPromises();
    first.getComponent({ name: 'DirectorQueue' }).vm.$emit('update:modelValue', ['b', 'a']);
    await flushPromises();
    expect(JSON.parse(sessionStorage.getItem('story-table-unticked:show')!)).toEqual([]);
    first.unmount();
    const second = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
    expect(selectedIds(second)).toEqual(['a', 'b']);
    second.unmount();
  });

  it('works when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const wrapper = await mountWorkspace(snapshot('live', [submission('a'), submission('b')]));
      expect(selectedIds(wrapper)).toEqual(['a', 'b']);
      wrapper.getComponent({ name: 'DirectorQueue' }).vm.$emit('update:modelValue', ['b']);
      await flushPromises();
      expect(selectedIds(wrapper)).toEqual(['b']);
      wrapper.unmount();
    } finally { getItem.mockRestore(); setItem.mockRestore(); }
  });
});

describe('hiding the picture while a chain runs', () => {
  const chainBeat = (phase: string, revision: number, extra: Record<string, unknown> = {}) => ({
    id: 'beat-2', sessionId: 'show', kind: 'conversation', phase, revision, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: phase === 'collecting' ? [] : ['a'], lockedSubmissions: [], contracts: [], classification: 'ordinary', stakesApproved: false, inputSnapshotHash: null,
    resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null, ...extra,
  });

  it('keeps Hide picture working during Answer these lines, and the chain still finishes', async () => {
    const branch = (publicText: string) => ({ publicText, effects: [] });
    const contract = {
      id: '33333333-3333-4333-8333-333333333333', version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], submissionIds: ['a'], ruling: 'check', intent: 'Open the door.', approach: 'Shoulder it.', trait: 'force', edge: 0, edgeReason: null, risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: { clean: branch('It opens.'), costly: branch('It opens, loudly.'), setback: branch('It holds.'), critical: branch('The frame splinters on top of you.') },
    };
    const states: Record<string, Record<string, unknown>> = {
      open_beat: chainBeat('collecting', 1),
      plan_beat: chainBeat('stakes_review', 2, { classification: 'action', contracts: [contract] }),
    };
    const picture = { state: 'ready', imageId: 'img-1', hidden: false };
    let current = snapshot('live', [submission('a')], { picturesEnabled: true, scenePictureStatus: picture, activeBeat: null });
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    transport.snapshot.mockImplementation(async () => current);
    transport.command.mockImplementation(async (_id: string, command: { type: string }) => {
      if (command.type === 'open_beat') await gate;
      current = { ...current, activeBeat: states[command.type] } as never;
      return {};
    });
    transport.hideScenePicture.mockImplementation(async () => { current = { ...current, scenePictureStatus: { ...picture, hidden: true } } as never; return {}; });
    const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(DirectorWorkspace); } });
    const wrapper = mount(Host, { global: { stubs: { ...stubs, BeatPanel: false, ScenePicturePanel: false, DraftAudioPanel: stub('DraftAudioPanel') } } });
    await table.refresh();
    await flushPromises();

    await testid(wrapper, 'answer-lines').trigger('click');
    await flushPromises();
    expect(table.busy.value).toBe(true);
    const hide = testid(wrapper, 'scene-picture-hide');
    expect(hide.attributes('disabled')).toBeUndefined();
    await hide.trigger('click');
    await flushPromises();
    expect(transport.hideScenePicture).toHaveBeenCalledWith('show');
    expect(testid(wrapper, 'scene-picture-show').exists()).toBe(true);
    expect(table.busy.value).toBe(true);

    openGate();
    await flushPromises();
    expect(transport.command.mock.calls.map(call => call[1].type)).toEqual(['open_beat', 'plan_beat']);
    expect(table.busy.value).toBe(false);
    expect(table.error.value).toBe('');
    expect(testid(wrapper, 'approve-and-roll').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows a failed hide as the page error and lets the button work again', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { picturesEnabled: true, scenePictureStatus: { state: 'ready', imageId: 'img-1', hidden: false } }));
    transport.hideScenePicture.mockRejectedValueOnce(new Error('The picture could not be hidden.'));
    wrapper.getComponent({ name: 'ScenePicturePanel' }).vm.$emit('hide');
    await flushPromises();
    expect(table.error.value).toBe('The picture could not be hidden.');
    wrapper.getComponent({ name: 'ScenePicturePanel' }).vm.$emit('hide');
    await flushPromises();
    expect(transport.hideScenePicture).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

describe('narration that does not start after a voiced publish', () => {
  const playbackId = '11111111-1111-4111-8111-111111111111';
  const manifest = { beatId: 'beat-1', segments: [{ id: 'one', text: 'Rain falls.', speaker: 'Narrator', voiceProfileId: 'narrator', url: `/api/sessions/show/audio/assets/${'a'.repeat(64)}` }] };
  const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data }) as Response;
  const startCommands = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/commands'));
  let startFails = true;

  beforeEach(() => {
    startFails = true;
    const shared = { schemaVersion: 1, sessionId: 'show', revision: 0, sampleRevision: 0, serverTimeMs: 100_000, playbackId: null, status: 'idle', manifest: null, segmentIndex: null, positionMs: 0, anchorTimeMs: null, presenter: { available: true, leaseExpiresAtMs: 110_000 } };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/audio/')) return response({ status: 'ready', manifest });
      if (url.endsWith('/commands')) {
        if (startFails) return response({ message: 'The presenter went away.' }, false);
        return response({ snapshot: { ...shared, revision: 1, sampleRevision: 1, playbackId, manifest, status: 'playing', segmentIndex: 0, anchorTimeMs: 100_000 } });
      }
      return response(shared);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const beatPanelStub = {
    name: 'BeatPanel', props: ['selected', 'showAudio', 'playbackError'], emits: ['published', 'start-playback'],
    template: '<p v-if="playbackError" data-testid="playback-error" role="alert">{{ playbackError }} <button data-testid="start-playback" @click="$emit(\'start-playback\')">Play latest reviewed beat</button></p>',
  };

  it('shows one line in the beat bar, tries again from its button, and clears it on the next publish', async () => {
    transport.snapshot.mockResolvedValue(snapshot('live', [], { history: [{ id: 'beat-1', segments: [] }] }));
    const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(DirectorWorkspace); } });
    const wrapper = mount(Host, { global: { stubs: { ...stubs, AudioPanel: false, BeatPanel: beatPanelStub } } });
    await table.refresh();
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.findComponent({ name: 'AudioPanel' }).exists()).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(testid(wrapper, 'playback-error').exists()).toBe(false);

    wrapper.getComponent({ name: 'BeatPanel' }).vm.$emit('published', 'beat-1', true);
    await vi.waitFor(() => expect(testid(wrapper, 'playback-error').exists()).toBe(true));
    expect(testid(wrapper, 'playback-error').text()).toContain('The narration did not start. The presenter went away.');
    expect(startCommands()).toHaveLength(1);

    await testid(wrapper, 'start-playback').trigger('click');
    await vi.waitFor(() => expect(startCommands()).toHaveLength(2));
    await vi.waitFor(() => expect(testid(wrapper, 'playback-error').text()).toContain('The narration did not start. The presenter went away.'));

    startFails = false;
    wrapper.getComponent({ name: 'BeatPanel' }).vm.$emit('published', 'beat-2', false);
    await flushPromises();
    expect(testid(wrapper, 'playback-error').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('On the stage and Show tools', () => {
  const published = (segments: Array<Record<string, unknown>>) => [{ id: 'beat-1', beatNumber: 1, kind: 'conversation', actionRoundNumber: 0, rolls: [], outcomes: [], segments }];

  it('says Nothing published yet when there is no beat', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { history: [] }));
    expect(testid(wrapper, 'stage-first-line').text()).toBe('Nothing published yet.');
    wrapper.unmount();
  });

  it('shows the first line of the latest beat, named the way the story names speakers', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { history: [
      ...published([{ id: 's0', kind: 'narration', text: 'Old news.' }]),
      { ...published([])[0], id: 'beat-2', segments: [{ id: 's1', kind: 'dialogue', text: 'You are late.', speaker: { displayName: 'Old Tom' } }, { id: 's2', kind: 'narration', text: 'Second.' }] },
    ] }));
    expect(testid(wrapper, 'stage-first-line').text()).toBe('Old Tom: You are late.');
    wrapper.unmount();
    const narrated = await mountWorkspace(snapshot('live', [], { history: published([{ id: 's1', kind: 'narration', text: 'Rain falls.' }]) }));
    expect(testid(narrated, 'stage-first-line').text()).toBe('Narrator: Rain falls.');
    narrated.unmount();
  });

  it('names a system line The show', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { history: published([{ id: 's1', kind: 'system', text: 'The show was paused.' }]) }));
    expect(testid(wrapper, 'stage-first-line').text()).toBe('The show: The show was paused.');
    wrapper.unmount();
  });

  it('keeps Show all closed, with Story and a mounted audio panel inside it', async () => {
    const wrapper = await mountWorkspace(snapshot());
    const fold = testid(wrapper, 'stage-show-all');
    expect(fold.element.tagName).toBe('DETAILS');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('Show all');
    expect(fold.find('[data-testid="Story-stub"]').exists()).toBe(true);
    expect(fold.find('[data-testid="audio-panel-stub"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps Show tools closed with every tool mounted in the listed order', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], {
      tracks: [{ id: 't', kind: 'clock', label: 'Heat', current: 1, max: 4, enabled: true }],
      facts: [{ id: 'f', text: 'The safe is empty.' }],
      npcDetails: [{ id: 'n', displayName: 'Old Tom', role: 'Barkeep', status: 'present', goal: '', secrets: [], knowledge: [] }],
      directorNotes: 'Notes here.',
    }));
    const fold = testid(wrapper, 'show-tools');
    expect(fold.element.tagName).toBe('DETAILS');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('Show tools');
    const html = fold.html();
    const order = ['LiveControls-stub', 'CorrectionControls-stub', 'BeatSteering-stub', 'OperationsPanel-stub', 'In the room', 'Scenario notes', 'Known to the party', 'Live state', 'The cast'].map(token => html.indexOf(token));
    expect(order.every(position => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    wrapper.unmount();
  });

  it('after On the stage, with the right column holding only the scene picture', async () => {
    const wrapper = await mountWorkspace(snapshot());
    const html = wrapper.html();
    expect(html.indexOf('On the stage')).toBeLessThan(html.indexOf('data-testid="show-tools"'));
    const columns = wrapper.get('[data-testid="director-controls"]').element.children;
    expect(columns).toHaveLength(3);
    expect(columns[2].children).toHaveLength(1);
    expect(columns[2].querySelector('[data-testid="ScenePicturePanel-stub"]')).not.toBeNull();
    expect(columns[0].querySelector('[data-testid="DirectorQueue-stub"]')).not.toBeNull();
    wrapper.unmount();
  });
});

describe('full countdown notice', () => {
  const track = (over: Record<string, unknown> = {}) => ({ id: 't1', kind: 'countdown', label: 'Closing time', current: 4, max: 4, enabled: true, completionText: 'The doors lock.', ...over });
  const notices = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="countdown-full"]');

  it('shows the label, the completion text and the call line for a full enabled countdown', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track()] }));
    const found = notices(wrapper);
    expect(found).toHaveLength(1);
    expect(found[0].text()).toContain('The countdown “Closing time” is full.');
    expect(found[0].text()).toContain('When it fills: The doors lock.');
    expect(found[0].text()).toContain('What happens next is your call.');
    expect(found[0].attributes('aria-live')).toBe('polite');
  });

  it('drops the completion line when the text is blank', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track({ completionText: '   ' })] }));
    expect(notices(wrapper)).toHaveLength(1);
    expect(notices(wrapper)[0].text()).not.toContain('When it fills');
    expect(notices(wrapper)[0].text()).toContain('What happens next is your call.');
  });

  it('quotes the label so no word is doubled', async () => {
    for (const [label, sentence] of [['The 4:00 AM Countdown', 'The countdown “The 4:00 AM Countdown” is full.'], ['Countdown to dawn', 'The countdown “Countdown to dawn” is full.'], ['  Until 4:00 AM ', 'The countdown “Until 4:00 AM” is full.']]) {
      const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track({ label })] }));
      expect(notices(wrapper)[0].text()).toContain(sentence);
      expect(notices(wrapper)[0].text()).not.toMatch(/\bthe the\b|countdown countdown/i);
    }
  });

  it('adds a full stop to completion text with no closing punctuation', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track({ completionText: 'The doors lock' })] }));
    expect(notices(wrapper)[0].text()).toContain('When it fills: The doors lock. What happens next is your call.');
  });

  it('leaves completion text that already ends in punctuation alone', async () => {
    for (const text of ['The doors lock!"', 'Who locked them?)', 'The doors lock…']) {
      const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track({ completionText: text })] }));
      expect(notices(wrapper)[0].text()).toContain(`When it fills: ${text} What happens next is your call.`);
    }
  });

  it('shows nothing for not-full, disabled, danger or progress tracks', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track({ current: 3 }), track({ id: 't2', enabled: false }), track({ id: 't3', kind: 'danger' }), track({ id: 't4', kind: 'progress' })] }));
    expect(notices(wrapper)).toHaveLength(0);
  });

  it('shows nothing once the show has ended', async () => {
    const wrapper = await mountWorkspace(snapshot('ended', [], { tracks: [track()] }));
    expect(notices(wrapper)).toHaveLength(0);
  });

  it('shows two notices for two full countdowns', async () => {
    const wrapper = await mountWorkspace(snapshot('live', [], { tracks: [track(), track({ id: 't2', label: 'Dawn' })] }));
    expect(notices(wrapper)).toHaveLength(2);
  });
});
