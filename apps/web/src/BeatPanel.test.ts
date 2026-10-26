// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import BeatPanel from './BeatPanel.vue';
import { createTable, provideTable, type Table } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

const DraftAudioPanelStub = { name: 'DraftAudioPanel', props: ['sessionId', 'beatId', 'beatRevision', 'draftRevision', 'generation', 'dirty', 'busy', 'rendering', 'paused', 'highlight'], emits: ['publish', 'recording-ready'], template: '<div data-testid="draft-audio-stub" />' };
const AUDIO_ID = '11111111-1111-4111-8111-111111111111';
const segments = [{ kind: 'narration', speakerNpcId: null, text: 'The room falls silent.', recipientCharacterIds: [], delivery: 'neutral' }];
const continuity = [{ kind: 'world_fact', factId: 'fact-1', text: 'The ledger has a buyer.', visibility: 'public', sourceSubmissionIds: ['say-1'] }];

function beat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beat-2', sessionId: 'show', kind: 'conversation', phase: 'collecting', revision: 3, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], classification: 'ordinary', stakesApproved: false, inputSnapshotHash: null,
    resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null, ...overrides,
  };
}

function snapshot(activeBeat: Record<string, unknown> | null, status = 'live') {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 4, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [{ id: 'pc-1', displayName: 'Skooty' }], npcs: [{ id: 'mara', displayName: 'Mara', role: 'Bartender', status: 'present' }], tracks: [], facts: [], activeBeat, history: [],
    submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: '',
  };
}

const locked = (overrides: Record<string, unknown> = {}) => beat({ phase: 'locked', stakesApproved: true, resolution: { rolls: [], outcomes: [], effects: [] }, ...overrides });
const review = (overrides: Record<string, unknown> = {}) => locked({ phase: 'draft_review', draftRevision: 1, draft: { segments, continuity: [], directorSummary: '' }, ...overrides });
const pending = () => review({ draft: { segments, continuity, directorSummary: '' } });

let table: Table;
async function mountPanel(state: ReturnType<typeof snapshot>, selected: string[] = []) {
  transport.snapshot.mockResolvedValue(state);
  const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(BeatPanel, { selected }); } });
  const wrapper = mount(Host, { global: { stubs: { DraftAudioPanel: DraftAudioPanelStub } } });
  await table.refresh();
  await flushPromises();
  return wrapper;
}

const bar = (wrapper: VueWrapper) => wrapper.get('[aria-label="Beat actions"]');
const buttonNamed = (wrapper: VueWrapper, name: string) => wrapper.findAll('button').find(button => button.text() === name);
const goldButtons = (wrapper: VueWrapper) => wrapper.findAll('button').filter(button => !button.classes('secondary') && !button.classes('quiet')).map(button => button.text());

beforeEach(() => {
  vi.clearAllMocks();
  transport.subscribe.mockReturnValue(() => {});
  transport.command.mockResolvedValue({});
  window.history.replaceState({}, '', '/sessions/show/director');
});
afterEach(() => { document.body.innerHTML = ''; });

describe('beat panel action bar', () => {
  it.each([
    ['no beat', null, [], 'Open conversation'],
    ['collecting with nothing selected', beat(), [], 'Plan selected input'],
    ['collecting with a selection', beat(), ['say-1'], 'Plan selected input'],
    ['ordinary stakes waiting for approval', beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'] }), ['say-1'], 'Lock and draft'],
    ['action stakes waiting for approval', beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], kind: 'action', classification: 'needs_action', contracts: [] }), ['say-1'], 'Approve stakes'],
    ['approved stakes', beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], stakesApproved: true }), ['say-1'], 'Lock input'],
    ['a locked beat without a draft', locked(), [], 'Draft the scene'],
    ['a draft ready to publish', review(), [], 'Publish text-only beat'],
    ['a draft with unapproved continuity', pending(), [], 'Approve continuity updates'],
  ])('shows exactly one gold button for %s', async (_label, activeBeat, selected, gold) => {
    const wrapper = await mountPanel(snapshot(activeBeat), selected);
    expect(goldButtons(wrapper)).toEqual([gold]);
    expect(bar(wrapper).findAll('button').some(button => button.text() === gold)).toBe(true);
    wrapper.unmount();
  });

  it('makes Save script edits the only gold button while the script has unsaved edits and keeps Regenerate outlined', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    expect(buttonNamed(wrapper, 'Regenerate script')!.classes()).toContain('secondary');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Unsaved words.');
    expect(goldButtons(wrapper)).toEqual(['Save script edits']);
    expect(bar(wrapper).text()).toContain('Save script edits before publishing.');
    expect(buttonNamed(wrapper, 'Regenerate script')!.classes()).toContain('secondary');
    wrapper.unmount();
  });

  it('keeps the current step name, its next sentence and the reason in the bar', async () => {
    let wrapper = await mountPanel(snapshot(beat()));
    expect(bar(wrapper).find('[aria-live]').exists()).toBe(false);
    expect(bar(wrapper).get('.beat-next').text()).toContain('Select lines');
    expect(bar(wrapper).get('.beat-next').text()).toContain('Tick the lines from the queue that belong in this beat.');
    expect(bar(wrapper).text()).toContain('Select at least one line to plan.');
    expect(wrapper.get('h2').text()).toBe('Collecting input');
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(review()));
    expect(bar(wrapper).get('.beat-next').text()).toContain('Publish');
    expect(bar(wrapper).get('.beat-next').text()).toContain('Publish the beat when the script reads right.');
    wrapper.unmount();
  });

  it('disables the pipeline buttons while the table is paused', async () => {
    let wrapper = await mountPanel(snapshot(null, 'paused'));
    for (const id of ['open-conversation', 'open-action']) expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    expect(bar(wrapper).text()).toContain('The table is paused. Resume to continue.');
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(review(), 'paused'));
    for (const id of ['render', 'publish']) expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps every beat test id and the publish button only while a draft exists', async () => {
    let wrapper = await mountPanel(snapshot(null));
    for (const id of ['open-conversation', 'open-action']) expect(bar(wrapper).findAll(`[data-testid="${id}"]`)).toHaveLength(1);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'] })), ['say-1']);
    for (const id of ['plan', 'approve-stakes', 'lock']) expect(bar(wrapper).findAll(`[data-testid="${id}"]`)).toHaveLength(1);
    for (const id of ['stakes-classification', 'abort-reason', 'abort-beat']) expect(wrapper.findAll(`[data-testid="${id}"]`)).toHaveLength(1);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(locked()));
    expect(bar(wrapper).findAll('[data-testid="render"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="publish"]').exists()).toBe(false);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(pending()));
    expect(bar(wrapper).findAll('[data-testid="publish"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('Review 1 proposed continuity updates');
    for (const name of ['Add manual narration', 'Add NPC dialogue', 'Remove segment', 'Approve continuity updates', 'Save script edits', 'Regenerate script']) expect(wrapper.findAll('button').filter(button => button.text() === name)).toHaveLength(1);
    for (const name of ['Add manual narration', 'Add NPC dialogue', 'Remove segment']) expect(bar(wrapper).findAll('button').some(button => button.text() === name)).toBe(false);
    wrapper.unmount();
  });
});

describe('beat panel safeguards', () => {
  it('asks before regenerating an existing draft', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="render"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Replace the current draft? Saved script edits are discarded; the dice stay the same.');
    await buttonNamed(wrapper, 'Keep draft')!.trigger('click');
    expect(wrapper.text()).not.toContain('Replace the current draft?');
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="render"]').trigger('click');
    await buttonNamed(wrapper, 'Yes, regenerate')!.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'render_beat', beatId: 'beat-2', expectedBeatRevision: 3 }));
    wrapper.unmount();
  });

  it('drafts a locked beat without a confirmation when no draft exists', async () => {
    const wrapper = await mountPanel(snapshot(locked()));
    await wrapper.get('[data-testid="render"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'render_beat' }));
    expect(wrapper.text()).not.toContain('Replace the current draft?');
    wrapper.unmount();
  });

  it('shows the continuity notice and approves the updates from it', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    expect(bar(wrapper).text()).toContain('1 continuity updates are not approved. Characters will not remember them unless you approve.');
    expect(bar(wrapper).text()).toContain('Approve the continuity updates, then publish.');
    await buttonNamed(wrapper, 'Approve continuity updates')!.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'approve_continuity', updates: continuity }));
    wrapper.unmount();
  });

  it('tells the audio panel to stop highlighting publish while continuity updates are pending', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('highlight')).toBe(false);
    transport.snapshot.mockResolvedValue(snapshot(review({ draft: { segments, continuity, directorSummary: '' }, approvedContinuity: continuity })));
    await buttonNamed(wrapper, 'Approve continuity updates')!.trigger('click'); await flushPromises();
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('highlight')).toBe(true);
    wrapper.unmount();
  });

  it('asks before publishing without the continuity updates', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Publish without the 1 continuity updates?');
    await buttonNamed(wrapper, 'Go back')!.trigger('click');
    expect(wrapper.text()).not.toContain('Publish without the');
    await wrapper.get('[data-testid="publish"]').trigger('click');
    await buttonNamed(wrapper, 'Publish anyway')!.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: true, draftRevision: 1, expectedStateRevision: 4 }));
    expect(transport.command.mock.calls[0][1]).not.toHaveProperty('audioPreparationId');
    wrapper.unmount();
  });

  it('holds a narrated publish from the audio panel until the director confirms', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('publish', AUDIO_ID); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Publish without the 1 continuity updates?');
    await buttonNamed(wrapper, 'Publish anyway')!.trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: false, audioPreparationId: AUDIO_ID }));
    wrapper.unmount();
  });

  it('publishes straight away when continuity is approved or absent', async () => {
    const wrapper = await mountPanel(snapshot(review({ draft: { segments, continuity, directorSummary: '' }, approvedContinuity: continuity })));
    expect(wrapper.text()).not.toContain('continuity updates are not approved');
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('publish', AUDIO_ID); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', audioPreparationId: AUDIO_ID }));
    wrapper.unmount();
  });
});

describe('beat panel lock and draft', () => {
  const ordinaryStakes = (overrides: Record<string, unknown> = {}) => beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], ...overrides });

  it('makes Lock and draft the only gold button in an ordinary stakes review and keeps the other buttons', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes()), ['say-1']);
    expect(goldButtons(wrapper)).toEqual(['Lock and draft']);
    expect(bar(wrapper).findAll('button').some(button => button.text() === 'Lock and draft')).toBe(true);
    expect(buttonNamed(wrapper, 'Approve stakes')!.classes()).toContain('secondary');
    expect(buttonNamed(wrapper, 'Lock input')!.classes()).toContain('secondary');
    wrapper.unmount();
  });

  it('shows the new sentence in the stepper and the bar', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes()), ['say-1']);
    const sentence = 'Ordinary conversation. Choose Lock and draft to lock the lines and write the scene.';
    expect(bar(wrapper).get('.beat-next').text()).toContain(sentence);
    expect(bar(wrapper).get('.beat-next').text()).not.toContain('Review the stakes, then approve them.');
    wrapper.unmount();
  });

  it('does not offer Lock and draft for an action', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes({ classification: 'needs_action' })), ['say-1']);
    expect(buttonNamed(wrapper, 'Lock and draft')).toBeUndefined();
    expect(goldButtons(wrapper)).toEqual(['Approve stakes']);
    wrapper.unmount();
  });

  it('approves, locks and drafts in order, each with the fresh beat revision', async () => {
    const states = [ordinaryStakes({ revision: 3 }), ordinaryStakes({ revision: 4, stakesApproved: true, classification: 'ordinary' }), locked({ revision: 5 }), locked({ revision: 6 })];
    const wrapper = await mountPanel(snapshot(states[0]), ['say-1']);
    transport.snapshot.mockReset();
    transport.snapshot.mockResolvedValueOnce(snapshot(states[1])).mockResolvedValueOnce(snapshot(states[2])).mockResolvedValueOnce(snapshot(states[3]));
    await buttonNamed(wrapper, 'Lock and draft')!.trigger('click'); await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['approve_stakes', 'lock_beat', 'render_beat']);
    expect(sent.map(command => command.expectedBeatRevision)).toEqual([3, 4, 5]);
    expect(sent[0]).toMatchObject({ classification: 'ordinary', contracts: [] });
    expect(new Set(sent.map(command => command.commandId)).size).toBe(3);
    wrapper.unmount();
  });

  it('keeps the revisions in step when a socket refresh supersedes the refresh after a command', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes({ revision: 3 })), ['say-1']);
    const returned = [snapshot(ordinaryStakes({ revision: 4, stakesApproved: true })), snapshot(locked({ revision: 5 })), snapshot(locked({ revision: 6 }))];
    let latest = snapshot(ordinaryStakes({ revision: 3 }));
    const held: Array<() => void> = [];
    let calls = 0;
    transport.snapshot.mockReset();
    transport.snapshot.mockImplementation(() => {
      calls += 1;
      if (calls > 2) return Promise.resolve(latest);
      return new Promise(resolve => { held.push(() => resolve(latest)); });
    });
    let issued = 0;
    transport.command.mockReset();
    transport.command.mockImplementation(async () => { latest = returned[issued++]; return { commandId: 'c', eventSeq: issued, snapshot: latest }; });
    await buttonNamed(wrapper, 'Lock and draft')!.trigger('click'); await flushPromises();
    expect(held).toHaveLength(1);
    const socketRefresh = table.refresh();
    expect(held).toHaveLength(2);
    held[0](); await flushPromises();
    held[1](); await socketRefresh; await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['approve_stakes', 'lock_beat', 'render_beat']);
    expect(sent.map(command => command.expectedBeatRevision)).toEqual([3, 4, 5]);
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('stops at the first error', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes({ revision: 3 })), ['say-1']);
    transport.snapshot.mockReset();
    transport.snapshot.mockResolvedValue(snapshot(ordinaryStakes({ revision: 4, stakesApproved: true, classification: 'ordinary' })));
    transport.command.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('The beat changed.'));
    await buttonNamed(wrapper, 'Lock and draft')!.trigger('click'); await flushPromises();
    expect(transport.command.mock.calls.map(call => call[1].type)).toEqual(['approve_stakes', 'lock_beat']);
    expect(table.error.value).toBe('The beat changed.');
    wrapper.unmount();
  });

  it('does nothing while the table is paused', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes(), 'paused'), ['say-1']);
    expect(buttonNamed(wrapper, 'Lock and draft')!.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('beat panel wiring', () => {
  it('keeps a space between the next sentence and the reason', async () => {
    const wrapper = await mountPanel(snapshot(beat()));
    expect(bar(wrapper).get('.beat-next').text()).toContain('beat. Select');
    expect(wrapper.get('.step-next').text()).toContain('beat. Select');
    wrapper.unmount();
  });

  it('passes the paused state to the draft audio panel', async () => {
    let wrapper = await mountPanel(snapshot(review(), 'paused'));
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('paused')).toBe(true);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('paused')).toBe(false);
    wrapper.unmount();
  });

  it('makes the text-only publish button secondary while a recording is ready', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    expect(buttonNamed(wrapper, 'Publish text-only beat')!.classes()).not.toContain('secondary');
    wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('recording-ready', true);
    await flushPromises();
    expect(buttonNamed(wrapper, 'Publish text-only beat')!.classes()).toContain('secondary');
    wrapper.unmount();
  });

  it('emits the step name and focuses the gold action', async () => {
    transport.snapshot.mockResolvedValue(snapshot(review()));
    const onStep = vi.fn();
    const panel = { current: null as null | { focusPrimary: () => void } };
    const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(BeatPanel, { selected: [], onStep, ref: (value: unknown) => { panel.current = value as typeof panel.current; } }); } });
    const wrapper = mount(Host, { attachTo: document.body, global: { stubs: { DraftAudioPanel: DraftAudioPanelStub } } });
    await table.refresh();
    await flushPromises();
    expect(onStep).toHaveBeenCalledWith('Publish');
    panel.current!.focusPrimary();
    expect(document.activeElement).toBe(buttonNamed(wrapper, 'Publish text-only beat')!.element);
    wrapper.unmount();
  });
});

describe('beat panel stage length cue', () => {
  const contract = (intent: string, costly: string) => ({
    id: '22222222-2222-4222-8222-222222222222', version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], submissionIds: ['say-1'], ruling: 'check', intent, approach: 'Carefully.', trait: 'wits', risk: 'normal', edge: 0, dependsOnContractIds: [],
    outcomes: { clean: { publicText: 'It works.', effects: [] }, costly: { publicText: costly, effects: [] }, setback: { publicText: 'It fails.', effects: [] } },
  });
  const actionReview = (intent: string, costly: string) => beat({ phase: 'stakes_review', kind: 'action', classification: 'needs_action', selectedSubmissionIds: ['say-1'], contracts: [contract(intent, costly)] });

  it('shows the live count without the over class for short text', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('Open the ledger.', 'Open, with a cost.')), ['say-1']);
    const cue = wrapper.get('[data-testid="stage-length-costly"]');
    expect(cue.text()).toBe('On stage: 18 of 110 characters');
    expect(cue.classes()).not.toContain('over');
    expect(wrapper.get('[data-testid="stage-length-goal"]').text()).toBe('On stage: 16 of 90 characters');
    wrapper.unmount();
  });

  it('flags a costly outcome over 110 characters and keeps Approve stakes usable', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('Open the ledger.', 'x'.repeat(245))), ['say-1']);
    const cue = wrapper.get('[data-testid="stage-length-costly"]');
    expect(cue.classes()).toContain('over');
    expect(cue.text()).toContain('Too long for the stage');
    expect(cue.text()).toContain('this has 245');
    expect(buttonNamed(wrapper, 'Approve stakes')!.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('flags a goal over 90 characters and updates as the text changes', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('g'.repeat(91), 'Fine.')), ['say-1']);
    const cue = wrapper.get('[data-testid="stage-length-goal"]');
    expect(cue.classes()).toContain('over');
    expect(cue.text()).toContain('it fits about 90 characters and this has 91');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('y'.repeat(111));
    expect(wrapper.get('[data-testid="stage-length-costly"]').classes()).toContain('over');
    wrapper.unmount();
  });
});
