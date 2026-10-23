// @vitest-environment jsdom
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import FieldGenerator from './FieldGenerator.vue';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

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
  window.history.replaceState({}, '', '/sessions/show/stage');
});
afterEach(() => { document.body.innerHTML = ''; });

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

  it('prepares private audio only for the director and publishes the selected saved recording', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...scriptSnapshot(), activeBeat: { ...scriptSnapshot().activeBeat, generation: 4 } });
    const wrapper = mount(App, { global: { stubs: { DraftAudioPanel: { name: 'DraftAudioPanel', props: ['sessionId', 'beatId', 'beatRevision', 'draftRevision', 'generation', 'dirty', 'busy', 'rendering'], template: '<div />' } } } });
    await flushPromises();
    const panel = wrapper.getComponent({ name: 'DraftAudioPanel' });
    expect(panel.props()).toMatchObject({ sessionId: 'show', beatId: 'beat-2', beatRevision: 3, draftRevision: 1, generation: 4, dirty: false, busy: false, rendering: false });
    panel.vm.$emit('publish', '11111111-1111-4111-8111-111111111111'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', draftRevision: 1, textOnly: false, audioPreparationId: '11111111-1111-4111-8111-111111111111' }));
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Unsaved words.');
    expect(panel.props('dirty')).toBe(true);
    transport.command.mockClear();
    panel.vm.$emit('publish', '11111111-1111-4111-8111-111111111111'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it.each(['stage', 'player'])('does not mount private draft audio in the %s view', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue(snapshot(role));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.findComponent({ name: 'DraftAudioPanel' }).exists()).toBe(false);
    wrapper.unmount();
  });

  it('retains text-only publication without a recording selection', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App); await flushPromises();
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: true }));
    expect(transport.command.mock.calls.at(-1)?.[1]).not.toHaveProperty('audioPreparationId');
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
  it.each(['director', 'player', 'stage'])('keeps session audio available before publication in the %s view', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    transport.snapshot.mockResolvedValue({ ...snapshot(role), history: [] });
    const wrapper = mount(App, { global: { stubs: { AudioPanel: { name: 'AudioPanel', props: { sessionId: String, beatId: String, director: Boolean, stage: Boolean }, template: '<div />' } } } });
    await flushPromises();
    const panel = wrapper.getComponent({ name: 'AudioPanel' });
    expect(panel.props('sessionId')).toBe('show');
    expect(panel.props('beatId')).toBeUndefined();
    expect(Boolean(panel.props('director'))).toBe(role === 'director');
    expect(Boolean(panel.props('stage'))).toBe(role === 'stage');
    wrapper.unmount();
  });

  it.each(['director', 'player', 'stage'])('shows older public correction notices in the %s view', async role => {
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

  it('dismisses a failed script save without losing words and permits saving again', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.command.mockRejectedValueOnce(new Error('Could not save script.'));
    const wrapper = mount(App); await flushPromises();
    const draft = wrapper.get('[data-testid="script-segment-0"]');
    await draft.setValue('My unfinished narration.');
    const save = wrapper.findAll('button').find(button => button.text() === 'Save script edits')!;
    await save.trigger('click'); await flushPromises();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('Could not save script.');
    const refresh = alert.findAll('button').find(button => button.text() === 'Refresh state')!;
    expect(refresh.attributes('type')).toBe('button');
    expect(refresh.attributes('disabled')).toBeUndefined();
    await alert.get('button[aria-label="Dismiss error"]').trigger('click');
    expect(wrapper.findComponent({ name: 'ErrorNotice' }).exists()).toBe(false);
    expect((draft.element as HTMLTextAreaElement).value).toBe('My unfinished narration.');
    await save.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(2);
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
    const control = wrapper.findAllComponents(FieldGenerator).find(control => control.props('field') === 'script.narration')!;
    await control.get('[data-testid="field-generator-open"]').trigger('click');
    expect(control.find('[data-testid="field-generator-source"]').exists()).toBe(false);
    expect((control.get('[data-testid="field-generator-seed"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    wrapper.unmount();
  });

  it('previews a host rehearsal title and applies it locally without creating a session', async () => {
    window.history.replaceState({}, '', '/');
    transport.sessions.mockResolvedValue([]);
    transport.generateField.mockResolvedValue({ text: 'The Silent Beacon' });
    const wrapper = mount(App); await flushPromises();
    const form = wrapper.get('form');
    await generate(form, 'A silent beacon');
    expect(transport.generateField).toHaveBeenCalledWith({ field: 'session.title', seed: 'A silent beacon' });
    expect((form.get('input').element as HTMLInputElement).value).toBe('The Ledger Job');
    await form.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((form.get('input').element as HTMLInputElement).value).toBe('The Silent Beacon');
    expect(transport.create).not.toHaveBeenCalled(); expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('applies generated narration and NPC dialogue only to unsaved script fields', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue(scriptSnapshot());
    transport.generateField.mockResolvedValueOnce({ text: 'Dust settles over the empty chairs.' }).mockResolvedValueOnce({ text: 'Tell me who sent you.' });
    const wrapper = mount(App); await flushPromises();
    const rows = wrapper.findAll('.segment:has([data-testid^="script-segment-"])');
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
    await wrapper.findAll('button').find(button => button.text() === 'Save script edits')!.trigger('click'); await flushPromises();
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
    const first = wrapper.findAll('.segment:has([data-testid^="script-segment-"])')[0]; await generate(first);
    await first.findAll('button').find(button => button.text() === 'Remove segment')!.trigger('click');
    resolve({ text: 'Stale text from the removed row.' }); await flushPromises();
    expect(wrapper.findAll('.segment:has([data-testid^="script-segment-"])')).toHaveLength(1);
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    expect(transport.command).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('discards pending script generation when an identical draft arrives at a new beat revision', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const current = scriptSnapshot(); transport.snapshot.mockResolvedValue(current);
    let resolve!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(result => { resolve = result; }));
    const wrapper = mount(App); await flushPromises(); await generate(wrapper.get('.segment:has([data-testid^="script-segment-"])'));
    transport.snapshot.mockResolvedValue({ ...current, activeBeat: { ...current.activeBeat, revision: 4 } });
    await transport.subscribe.mock.calls[0][1](); await flushPromises();
    resolve({ text: 'Stale text for the former revision.' }); await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The room falls silent.');
    expect(transport.command).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('offers no field generation on player speech or action controls', async () => {
    window.history.replaceState({}, '', '/sessions/show/play'); transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App); await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    await wrapper.findAll('button').find(button => button.text() === 'Act')!.trigger('click');
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('offers the native library from the host workspace and preserves its tab identity', async () => {
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    transport.sessions.mockResolvedValue([]);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="library-link"]').attributes('href')).toBe(`/library?identity=${'a'.repeat(32)}`);
    expect(wrapper.get('.brand').text()).toContain('THE STORY TABLE');
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
      expect(wrapper.get('[data-testid="setup-lobby-link"]').attributes('href')).toBe('/sessions/show/lobby');
      wrapper.unmount();
    }
  });
  it('opens independent character rehearsal tabs from the director cast lobby', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/lobby?identity=${identity}`);
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), characters: [
      { id: 'pc-1', displayName: 'Rook', approved: true, strain: 0, appearance: 'A strong presence.' },
      { id: 'pc-2', displayName: 'Lark', approved: true, strain: 0, appearance: 'Always watching.' },
    ] });
    const wrapper = mount(App);
    await flushPromises();
    const testLinks = wrapper.findAll('a').filter(link => link.text().startsWith('Test as '));
    expect(testLinks.map(link => link.text())).toEqual(['Test as Rook ↗', 'Test as Lark ↗']);
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

  it('requires saving script edits before publication and never provides an authoring control for player dialogue', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), activeBeat: {
      id: 'beat-2', sessionId: 'show', kind: 'conversation', phase: 'draft_review', revision: 3,
      inputEpoch: 1, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions: [], contracts: [],
      stakesApproved: true, classification: 'ordinary', inputSnapshotHash: 'hash', resolution: { rolls: [], outcomes: [], effects: [] },
      draft: { segments: [{ kind: 'narration', speakerNpcId: null, text: 'Mara folds her arms.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [{ kind: 'world_fact', factId: 'fact-1', text: 'The ledger has a buyer.', visibility: 'public', sourceSubmissionIds: ['say-1'] }], directorSummary: 'Private summary.' },
      draftRevision: 1, approvedContinuity: [], generation: 1, lastError: null,
    } });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Mara sets the glass down.');
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').find(button => button.text() === 'Approve continuity updates')!.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('Add player dialogue');
    const save = wrapper.findAll('button').find(button => button.text() === 'Save script edits')!;
    await save.trigger('click');
    await flushPromises();
    expect(transport.command).toHaveBeenCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: [{ kind: 'narration', speakerNpcId: null, text: 'Mara sets the glass down.', recipientCharacterIds: [], delivery: 'neutral' }] }));
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
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action');
    expect(wrapper.find('[data-testid="contract-ruling"]').exists()).toBe(true);
    await wrapper.get('[data-testid="contract-ruling"]').setValue('no_check');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('Access is granted, but security notices.');
    await wrapper.get('[data-testid="outcome-setback"]').setValue('Access is refused; the guard asks them to leave.');
    await wrapper.get('[data-testid="approve-stakes"]').trigger('click');
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
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), activeBeat: {
      id: 'beat-2', kind: 'conversation', phase: 'collecting', revision: 2, selectedSubmissionIds: ['say-1'],
      contracts: [], classification: null, stakesApproved: false, draft: null, lastError: 'The planner timed out.',
    } });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(true);
    await wrapper.get('[data-testid="approve-stakes"]').trigger('click');
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
  function checkHelp(wrapper: ReturnType<typeof mount>) {
    const controls = wrapper.findAll('input, select, textarea');
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

  it('explains host authentication, rehearsal titles, and every one-use invitation', async () => {
    window.history.replaceState({}, '', '/'); transport.sessions.mockRejectedValueOnce(new Error('Sign in'));
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    expect(wrapper.get('label').text()).toBe('Host access token');
    transport.sessions.mockResolvedValue([]); transport.login.mockResolvedValue({});
    await wrapper.get('input').setValue('host'); await wrapper.get('form').trigger('submit'); await flushPromises(); checkHelp(wrapper);
    transport.create.mockResolvedValue({ sessionId: 'new', invites: [{ role: 'player', token: 'one token' }, { role: 'stage', token: 'two token' }] });
    await wrapper.get('form').trigger('submit'); await flushPromises(); checkHelp(wrapper);
    wrapper.unmount();
  });

  it('explains each player mode with private questions and exact speech distinguished', async () => {
    window.history.replaceState({}, '', '/sessions/show/play'); transport.snapshot.mockResolvedValue(snapshot('player'));
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    expect(wrapper.get('label').element.firstChild?.textContent).toBe('Addressed to');
    for (const tab of ['Act', 'Out of character', 'Say']) {
      await wrapper.findAll('button').find(button => button.text() === tab)!.trigger('click'); checkHelp(wrapper);
      const helpId = wrapper.get('[data-testid="speech-input"]').attributes('aria-describedby');
      const help = wrapper.findAll('[id]').find(node => node.attributes('id') === helpId)!.text();
      expect(help).toContain(tab === 'Out of character' ? 'never published' : 'verbatim');
    }
    wrapper.unmount();
  });

  it('explains manual stakes, every repeated outcome and queued input with whitespace-safe identities', async () => {
    window.history.replaceState({}, '', '/sessions/show/director');
    const submissions = ['one space', 'two space', 'private space'].map((id, index) => ({ id, characterId: `pc ${index}`, kind: index === 2 ? 'ooc' : 'act', text: 'Question', intent: 'Enter', approach: 'Sneak', status: 'selected' }));
    transport.snapshot.mockResolvedValue({ ...snapshot('director'), submissions, activeBeat: { id: 'beat space', kind: 'conversation', phase: 'collecting', revision: 2, selectedSubmissionIds: submissions.map(item => item.id), contracts: [], classification: 'ordinary', stakesApproved: false, draft: null, lastError: 'Failed' } });
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action'); checkHelp(wrapper);
    expect(wrapper.findAll('[data-testid="outcome-clean"]')).toHaveLength(2);
    for (const ruling of ['check', 'no_check', 'blocked']) { await wrapper.get('[data-testid="contract-ruling"]').setValue(ruling); checkHelp(wrapper); }
    wrapper.unmount();
  });

  it('keeps script descriptions attached to surviving rows after removal and insertion', async () => {
    window.history.replaceState({}, '', '/sessions/show/director'); transport.snapshot.mockResolvedValue(scriptSnapshot());
    const wrapper = mount(App, options); await flushPromises(); checkHelp(wrapper);
    const survivingId = wrapper.get('[data-testid="script-segment-1"]').attributes('aria-describedby');
    await wrapper.findAll('button').find(button => button.text() === 'Remove segment')!.trigger('click');
    expect(wrapper.get('[data-testid="script-segment-0"]').attributes('aria-describedby')).toBe(survivingId); checkHelp(wrapper);
    await wrapper.findAll('button').find(button => button.text() === 'Add manual narration')!.trigger('click'); checkHelp(wrapper);
    await wrapper.findAll('button').find(button => button.text() === 'Add NPC dialogue')!.trigger('click'); checkHelp(wrapper);
    wrapper.unmount();
  });
});
