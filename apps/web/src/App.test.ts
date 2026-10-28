// @vitest-environment jsdom
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import FieldGenerator from './FieldGenerator.vue';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn(), me: vi.fn(), producers: vi.fn(), producerLink: vi.fn(), createProducer: vi.fn(), revokeProducer: vi.fn(), producerSignIn: vi.fn(), streamLinks: vi.fn(), createStreamLink: vi.fn(), streamLink: vi.fn(), revokeStreamLink: vi.fn(), streamAccess: vi.fn(), invites: vi.fn(), inviteLink: vi.fn(), reissueInvite: vi.fn(), playback: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));
const nav = vi.hoisted(() => ({ navigate: vi.fn(), clearIdentity: vi.fn() }));
vi.mock('./navigate', () => nav);

function snapshot(role = 'stage') {
  return {
    schemaVersion: 1, role, eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [], npcs: [], tracks: [], facts: [], activeBeat: null,
    history: [{ id: 'beat-1', number: 1, kind: 'conversation', segments: [{ id: 'line-1', kind: 'npc_dialogue', speaker: { entityId: 'mara', displayName: 'Mara Vale' }, text: '<img src=x onerror="alert(1)"> Tell me why.', order: 0 }], rolls: [] }],
    ...(role === 'director' ? { submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: 'Secret ledger location' } : {}),
    ...(role === 'player' ? { ownCharacter: { id: 'pc-1', displayName: 'Skooty', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 0 }, submissions: [] } : {}),
  };
}

function draftBeat() {
  return {
    id: 'beat-2', sessionId: 'show', kind: 'conversation', phase: 'draft_review', revision: 3,
    inputEpoch: 1, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions: [], contracts: [],
    stakesApproved: true, classification: 'ordinary', inputSnapshotHash: 'hash', resolution: { rolls: [], outcomes: [], effects: [] },
    draft: { segments: [{ kind: 'narration', speakerNpcId: null, text: 'Mara folds her arms.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [{ kind: 'world_fact', factId: 'fact-1', text: 'The ledger has a buyer.', visibility: 'public', sourceSubmissionIds: ['say-1'] }], directorSummary: 'Private summary.' },
    draftRevision: 1, approvedContinuity: [], generation: 1, lastError: null,
  };
}

function scriptSnapshot() {
  return { ...snapshot('director'), npcs: [{ id: 'mara', displayName: 'Mara', role: 'Bartender', status: 'present' }], activeBeat: {
    id: 'beat-2', kind: 'conversation', phase: 'draft_review', revision: 3, selectedSubmissionIds: [],
    contracts: [], classification: 'ordinary', stakesApproved: true, resolution: { rolls: [], outcomes: [], effects: [] },
    draft: { segments: [
      { kind: 'narration', speakerNpcId: null, text: 'The room falls silent.', recipientCharacterIds: [], delivery: 'neutral' },
      { kind: 'npc_dialogue', speakerNpcId: 'mara', text: 'Who sent you?', recipientCharacterIds: [], delivery: 'neutral' },
    ], continuity: [], directorSummary: '' }, draftRevision: 1, lastError: null,
  } };
}

const voiceStub = { name: 'DraftAudioPanel', props: ['sessionId', 'beatId', 'beatRevision', 'draftRevision', 'generation', 'dirty', 'busy', 'rendering'], emits: ['voice'], template: '<div />' };

async function openRow(wrapper: Pick<DOMWrapper<Element>, 'get'>, index: number) {
  await wrapper.get(`[data-testid="script-line-${index}"]`).trigger('click');
}

async function generate(container: Pick<DOMWrapper<Element>, 'get'>, seed = 'A quiet introduction') {
  await container.get('[data-testid="field-generator-open"]').trigger('click');
  await container.get('[data-testid="field-generator-seed"]').setValue(seed);
  await container.get('[data-testid="field-generator-generate"]').trigger('click');
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.subscribe.mockReturnValue(() => {});
  transport.command.mockResolvedValue({});
  const unavailable = () => Promise.reject(new Error('Not available'));
  transport.me.mockRejectedValue(new Error('Sign in'));
  transport.producers.mockResolvedValue({ producers: [] });
  transport.streamLinks.mockResolvedValue({ links: [] });
  transport.invites.mockResolvedValue({ invites: [] });
  for (const name of ['producerLink', 'createProducer', 'revokeProducer', 'producerSignIn', 'createStreamLink', 'streamLink', 'revokeStreamLink', 'streamAccess', 'inviteLink', 'reissueInvite', 'playback'] as const) transport[name].mockImplementation(unavailable);
  window.history.replaceState({}, '', '/sessions/show/stage');
});
afterEach(() => { document.body.innerHTML = ''; sessionStorage.clear(); });

describe('public performance and player authority', () => {
  it.each(['director', 'player', 'stage'])('shows session operations only in the director workspace, including before a beat (%s)', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue({ ...snapshot(role), history: [] });
    const wrapper = mount(App, { global: { stubs: { OperationsPanel: { name: 'OperationsPanel', props: ['sessionId'], template: '<section />' } } } });
    await flushPromises();
    const panel = wrapper.findComponent({ name: 'OperationsPanel' });
    expect(panel.exists()).toBe(role === 'director');
    if (role === 'director') expect(panel.props('sessionId')).toBe('show');
    wrapper.unmount();
  });

  it('prepares private audio only for the director and publishes the saved recording through the gold Publish button', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...scriptSnapshot(), activeBeat: { ...scriptSnapshot().activeBeat, generation: 4 } });
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: voiceStub } } });
    await flushPromises();
    const panel = wrapper.getComponent({ name: 'DraftAudioPanel' });
    expect(panel.props()).toMatchObject({ sessionId: 'show', beatId: 'beat-2', beatRevision: 3, draftRevision: 1, generation: 4, dirty: false, busy: false, rendering: false });
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Preparing voice…');
    panel.vm.$emit('voice', { status: 'ready', preparationId: '11111111-1111-4111-8111-111111111111' }); await flushPromises();
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Publish');
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', draftRevision: 1, textOnly: false, audioPreparationId: '11111111-1111-4111-8111-111111111111' }));
    await openRow(wrapper, 0);
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Unsaved words.');
    expect(panel.props('dirty')).toBe(true);
    transport.command.mockClear();
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Publish');
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="publish-text-only"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(['stage', 'player'])('does not mount private draft audio in the %s view', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue(snapshot(role));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.findComponent({ name: 'DraftAudioPanel' }).exists()).toBe(false);
    wrapper.unmount();
  });

  it('retains text-only publication through Publish without voice', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: voiceStub } } }); await flushPromises();
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('voice', { status: 'preparing' }); await flushPromises();
    await wrapper.get('[data-testid="publish-text-only"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: true }));
    expect(transport.command.mock.calls.at(-1)?.[1]).not.toHaveProperty('audioPreparationId');
    wrapper.unmount();
  });

  it('publishes text only from the gold button, and hides Publish without voice, when no voice is available', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: voiceStub } } }); await flushPromises();
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('voice', { status: 'unavailable' }); await flushPromises();
    expect(wrapper.find('[data-testid="publish-text-only"]').exists()).toBe(false);
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: true }));
    wrapper.unmount();
  });

  it('allows a manual script that superseded an older render to be reviewed and published', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...scriptSnapshot(), activeBeat: { ...scriptSnapshot().activeBeat, generation: 5 }, jobs: [{ beatId: 'beat-2', task: 'render', status: 'running', generation: 4 }] });
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: { name: 'DraftAudioPanel', props: ['rendering'], template: '<div />' } } } });
    await flushPromises();
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('rendering')).toBe(false);
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
  it.each(['director', 'stage'])('keeps session audio available before publication in the %s view', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue({ ...snapshot(role), history: [] });
    const wrapper = mount(App, { global: { stubs: { AudioPanel: { name: 'AudioPanel', props: { sessionId: String, beatId: String, director: Boolean, stage: Boolean, compact: Boolean }, template: '<div />' } } } });
    await flushPromises();
    const panel = wrapper.getComponent({ name: 'AudioPanel' });
    expect(panel.props('sessionId')).toBe('show');
    expect(panel.props('beatId')).toBeUndefined();
    expect(Boolean(panel.props('director'))).toBe(role === 'director');
    expect(Boolean(panel.props('stage'))).toBe(role === 'stage');
    expect(Boolean(panel.props('compact'))).toBe(false);
    wrapper.unmount();
  });

  it('gives the player view no shared audio panel, since each part of the story plays on its own', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    transport.snapshot.mockResolvedValue({ ...snapshot('player'), history: [] });
    const wrapper = mount(App, { global: { stubs: { AudioPanel: { name: 'AudioPanel', template: '<div />' } } } });
    await flushPromises();
    expect(wrapper.findComponent({ name: 'AudioPanel' }).exists()).toBe(false);
    wrapper.unmount();
  });

  it.each(['director', 'stage'])('shows older public correction notices in the %s view', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue({ ...snapshot(role), corrections: [{ id: 'correction', publishedBeatId: 'older', beatNumber: 1, stateRevision: 4, recordedAt: '2026-10-22T00:00:00Z', publicText: 'The door was already open.' }] });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.get('[aria-label="Published corrections"]').text()).toContain('The door was already open.');
    expect(wrapper.findComponent({ name: 'CorrectionControls' }).exists()).toBe(role === 'director');
    expect(wrapper.findComponent({ name: 'BeatSteering' }).exists()).toBe(role === 'director');
    wrapper.unmount();
  });

  it.each(['CorrectionControls', 'BeatSteering'])('handles %s failure without invoking the save callback and allows retry', async name => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.command.mockRejectedValueOnce(new Error('The table changed; reload before saving.'));
    const wrapper = mount(App); await flushPromises();
    const child = wrapper.getComponent({ name });
    const command = name === 'BeatSteering'
      ? { type: 'set_beat_steering', commandId: 'retry', beatId: 'beat-2', expectedBeatRevision: 3, text: 'Keep it quiet.' }
      : { type: 'record_correction', commandId: 'retry', expectedStateRevision: 0, publishedBeatId: 'beat-1', publicText: 'The door was open.', reason: 'Continuity repair.', changes: [], discardQueuedInput: true };
    const saved = vi.fn();
    child.vm.$emit('command', command, saved); await flushPromises();
    expect(saved).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('The table changed');
    child.vm.$emit('command', command, saved); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', command);
    expect(saved).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('shows one top bar and Step n of m instead of a step chip and Go to beat', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(snapshot('director'));
    const wrapper = mount(App);
    await flushPromises();
    const bar = wrapper.get('section.show-bar');
    expect(bar.get('h1').text()).toBe('The Ledger Job');
    expect(bar.get('[data-testid="show-state"]').text()).toBe('Live');
    expect(bar.get('[data-testid="lines-waiting"]').text()).toBe('No lines waiting');
    expect(bar.get('[data-testid="top-pause"]').text()).toBe('Pause show');
    expect(bar.get('[data-testid="end-show"]').text()).toBe('End show');
    expect(bar.findAll('a').some(link => link.text() === 'Cast & lobby' && link.attributes('href') === '/sessions/show/lobby')).toBe(true);
    expect(bar.find('.show-step').exists()).toBe(false);
    expect(wrapper.findAll('button').some(button => button.text() === 'Go to beat')).toBe(false);
    expect(wrapper.get('[data-testid="beat-step-count"]').text()).toBe('Step 1 of 5');
    const gold = wrapper.get('[aria-label="Beat actions"]').get('[data-testid="answer-lines"]');
    expect(gold.text()).toBe('Answer these lines');
    expect(gold.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('[aria-label="Beat actions"] button:not(.secondary):not(.quiet)').filter(button => !button.element.closest('details'))).toHaveLength(1);
    wrapper.unmount();
  });

  it('counts waiting lines, pauses and resumes from the top bar', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const submissions = [
      { id: 'say-1', characterId: 'pc-1', kind: 'say', text: 'Hello.', intent: '', approach: '', status: 'queued' },
      { id: 'ooc-1', characterId: 'pc-1', kind: 'ooc', text: 'Can we pause?', intent: '', approach: '', status: 'queued' },
    ];
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.get('[data-testid="lines-waiting"]').text()).toBe('1 line waiting');
    await wrapper.get('[data-testid="top-pause"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'paused' }));
    wrapper.unmount();
    const base = snapshot('director');
    transport.snapshot.mockResolvedValue({ ...base, submissions: [], session: { ...base.session, status: 'paused' } });
    const paused = mount(App); await flushPromises();
    expect(paused.get('[data-testid="show-state"]').text()).toBe('Paused');
    expect(paused.get('[data-testid="top-pause"]').text()).toBe('Resume show');
    expect(paused.get('[data-testid="resume-show"]').text()).toBe('Resume show');
    paused.unmount();
  });

  it('asks before ending the show, shows a refusal, and leaves only the gallery at the top after the end', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(snapshot('director'));
    transport.command.mockRejectedValueOnce(new Error('Publish or abandon the beat in progress before ending the show.'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('[data-testid="ended-gallery"]').exists()).toBe(false);
    await wrapper.get('[data-testid="end-show"]').trigger('click');
    expect(wrapper.get('[data-testid="end-show-confirm-row"]').text()).toContain("End the show? Players will see that it's over, and it can't be restarted.");
    await wrapper.get('[data-testid="end-show-keep"]').trigger('click');
    expect(wrapper.find('[data-testid="end-show-confirm-row"]').exists()).toBe(false);
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="end-show"]').trigger('click');
    await wrapper.get('[data-testid="end-show-confirm"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="end-show-error"]').text()).toBe('Publish or abandon the beat in progress before ending the show.');
    await wrapper.get('[data-testid="end-show-confirm"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'ended' }));
    wrapper.unmount();
    const base = snapshot('director');
    transport.snapshot.mockResolvedValue({ ...base, submissions: [], session: { ...base.session, status: 'ended' } });
    const ended = mount(App); await flushPromises();
    expect(ended.get('[data-testid="show-state"]').text()).toBe('Ended');
    expect(ended.find('[data-testid="ended-gallery"]').exists()).toBe(true);
    for (const id of ['top-pause', 'end-show']) expect(ended.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(ended.find('.beat-panel').exists()).toBe(false);
    expect(ended.findComponent({ name: 'DirectorQueue' }).exists()).toBe(false);
    ended.unmount();
  });

  it('turns off the non-player portrait buttons once the show has ended', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const npc = { id: 'mara', displayName: 'Mara Vale', role: 'Bartender', appearance: 'A woman in her forties.', status: 'present', goal: '', secrets: [], knowledge: [] };
    for (const status of ['live', 'ended']) {
      const base = snapshot('director');
      transport.snapshot.mockResolvedValue({ ...base, picturesEnabled: true, portraitJobs: [], npcDetails: [npc], session: { ...base.session, status } });
      const wrapper = mount(App);
      await flushPromises();
      expect(wrapper.get('[data-testid="npc-portrait-create"]').attributes('disabled'), status).toBe(status === 'ended' ? '' : undefined);
      wrapper.unmount();
    }
  });

  it('focuses the gold button of the beat bar when the beat panel is asked for focus', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const submissions = [{ id: 'say-1', characterId: 'pc-1', kind: 'say', text: 'Hello.', intent: '', approach: '', status: 'queued' }];
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions });
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    const wrapper = mount(App, { attachTo: document.body });
    try {
      await flushPromises();
      expect(wrapper.get('[data-testid="answer-lines"]').attributes('disabled')).toBeUndefined();
      (wrapper.getComponent({ name: 'BeatPanel' }).vm as unknown as { focusPrimary: () => void }).focusPrimary();
      expect(scroll).toHaveBeenCalled();
      expect(document.activeElement?.textContent).toContain('Answer these lines');
    } finally {
      Element.prototype.scrollIntoView = original;
      wrapper.unmount();
    }
  });

  it('opens the standalone character builder without requiring host or session access', async () => {
    window.history.replaceState({}, '', `/build-character?identity=${'a'.repeat(32)}#token=private-link`);
    const wrapper = mount(App, { global: { stubs: { PlayerBuilder: true } } });
    await flushPromises();
    expect(wrapper.findComponent({ name: 'PlayerBuilder' }).exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Host access token');
    expect(wrapper.find('a.brand').exists()).toBe(false);
    expect(transport.sessions).not.toHaveBeenCalled();
    expect(transport.snapshot).not.toHaveBeenCalled();
    expect(transport.subscribe).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows a failed script save in the beat bar without losing words and permits saving again', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.command.mockRejectedValueOnce(new Error('Could not save script.'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('[data-testid="save-script"]').exists()).toBe(false);
    await openRow(wrapper, 0);
    const draft = wrapper.get('[data-testid="script-segment-0"]');
    await draft.setValue('My unfinished narration.');
    expect(wrapper.get('[data-testid="beat-next"]').text()).toContain('Save your edits under More before publishing.');
    expect((wrapper.get('[data-testid="beat-more"]').element as HTMLDetailsElement).open).toBe(true);
    const save = wrapper.get('[data-testid="beat-more"] [data-testid="save-script"]');
    expect(save.text()).toBe('Save edits');
    await save.trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="beat-error"]').text()).toContain('Could not save script.');
    expect(wrapper.findComponent({ name: 'ErrorNotice' }).exists()).toBe(false);
    expect((draft.element as HTMLTextAreaElement).value).toBe('My unfinished narration.');
    await save.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="beat-error"]').exists()).toBe(false);
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: expect.arrayContaining([expect.objectContaining({ text: 'My unfinished narration.' })]) }));
    wrapper.unmount();
  });

  it('dismisses a welcome error while keeping the entered host token', async () => {
    window.history.replaceState({}, '', '/');
    transport.sessions.mockRejectedValueOnce(new Error('Sign in required.'));
    transport.login.mockRejectedValueOnce(new Error('Sign in failed.'));
    const wrapper = mount(App); await flushPromises();
    const token = wrapper.get('input[type="password"]');
    await token.setValue('unsaved-test-token');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    await wrapper.get('[role="alert"] button[aria-label="Dismiss error"]').trigger('click');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect((token.element as HTMLInputElement).value).toBe('unsaved-test-token');
    wrapper.unmount();
  });

  it('offers only the current scenario premise to manual script drafting, with explicit Apply before saving', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const current = scriptSnapshot();
    const premise = 'A clockwork city is losing time.';
    transport.snapshot.mockResolvedValue({ ...current, session: { ...current.session, brief: { premise, genre: 'Fantasy', tone: 'Mysterious', objectives: [], playerHooks: [], pacing: { conversationWords: 90, actionWords: 120 } } } });
    transport.generateField.mockResolvedValue({ text: 'A silent clock looms over the square.' });
    const wrapper = mount(App); await flushPromises();
    await openRow(wrapper, 0); await openRow(wrapper, 1);
    const controls = wrapper.findAllComponents(FieldGenerator).filter(control => String(control.props('field')).startsWith('script.'));
    expect(controls).toHaveLength(2);
    for (const control of controls) expect(control.props('premise')).toBe(premise);
    const control = controls[0];
    await control.get('[data-testid="field-generator-open"]').trigger('click');
    await control.get('[data-testid="field-generator-source"]').setValue('premise');
    await control.get('[data-testid="field-generator-hint"]').setValue('An ominous opening');
    await control.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(transport.generateField).toHaveBeenCalledExactlyOnceWith({ field: 'script.narration', seed: 'An ominous opening', premise });
    expect(JSON.stringify(transport.generateField.mock.calls)).not.toContain('Secret ledger location');
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    await control.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('A silent clock looms over the square.');
    expect(transport.command).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('keeps legacy scripts on custom descriptions when no scenario premise exists', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App); await flushPromises();
    await openRow(wrapper, 0);
    const control = wrapper.findAllComponents(FieldGenerator).find(control => control.props('field') === 'script.narration')!;
    await control.get('[data-testid="field-generator-open"]').trigger('click');
    expect(control.find('[data-testid="field-generator-source"]').exists()).toBe(false);
    expect((control.get('[data-testid="field-generator-seed"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    wrapper.unmount();
  });

  it('offers a signed-in host Try it now and Make a show, with no title box', async () => {
    window.history.replaceState({}, '', '/');
    transport.sessions.mockResolvedValue([]);
    transport.create.mockResolvedValue({ sessionId: 'new', invites: [] });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.get('[data-testid="make-a-show"]').text()).toBe('Make a show');
    expect(wrapper.get('[data-testid="make-a-show"]').attributes('href')).toBe('/make');
    expect(wrapper.get('[data-testid="library-link"]').text()).toBe('Library & custom shows');
    expect(wrapper.get('[data-testid="try-it-now"]').text()).toBe('Try it now');
    await wrapper.get('[data-testid="try-it-now"]').trigger('click'); await flushPromises();
    expect(transport.create).toHaveBeenCalledWith('The Ledger Job');
    expect(nav.navigate).toHaveBeenCalledWith('/sessions/new/director');
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders the Make a show page at /make without loading a session', async () => {
    window.history.replaceState({}, '', '/make');
    transport.library.mockResolvedValue({ scenarios: [], characters: [] });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.findComponent({ name: 'MakeShow' }).exists()).toBe(true);
    expect(wrapper.text()).toContain('Make a show');
    expect(wrapper.findComponent({ name: 'HostHome' }).exists()).toBe(false);
    expect(transport.snapshot).not.toHaveBeenCalled();
    expect(transport.sessions).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('applies generated narration and NPC dialogue only to unsaved script fields', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.generateField.mockResolvedValueOnce({ text: 'Dust settles over the empty chairs.' }).mockResolvedValueOnce({ text: 'Tell me who sent you.' });
    const wrapper = mount(App); await flushPromises();
    await openRow(wrapper, 0); await openRow(wrapper, 1);
    const rows = wrapper.findAll('.segment:has([data-testid^="script-segment-"])');
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const before = (row.get('textarea').element as HTMLTextAreaElement).value;
      await generate(row);
      expect(transport.generateField.mock.calls[index][0].field).toBe(index === 0 ? 'script.narration' : 'script.npcDialogue');
      expect((row.get('textarea').element as HTMLTextAreaElement).value).toBe(before);
      await row.get('[data-testid="field-generator-apply"]').trigger('click');
    }
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('Dust settles over the empty chairs.');
    expect((wrapper.get('[data-testid="script-segment-1"]').element as HTMLTextAreaElement).value).toBe('Tell me who sent you.');
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="save-script"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: [
      expect.objectContaining({ kind: 'narration', text: 'Dust settles over the empty chairs.' }),
      expect.objectContaining({ kind: 'npc_dialogue', text: 'Tell me who sent you.' }),
    ] }));
    wrapper.unmount();
  });

  it('discards a pending result when its script row is removed, even with identical remaining text', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const current = scriptSnapshot();
    current.activeBeat.draft.segments = [current.activeBeat.draft.segments[0], { ...current.activeBeat.draft.segments[0] }];
    transport.snapshot.mockResolvedValue(current);
    let resolve!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(result => { resolve = result; }));
    const wrapper = mount(App); await flushPromises();
    await openRow(wrapper, 0);
    const first = wrapper.findAll('.segment:has([data-testid^="script-segment-"])')[0]; await generate(first);
    await wrapper.get('[data-testid="script-remove-0"]').trigger('click');
    resolve({ text: 'Stale text from the removed row.' }); await flushPromises();
    expect(wrapper.findAll('.script-editor .segment')).toHaveLength(1);
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    await openRow(wrapper, 0);
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    expect(transport.command).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('discards pending script generation when an identical draft arrives at a new beat revision', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const current = scriptSnapshot(); transport.snapshot.mockResolvedValue(current);
    let resolve!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(result => { resolve = result; }));
    const wrapper = mount(App); await flushPromises();
    await openRow(wrapper, 0); await generate(wrapper.get('.segment:has([data-testid^="script-segment-"])'));
    transport.snapshot.mockResolvedValue({ ...current, activeBeat: { ...current.activeBeat, revision: 4 } });
    await transport.subscribe.mock.calls[0][1](); await flushPromises();
    resolve({ text: 'Stale text for the former revision.' }); await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    await openRow(wrapper, 0);
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    expect(transport.command).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('offers no field generation on player speech or action controls', async () => {
    window.history.replaceState({}, '', '/sessions/show/play'); transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    await wrapper.findAll('button').find(button => button.text() === 'Do something')!.trigger('click');
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('offers the native library from the host workspace and preserves its tab identity', async () => {
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    transport.sessions.mockResolvedValue([]);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="library-link"]').attributes('href')).toBe(`/library?identity=${'a'.repeat(32)}`);
    expect(wrapper.get('.brand').text()).toContain('The Story Table');
    wrapper.unmount();
  });

  it('holds custom-show director and player play controls until the lobby starts the session', async () => {
    for (const role of ['director', 'player']) {
      window.history.replaceState({}, '', `/sessions/show/${role === 'director' ? 'director' : 'play'}`);
      transport.snapshot.mockResolvedValue({ ...snapshot(role), setup: { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'scenario', version: 1 } } });
      const wrapper = mount(App);
      await flushPromises();
      expect(wrapper.find('[data-testid="open-conversation"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="submission-form"]').exists()).toBe(false);
      if (role === 'director') {
        expect(wrapper.get('[data-testid="setup-lobby-link"]').attributes('href')).toBe('/sessions/show/lobby');
        expect(wrapper.get('[data-testid="setup-lobby-link"]').text()).toBe('Open cast & lobby');
        expect(wrapper.text()).toContain('Before the show starts');
        expect(wrapper.get('h2').text()).toBe('Get your cast ready.');
        expect(wrapper.text()).toContain('Every seat needs a card. Start the show from Cast & lobby.');
        expect(wrapper.find('[data-testid="pre-show"]').exists()).toBe(false);
      } else {
        expect(wrapper.find('[data-testid="pre-show"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('The show will start soon.');
        expect(wrapper.find('[data-testid="setup-lobby-link"]').exists()).toBe(false);
        expect(wrapper.find('.scene-heading').exists()).toBe(false);
        expect(wrapper.find('[data-testid="public-facts"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('Known to the party');
        expect(wrapper.text()).not.toContain('Cast & lobby');
        expect(wrapper.findAll('button').some(button => button.text() === 'Ask for a pause')).toBe(false);
        expect(wrapper.text()).not.toContain('Review your cast and boundaries.');
      }
      wrapper.unmount();
    }
  });

  it('turns the pre-show page into the seat when the show starts, without a reload', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    const waiting = { ...snapshot('player'), setup: { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'scenario', version: 1 } } };
    const started = { ...snapshot('player'), setup: { ...waiting.setup, started: true } };
    transport.snapshot.mockResolvedValue(waiting);
    let onChange: () => void = () => {};
    transport.subscribe.mockImplementation((_id: string, changed: () => void) => { onChange = changed; return () => {}; });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('[data-testid="pre-show"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="submission-form"]').exists()).toBe(false);
    transport.snapshot.mockResolvedValue(started);
    onChange(); await flushPromises();
    expect(wrapper.find('[data-testid="pre-show"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="submission-form"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('words the connection notice for players', async () => {
    const lost = 'Connection lost. Your unsent words stay in this browser. The page reconnects by itself and never sends anything for you.';
    const interrupted = 'Connection interrupted. Unsaved words stay in this browser. Reconnect refreshes the show; it never sends them.';
    for (const role of ['player', 'director']) {
      window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
      transport.snapshot.mockResolvedValue(snapshot(role));
      const wrapper = mount(App); await flushPromises();
      expect(wrapper.text().includes(lost)).toBe(role === 'player');
      expect(wrapper.text().includes(interrupted)).toBe(role === 'director');
      wrapper.unmount();
    }
  });

  it('leaves the paused notice to the seat banner', async () => {
    const notice = 'The show is paused. Check in with the cast before continuing.';
    for (const role of ['player', 'director']) {
      window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
      const base = snapshot(role);
      transport.snapshot.mockResolvedValue({ ...base, session: { ...base.session, status: 'paused' } });
      const wrapper = mount(App); await flushPromises();
      expect(wrapper.text().includes(notice)).toBe(role === 'director');
      if (role === 'player') expect(wrapper.text()).toContain('The show is paused');
      wrapper.unmount();
    }
  });

  it('gives a player My stream view in Cast & lobby', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(snapshot('player'));
    const player = mount(App); await flushPromises();
    expect(player.find('#my-stream-view').exists()).toBe(true);
    expect(player.findAll('button').some(button => button.text() === 'Ask for a pause')).toBe(true);
    player.unmount();
    transport.snapshot.mockResolvedValue(snapshot('director'));
    const director = mount(App); await flushPromises();
    expect(director.find('#my-stream-view').exists()).toBe(false);
    director.unmount();
  });

  it('opens independent character rehearsal tabs from the director cast lobby', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/lobby?identity=${identity}`);
    const seats = [
      { id: 'pc-1', displayName: 'Rook', approved: true, strain: 0, appearance: 'A strong presence.', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: [] },
      { id: 'pc-2', displayName: 'Lark', approved: true, strain: 0, appearance: 'Always watching.', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: [] },
    ];
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), characters: seats, characterDetails: seats });
    const wrapper = mount(App);
    await flushPromises();
    const testLinks = wrapper.findAll('a').filter(link => link.text().startsWith('Test as '));
    expect(testLinks.map(link => link.text())).toEqual(['Test as Rook', 'Test as Lark']);
    for (const [index, link] of testLinks.entries()) {
      expect(link.attributes('href')).toBe(`/sessions/show/play?testCharacterId=pc-${index + 1}&identity=${identity}`);
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toBe('noopener');
    }
    expect(wrapper.get('.brand').attributes('href')).toBe(`/?identity=${identity}`);
    for (const link of wrapper.findAll('a')) expect(new URL(link.attributes('href')!, window.location.origin).searchParams.get('identity')).toBe(identity);
    wrapper.unmount();
  });

  it('does not offer test seats to a player or the public stage', async () => {
    for (const role of ['player', 'stage']) {
      window.history.replaceState({}, '', `/sessions/show/${role === 'stage' ? 'stage' : 'lobby'}`);
      transport.snapshot.mockResolvedValue({ ...snapshot(role), characters: [{ id: 'pc-1', displayName: 'Rook', approved: true, strain: 0 }] });
      const wrapper = mount(App);
      await flushPromises();
      expect(wrapper.text()).not.toContain('Test as ');
      wrapper.unmount();
    }
  });

  it('authorizes a requested rehearsal seat before loading state and leaves the host selector unchanged on failure', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/play?testCharacterId=pc-1&identity=${identity}`);
    transport.testSeat.mockRejectedValue(new Error('This session belongs to another host.'));
    transport.snapshot.mockResolvedValue(snapshot('director'));
    const wrapper = mount(App);
    await flushPromises();
    expect(transport.testSeat).toHaveBeenCalledWith('show', 'pc-1');
    expect(transport.snapshot).not.toHaveBeenCalled();
    expect(transport.subscribe).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('This session belongs to another host.');
    expect(window.location.search).toContain(`identity=${identity}`);
    expect(wrapper.find('[data-testid="director-controls"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('rejects a rehearsal response for a different character before adopting its identity', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/play?testCharacterId=pc-1&identity=${identity}`);
    transport.testSeat.mockResolvedValue({ role: 'player', sessionId: 'show', characterId: 'pc-2', identityId: 'b'.repeat(32) });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('The requested character seat could not be opened.');
    expect(window.location.search).toContain(`identity=${identity}`);
    expect(transport.snapshot).not.toHaveBeenCalled();
    expect(transport.subscribe).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('requests the stage projection and renders attributed dialogue as escaped text', async () => {
    transport.snapshot.mockResolvedValue(snapshot());
    const wrapper = mount(App);
    await flushPromises();
    expect(transport.snapshot).toHaveBeenCalledWith('show', 'stage');
    expect(wrapper.text()).toContain('Mara Vale');
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)"> Tell me why.');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="director-controls"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Secret ledger location');
    wrapper.unmount();
  });

  it('never exposes director controls on the stage route even with a host cookie', async () => {
    transport.snapshot.mockResolvedValue(snapshot('director'));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="director-controls"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Secret ledger location');
    wrapper.unmount();
  });

  it('requires the player to explicitly send exact speech, including after a reconnect', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="speech-input"]').setValue('I do not accept your deal.');
    const refresh = transport.subscribe.mock.calls[0][1];
    await refresh();
    await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="submission-form"]').trigger('submit');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'save_submission', kind: 'say', text: 'I do not accept your deal.', expectedSubmissionRevision: 0, expectedInputEpoch: 0, contextBeatId: null }));
    expect(transport.command).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('keeps the input window captured when typing instead of silently moving stale text to a new round', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    const current = snapshot('player');
    transport.snapshot.mockResolvedValue(current);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="speech-input"]').setValue('Wait for my signal.');
    transport.snapshot.mockResolvedValue({ ...current, session: { ...current.session, inputEpoch: 2 } });
    await transport.subscribe.mock.calls[0][1]();
    await flushPromises();
    await wrapper.get('[data-testid="submission-form"]').trigger('submit');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ expectedInputEpoch: 0, text: 'Wait for my signal.' }));
    wrapper.unmount();
  });

  it('renders only the form for players', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    const base = snapshot('player');
    const stake = { id: 'k1', version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], intent: 'Goal k1', approach: 'Carefully', ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'high', outcomes: { clean: 'Clean k1', costly: 'Costly k1', setback: 'Setback k1' } };
    transport.snapshot.mockResolvedValue({
      ...base,
      activeBeat: { id: 'b9', kind: 'action', phase: 'stakes_review', revision: 1, locked: false, stakes: [stake] },
      facts: [{ id: 'f1', text: 'The ledger is in the safe.' }],
      characters: [
        { id: 'pc-1', displayName: 'Skooty', approved: true, strain: 0, appearance: 'Quick hands.' },
        { id: 'pc-2', displayName: 'Lark', approved: true, strain: 2, appearance: 'Always watching.' },
      ],
      history: [{ ...base.history[0], rolls: [{ id: 'r1', actorCharacterId: 'pc-1', faces: [3, 4], traitModifier: 1, edge: false, total: 8, band: 'costly' }] }],
      corrections: [{ id: 'correction', publishedBeatId: 'older', beatNumber: 1, stateRevision: 4, recordedAt: '2026-10-22T00:00:00Z', publicText: 'The door was already open.' }],
    });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="submission-form"]').exists()).toBe(true);
    for (const selector of ['.wager', '[data-testid="public-facts"]', '[aria-label="Published story"]', '[aria-label="Published corrections"]', '.roll']) expect(wrapper.find(selector).exists(), selector).toBe(false);
    const text = wrapper.text();
    expect(text).toContain('Tell me why.');
    for (const absent of ['Goal k1', 'Clean k1', 'Lark', 'Strain', 'wits', 'The ledger is in the safe.', 'The door was already open.', 'Find the missing ledger.']) expect(text, absent).not.toContain(absent);
    wrapper.unmount();
  });

  it('requires saving script edits before publication and never provides an authoring control for player dialogue', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), activeBeat: draftBeat() });
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: voiceStub } } });
    await flushPromises();
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('voice', { status: 'preparing' }); await flushPromises();
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="save-script"]').exists()).toBe(false);
    await openRow(wrapper, 0);
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Mara sets the glass down.');
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="publish-text-only"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').some(button => button.text() === 'Approve continuity updates')).toBe(false);
    expect(wrapper.text()).not.toContain('Add player dialogue');
    expect(wrapper.find('[data-testid="script-add-line"]').text()).not.toContain('Skooty');
    await wrapper.get('[data-testid="beat-more"] [data-testid="save-script"]').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: [{ kind: 'narration', speakerNpcId: null, text: 'Mara sets the glass down.', recipientCharacterIds: [], delivery: 'neutral' }] }));
    wrapper.unmount();
  });

  it('keeps the proposed facts by default when publishing, and skips them when Don\'t keep these is ticked', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), activeBeat: draftBeat() });
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: voiceStub } } });
    await flushPromises();
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('voice', { status: 'unavailable' }); await flushPromises();
    const facts = wrapper.get('[data-testid="facts-to-remember"]');
    expect(facts.text()).toContain('Facts to remember');
    expect(facts.text()).toContain('The ledger has a buyer.');
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command.mock.calls.map(call => call[1].type)).toEqual(['approve_continuity', 'publish_beat']);
    expect(transport.command.mock.calls[0][1].updates).toHaveLength(1);
    transport.command.mockClear();
    await wrapper.get('[data-testid="skip-facts"]').setValue(true);
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command.mock.calls.map(call => call[1].type)).toEqual(['publish_beat']);
    wrapper.unmount();
  });

  it('lets a player explicitly review stale words for the current beat without submitting them', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    const current = snapshot('player');
    transport.snapshot.mockResolvedValue(current);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="speech-input"]').setValue('Mara, one more thing.');
    transport.snapshot.mockResolvedValue({ ...current, session: { ...current.session, inputEpoch: 3 } });
    await transport.subscribe.mock.calls[0][1]();
    await flushPromises();
    await wrapper.get('[data-testid="review-current-input"]').trigger('click');
    expect(transport.command).not.toHaveBeenCalled();
    expect((wrapper.get('[data-testid="speech-input"]').element as HTMLTextAreaElement).value).toBe('Mara, one more thing.');
    await wrapper.get('[data-testid="submission-form"]').trigger('submit');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ expectedInputEpoch: 3, text: 'Mara, one more thing.' }));
    wrapper.unmount();
  });

  it('lets the director explicitly escalate ordinary speech into editable action stakes', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const input = { id: 'say-1', characterId: 'pc-1', kind: 'say', text: 'Let us into the archive.', intent: '', approach: '', status: 'selected' };
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions: [input], activeBeat: {
      id: 'beat-2', kind: 'conversation', phase: 'stakes_review', revision: 2, selectedSubmissionIds: ['say-1'],
      contracts: [], classification: 'ordinary', stakesApproved: false, draft: null, lastError: null,
    } });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="stakes-cards"]').text()).toContain('Ordinary conversation: no dice, and nothing changes.');
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(false);
    await wrapper.get('[data-testid="stakes-ordinary-edit"]').trigger('click');
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action');
    expect(wrapper.get('[data-testid="approve-and-roll"]').text()).toBe('Approve and roll');
    expect(wrapper.find('[data-testid="contract-ruling"]').exists()).toBe(false);
    await wrapper.get('[data-testid^="stakes-edit-"]').trigger('click');
    expect(wrapper.find('[data-testid="contract-ruling"]').exists()).toBe(true);
    await wrapper.get('[data-testid="contract-ruling"]').setValue('no_check');
    await wrapper.get('[data-testid="outcome-clean"]').setValue('Access is granted.');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('Access is granted, but security notices.');
    await wrapper.get('[data-testid="outcome-setback"]').setValue('Access is refused; the guard asks them to leave.');
    await wrapper.get('[data-testid="beat-more"] [data-testid="approve-stakes"]').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'approve_stakes', classification: 'action', contracts: [expect.objectContaining({ actorCharacterId: 'pc-1', submissionIds: ['say-1'], ruling: 'no_check' })] }));
    wrapper.unmount();
  });

  it('requires explicit requeue review when the beat locks without changing the input epoch', async () => {
    window.history.replaceState({}, '', '/sessions/show/play');
    const current = { ...snapshot('player'), activeBeat: { id: 'beat-2', kind: 'conversation', phase: 'collecting', revision: 1, stakes: [], locked: false } };
    transport.snapshot.mockResolvedValue(current);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="speech-input"]').setValue('And what about the owner?');
    transport.snapshot.mockResolvedValue({ ...current, activeBeat: { ...current.activeBeat, phase: 'locked', locked: true } });
    await transport.subscribe.mock.calls[0][1]();
    await flushPromises();
    await wrapper.get('[data-testid="review-current-input"]').trigger('click');
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="submission-form"]').trigger('submit');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ expectedInputEpoch: 0, contextBeatId: null, text: 'And what about the owner?' }));
    wrapper.unmount();
  });

  it('offers manual stakes after planning failed and records a reason when abandoning the beat', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const input = { id: 'say-1', characterId: 'pc-1', kind: 'say', text: 'Let us into the archive.', intent: '', approach: '', status: 'selected' };
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions: [input], activeBeat: {
      id: 'beat-2', kind: 'conversation', phase: 'collecting', revision: 2, selectedSubmissionIds: ['say-1'],
      contracts: [], classification: null, stakesApproved: false, draft: null, lastError: 'The planner timed out.',
    } });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="stakes-cards"]').text()).toContain('Planning failed.');
    expect(wrapper.get('[data-testid="approve-and-roll"]').text()).toBe('Approve and roll');
    expect(wrapper.find('[data-testid="stakes-ordinary-edit"]').exists()).toBe(false);
    await wrapper.get('[data-testid^="stakes-edit-"]').trigger('click');
    await wrapper.get('[data-testid="stakes-classification"]').setValue('ordinary');
    await wrapper.get('[data-testid="beat-more"] [data-testid="approve-stakes"]').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'approve_stakes', classification: 'ordinary', contracts: [] }));
    expect(wrapper.get('[data-testid="abort-beat"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="abort-reason"]').setValue('We are changing the scene before resolving this input.');
    await wrapper.get('[data-testid="abort-beat"]').trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'abort_beat', beatId: 'beat-2', expectedBeatRevision: 2, reason: 'We are changing the scene before resolving this input.' }));
    wrapper.unmount();
  });
});


describe('field explanations', () => {
  const options = { global: { stubs: { FieldGenerator: true, LiveControls: true, AudioPanel: true } } };
  const editors = '.script-editor, .stakes-cards, [data-testid="steer-text"]';
  function checkHelp(wrapper: ReturnType<typeof mount>) {
    const controls = wrapper.findAll('input, select, textarea').filter(control => !control.element.closest(editors));
    expect(controls.length).toBeGreaterThan(0);
    const ids = controls.map(control => {
      const id = control.attributes('aria-describedby');
      expect(id, control.html()).toBeTruthy();
      expect(id).not.toMatch(/\s/);
      const matches = wrapper.findAll('[id]').filter(node => node.attributes('id') === id);
      expect(matches).toHaveLength(1);
      expect(matches[0].classes()).toContain('field-help');
      expect(matches[0].text().length).toBeGreaterThan(20);
      expect(matches[0].element.closest('label')).toBeNull();
      return id;
    });
    expect(new Set(ids).size).toBe(ids.length);
  }

  it('explains host authentication and leaves the signed-in home with no unexplained controls', async () => {
    window.history.replaceState({}, '', '/'); transport.sessions.mockRejectedValueOnce(new Error('Sign in'));
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    expect(wrapper.get('label').text()).toBe('Host access token');
    transport.sessions.mockResolvedValue([]); transport.login.mockResolvedValue({});
    await wrapper.get('input').setValue('host'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.findAll('input, select, textarea')).toHaveLength(0);
    expect(wrapper.find('[data-testid="try-it-now"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('explains each player mode with private questions and exact speech distinguished', async () => {
    window.history.replaceState({}, '', '/sessions/show/play'); transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    expect(wrapper.get('label').element.firstChild?.textContent).toBe('What Skooty says');
    for (const [button, testid, phrase] of [['Do something', 'action-input', 'plain words'], ['Ask the director privately', 'note-input', 'Only the director sees this'], ['Say something', 'speech-input', 'are never shown']]) {
      await wrapper.findAll('button').find(item => item.text() === button)!.trigger('click'); await flushPromises(); checkHelp(wrapper);
      const helpId = wrapper.get(`[data-testid="${testid}"]`).attributes('aria-describedby');
      const help = wrapper.findAll('[id]').find(node => node.attributes('id') === helpId)!.text();
      expect(help).toContain(phrase);
    }
    wrapper.unmount();
  });

  it('explains manual stakes, every repeated outcome and queued input with whitespace-safe identities', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const submissions = ['one space', 'two space', 'private space'].map((id, index) => ({ id, characterId: `pc ${index}`, kind: index === 2 ? 'ooc' : 'act', text: 'Question', intent: 'Enter', approach: 'Sneak', status: 'selected' }));
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions, activeBeat: { id: 'beat space', kind: 'conversation', phase: 'collecting', revision: 2, selectedSubmissionIds: submissions.map(item => item.id), contracts: [], classification: 'ordinary', stakesApproved: false, draft: null, lastError: 'Failed' } });
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    await wrapper.get('[data-testid="stakes-ordinary-edit"]').trigger('click');
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action'); checkHelp(wrapper);
    for (const edit of wrapper.findAll('[data-testid^="stakes-edit-"]')) await edit.trigger('click');
    checkHelp(wrapper);
    expect(wrapper.findAll('[data-testid^="stakes-card-"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="outcome-clean"]')).toHaveLength(2);
    for (const ruling of ['check', 'no_check', 'blocked']) { await wrapper.get('[data-testid="contract-ruling"]').setValue(ruling); checkHelp(wrapper); }
    const ids = wrapper.findAll('[id]').map(node => node.attributes('id')!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/\s/);
    wrapper.unmount();
  });

  it('keeps script rows attached to the surviving lines after removal and insertion', async () => {
    window.history.replaceState({}, '', '/sessions/show/director'); transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    await openRow(wrapper, 0); await openRow(wrapper, 1);
    const value = (index: number) => (wrapper.get(`[data-testid="script-segment-${index}"]`).element as HTMLTextAreaElement).value;
    expect(value(1)).toBe('Who sent you?');
    await wrapper.get('[data-testid="script-remove-0"]').trigger('click');
    expect(value(0)).toBe('Who sent you?'); checkHelp(wrapper);
    await wrapper.get('[data-testid="script-add-line"]').setValue('narration'); checkHelp(wrapper);
    expect(wrapper.findAll('[data-testid^="script-segment-"]')).toHaveLength(2);
    expect(value(1)).toBe('');
    await wrapper.get('[data-testid="script-add-line"]').setValue('mara'); checkHelp(wrapper);
    expect(wrapper.findAll('[data-testid^="script-segment-"]')).toHaveLength(3);
    expect(value(0)).toBe('Who sent you?');
    expect(wrapper.get('[data-testid="script-line-2"]').text()).toBe('Mara: (empty line)');
    const ids = wrapper.findAll('[id]').map(node => node.attributes('id')!);
    expect(new Set(ids).size).toBe(ids.length);
    wrapper.unmount();
  });
});

describe('routes and header', () => {
  it('renders the help page without any api calls', async () => {
    window.history.replaceState({}, '', '/help');
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('.help-page').exists()).toBe(true);
    expect(wrapper.find('.app-header').exists()).toBe(true);
    for (const name of Object.keys(transport) as (keyof typeof transport)[]) expect(transport[name]).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps Back on the page before Help when Help is reloaded', async () => {
    window.history.replaceState({}, '', '/library');
    const before = mount(App); await flushPromises();
    before.unmount();
    window.history.replaceState({}, '', '/help');
    const first = mount(App); await flushPromises();
    expect(first.get('[data-testid="help-back"]').attributes('href')).toBe('/library');
    first.unmount();
    const reloaded = mount(App); await flushPromises();
    expect(reloaded.get('[data-testid="help-back"]').attributes('href')).toBe('/library');
    reloaded.unmount();
  });

  it('shows the producer sign-in without loading sessions or a snapshot', async () => {
    window.history.replaceState({}, '', '/producer#token=abc.def_ghi');
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.findAll('button').some(button => button.text() === 'Sign in as producer')).toBe(true);
    expect(window.location.hash).toBe('');
    expect(transport.sessions).not.toHaveBeenCalled();
    expect(transport.snapshot).not.toHaveBeenCalled();
    expect(transport.me).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('asks for the producer link when none is present', async () => {
    window.history.replaceState({}, '', '/producer');
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.text()).toContain('Open the producer link your host sent you.');
    expect(wrapper.findAll('button').some(button => button.text() === 'Sign in as producer')).toBe(false);
    wrapper.unmount();
  });

  it('renders the stage before the snapshot resolves, never the app shell', async () => {
    window.history.replaceState({}, '', '/sessions/show/stage');
    transport.snapshot.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('.stage').exists()).toBe(true);
    expect(wrapper.find('.app-header').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the Help link and the producer name in the director header', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.me.mockResolvedValue({ role: 'producer', sessionId: null, characterId: null, producer: { grantId: 'a'.repeat(32), label: 'Sam', expiresAt: '2026-11-22T00:00:00Z' }, streamLinkId: null, expiresAt: '2026-10-23T12:00:00Z' });
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.get('.role-label').text()).toBe('Producer · Sam');
    expect(wrapper.findAll('.header-meta a').some(link => link.text() === 'Help')).toBe(true);
    wrapper.unmount();
  });

  it('says Host for a director page, Player for a seat, and nothing when the role is unknown', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    const host = mount(App); await flushPromises();
    expect(host.get('.role-label').text()).toBe('Host');
    host.unmount();
    window.history.replaceState({}, '', '/sessions/show/play');
    transport.snapshot.mockResolvedValue(snapshot('player'));
    const player = mount(App); await flushPromises();
    expect(player.get('.role-label').text()).toBe('Player');
    expect(player.text()).not.toContain('A shared live story');
    player.unmount();
    window.history.replaceState({}, '', '/');
    transport.sessions.mockResolvedValue({ sessions: [] });
    const home = mount(App); await flushPromises();
    expect(home.find('.role-label').exists()).toBe(false);
    expect(home.find('.header-meta').text()).not.toContain('A shared live story');
    home.unmount();
  });

  it('says Host on the lobby for a signed-in host, asking who the viewer is', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(snapshot('director'));
    transport.me.mockResolvedValue({ role: 'host', sessionId: null, characterId: null, producer: null, streamLinkId: null, expiresAt: '2026-10-23T12:00:00Z' });
    const wrapper = mount(App); await flushPromises();
    expect(transport.me).toHaveBeenCalled();
    expect(wrapper.get('.role-label').text()).toBe('Host');
    wrapper.unmount();
  });

  it('puts Stream this show in the header of every session page but the stage, with the role\'s hash', async () => {
    for (const [route, role, hash] of [['director', 'director', 'stage-links'], ['lobby', 'director', 'stage-links'], ['play', 'player', 'my-stream-view'], ['lobby', 'player', 'my-stream-view']] as const) {
      window.history.replaceState({}, '', `/sessions/show/${route}`);
      transport.snapshot.mockResolvedValue(snapshot(role));
      const wrapper = mount(App); await flushPromises();
      const link = wrapper.get('[data-testid="stream-this-show"]');
      expect(link.text()).toBe('Stream this show');
      expect(link.attributes('href')).toBe(`/sessions/show/lobby#${hash}`);
      wrapper.unmount();
    }
    window.history.replaceState({}, '', '/sessions/show/stage');
    transport.snapshot.mockResolvedValue(snapshot('stage'));
    const stage = mount(App); await flushPromises();
    expect(stage.find('[data-testid="stream-this-show"]').exists()).toBe(false);
    expect(stage.find('.app-header').exists()).toBe(false);
    stage.unmount();
  });

  it('keeps the Test as identity on the Stream this show link', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/play?identity=${identity}`);
    transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.get('[data-testid="stream-this-show"]').attributes('href')).toBe(`/sessions/show/lobby?identity=${identity}#my-stream-view`);
    wrapper.unmount();
  });

  it('calls the stage link Preview (not for OBS) and words the pause button and notice for a show', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(snapshot('director'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.get('[data-testid="stage-preview-link"]').text()).toBe('Preview (not for OBS)');
    expect(wrapper.text()).not.toContain('Open stage');
    const pause = wrapper.findAll('button').find(button => button.text() === 'Pause show')!;
    expect(pause).toBeDefined();
    expect(wrapper.text()).not.toContain('Pause table');
    wrapper.unmount();
    const base = snapshot('director');
    transport.snapshot.mockResolvedValue({ ...base, session: { ...base.session, status: 'paused' } });
    const paused = mount(App); await flushPromises();
    expect(paused.findAll('button').some(button => button.text() === 'Resume show')).toBe(true);
    expect(paused.text()).not.toContain('table');
    paused.unmount();
  });

  it('says Loading the show… while the first snapshot is on its way', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.text()).toContain('Loading the show…');
    expect(wrapper.text()).not.toContain('Restoring');
    wrapper.unmount();
  });
});

describe('show shell', () => {
  const unstarted = (role: 'director' | 'player' = 'director') => ({ ...snapshot(role), setup: { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'scenario', version: 1 } } });
  const start = { type: 'start_session', commandId: 'c'.repeat(32), expectedStateRevision: 0 };

  it('goes to the director page after Start show succeeds', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(unstarted());
    const wrapper = mount(App); await flushPromises();
    wrapper.findComponent({ name: 'Lobby' }).vm.$emit('command', start);
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', start);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith('/sessions/show/director');
    wrapper.unmount();
  });

  it('stays on Cast & lobby with the error when the start fails', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(unstarted());
    transport.command.mockRejectedValue(new Error('Every seat needs a card.'));
    const wrapper = mount(App); await flushPromises();
    wrapper.findComponent({ name: 'Lobby' }).vm.$emit('command', start);
    await flushPromises();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Every seat needs a card.');
    wrapper.unmount();
  });

  it('does not move the director for other lobby commands', async () => {
    window.history.replaceState({}, '', '/sessions/show/lobby');
    transport.snapshot.mockResolvedValue(unstarted());
    const wrapper = mount(App); await flushPromises();
    wrapper.findComponent({ name: 'Lobby' }).vm.$emit('command', { type: 'set_status', commandId: 'd'.repeat(32), status: 'paused', expectedStateRevision: 0 });
    await flushPromises();
    expect(transport.command).toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows the preview strip on the stage with a link to Stream this show, and no operator note', async () => {
    window.history.replaceState({}, '', '/sessions/show/stage');
    transport.snapshot.mockResolvedValue(snapshot('stage'));
    const wrapper = mount(App); await flushPromises();
    const strip = wrapper.get('[data-testid="preview-strip"]');
    expect(strip.text()).toContain('Preview only, not for OBS. For OBS, use a link from Stream this show.');
    expect(strip.get('a').text()).toBe('Stream this show');
    expect(strip.get('a').attributes('href')).toBe('/sessions/show/lobby#stage-links');
    expect(wrapper.text()).not.toContain('Operator controls stay below');
    wrapper.unmount();
  });

  it('offers Back to the director page to a host or a producer, and to nobody else', async () => {
    window.history.replaceState({}, '', '/sessions/show/stage');
    transport.snapshot.mockResolvedValue(snapshot('stage'));
    const viewer = (role: string) => ({ role, sessionId: null, characterId: null, producer: role === 'producer' ? { grantId: 'a'.repeat(32), label: 'Sam', expiresAt: '2026-11-22T00:00:00Z' } : null, streamLinkId: null, expiresAt: '2026-10-23T12:00:00Z' });
    for (const [role, shown] of [['host', true], ['producer', true], ['player', false], ['stage', false]] as const) {
      transport.me.mockResolvedValue(viewer(role));
      const wrapper = mount(App); await flushPromises();
      const back = wrapper.find('[data-testid="back-to-director"]');
      expect(back.exists()).toBe(shown);
      if (shown) { expect(back.text()).toBe('Back to the director page'); expect(back.attributes('href')).toBe('/sessions/show/director'); }
      wrapper.unmount();
    }
    transport.me.mockRejectedValue(new Error('Sign in'));
    const anonymous = mount(App); await flushPromises();
    expect(anonymous.find('[data-testid="back-to-director"]').exists()).toBe(false);
    anonymous.unmount();
  });
});
