// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import BeatPanel from './BeatPanel.vue';
import { createTable, provideTable, type Table } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

const AUDIO_ID = '11111111-1111-4111-8111-111111111111';
const READY = { status: 'ready', preparationId: AUDIO_ID } as const;
let stubVoice: Record<string, unknown> = READY;
const DraftAudioPanelStub = defineComponent({
  name: 'DraftAudioPanel',
  props: ['sessionId', 'beatId', 'beatRevision', 'draftRevision', 'generation', 'dirty', 'busy', 'rendering', 'paused'],
  emits: ['voice'],
  setup(_props, { emit }) { emit('voice', stubVoice); return () => h('div', { 'data-testid': 'draft-audio-stub' }); },
});
const segments = [{ kind: 'narration', speakerNpcId: null, text: 'The room falls silent.', recipientCharacterIds: [], delivery: 'neutral' }];
const continuity = [{ kind: 'world_fact', factId: 'fact-1', text: 'The ledger has a buyer.', visibility: 'public', sourceSubmissionIds: ['say-1'] }];

function beat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beat-2', sessionId: 'show', kind: 'conversation', phase: 'collecting', revision: 3, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], classification: 'ordinary', stakesApproved: false, inputSnapshotHash: null,
    resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null, ...overrides,
  };
}

function snapshot(activeBeat: Record<string, unknown> | null, status = 'live', extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 4, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [{ id: 'pc-1', displayName: 'Skooty' }], npcs: [{ id: 'mara', displayName: 'Mara', role: 'Bartender', status: 'present' }], tracks: [], facts: [], activeBeat, history: [],
    submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: '', ...extra,
  };
}

const locked = (overrides: Record<string, unknown> = {}) => beat({ phase: 'locked', stakesApproved: true, resolution: { rolls: [], outcomes: [], effects: [] }, ...overrides });
const review = (overrides: Record<string, unknown> = {}) => locked({ phase: 'draft_review', draftRevision: 1, draft: { segments, continuity: [], directorSummary: '' }, ...overrides });
const pending = () => review({ draft: { segments, continuity, directorSummary: '' } });

let table: Table;
async function mountPanel(state: ReturnType<typeof snapshot>, selected: string[] = [], extra: Record<string, unknown> = {}) {
  transport.snapshot.mockResolvedValue(state);
  const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(BeatPanel, { selected, ...extra }); } });
  const wrapper = mount(Host, { global: { stubs: { DraftAudioPanel: DraftAudioPanelStub } } });
  await table.refresh();
  await flushPromises();
  return wrapper;
}

const bar = (wrapper: VueWrapper) => wrapper.get('[aria-label="Beat actions"]');
const buttonNamed = (wrapper: VueWrapper, name: string) => wrapper.findAll('button').find(button => button.text() === name);
const goldButtons = (wrapper: VueWrapper) => wrapper.findAll('button').filter(button => !button.classes('secondary') && !button.classes('quiet') && !button.classes('script-line')).map(button => button.text());
const more = (wrapper: VueWrapper) => wrapper.get('[data-testid="beat-more"]');
const outsideMore = (wrapper: VueWrapper) => bar(wrapper).findAll('button').filter(button => !more(wrapper).element.contains(button.element));
const sentTypes = () => transport.command.mock.calls.map(call => call[1].type);
const line = (id: string, kind = 'say', characterId = 'pc-1') => ({ id, sessionId: 'show', characterId, contextBeatId: null, inputEpoch: 0, revision: 1, kind, text: `Line ${id}`, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'queued' });
const actionContract = (overrides: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333', version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], submissionIds: ['act-1'], ruling: 'check', intent: 'Pick the lock.', approach: 'Quietly.', trait: 'finesse', edge: 0, edgeReason: null, risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
  outcomes: { clean: { publicText: 'It opens.', effects: [] }, costly: { publicText: 'It opens loudly.', effects: [] }, setback: { publicText: 'It jams.', effects: [] } }, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  stubVoice = READY;
  transport.subscribe.mockReturnValue(() => {});
  transport.command.mockResolvedValue({});
  window.history.replaceState({}, '', '/sessions/show/director');
});
afterEach(() => { document.body.innerHTML = ''; });

describe('beat panel action bar', () => {
  const ordinaryStakes = beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'] });
  const actionStakes = beat({ phase: 'stakes_review', selectedSubmissionIds: ['act-1'], kind: 'action', classification: 'needs_action', contracts: [actionContract()] });
  it.each([
    ['no beat and no ticked lines', snapshot(null), [], 'Answer these lines', 'answer-lines', false],
    ['no beat with ticked lines', snapshot(null), ['say-1'], 'Answer these lines', 'answer-lines', true],
    ['an open conversation with nothing ticked', snapshot(beat()), [], 'Plan and draft', 'plan-and-draft', false],
    ['an open conversation with ticked lines', snapshot(beat()), ['say-1'], 'Plan and draft', 'plan-and-draft', true],
    ['an open action round with ticked lines', snapshot(beat({ kind: 'action' })), ['act-1'], 'Plan', 'plan', true],
    ['ordinary stakes', snapshot(ordinaryStakes), ['say-1'], 'Lock and draft', 'lock-and-draft', true],
    ['approved ordinary stakes', snapshot(beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], stakesApproved: true })), ['say-1'], 'Lock and draft', 'lock-and-draft', true],
    ['action stakes', snapshot(actionStakes), ['act-1'], 'Approve and roll', 'approve-and-roll', true],
    ['a locked beat without a draft', snapshot(locked()), [], 'Draft the scene', 'render', true],
    ['a failed draft', snapshot(locked({ lastError: 'The AI timed out.' })), [], 'Try again', 'render', true],
    ['a draft ready to publish', snapshot(review()), [], 'Publish', 'publish', true],
    ['a draft with facts waiting', snapshot(pending()), [], 'Publish', 'publish', true],
    ['a paused show', snapshot(review(), 'paused'), [], 'Resume show', 'resume-show', true],
  ])('shows exactly one gold button for %s', async (_label, state, selected, gold, testId, enabled) => {
    const wrapper = await mountPanel(state, selected);
    expect(goldButtons(wrapper)).toEqual([gold]);
    const button = bar(wrapper).get(`[data-testid="${testId}"]`);
    expect(button.text()).toBe(gold);
    expect(button.classes()).not.toContain('secondary');
    expect(more(wrapper).element.contains(button.element)).toBe(false);
    expect(button.attributes('disabled') === undefined).toBe(enabled);
    expect(more(wrapper).element.tagName).toBe('DETAILS');
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(false);
    expect(more(wrapper).get('summary').text()).toBe('More');
    wrapper.unmount();
  });

  it('keeps Open action round beside the gold button and Open conversation under More', async () => {
    const wrapper = await mountPanel(snapshot(null), ['say-1']);
    const beside = outsideMore(wrapper).map(button => button.attributes('data-testid'));
    expect(beside).toEqual(['answer-lines', 'open-action']);
    expect(wrapper.get('[data-testid="open-action"]').classes()).toContain('secondary');
    expect(more(wrapper).find('[data-testid="open-conversation"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="abort-beat"]').exists()).toBe(false);
    await wrapper.get('[data-testid="open-action"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'open_beat', kind: 'action' }));
    wrapper.unmount();
  });

  it('puts the stakes step rare buttons and the Abandon fold under More', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes), ['say-1']);
    expect(more(wrapper).get('[data-testid="approve-stakes"]').text()).toBe('Approve stakes');
    expect(more(wrapper).get('[data-testid="lock"]').text()).toBe('Roll the dice');
    expect(more(wrapper).get('[data-testid="lock"]').attributes('disabled')).toBeDefined();
    expect(more(wrapper).get('[data-testid="plan-again"]').text()).toBe('Plan again');
    const abandon = more(wrapper).get('details.beat-abandon');
    expect(abandon.get('summary').text()).toBe('Abandon this beat');
    expect(abandon.get('[data-testid="abort-beat"]').text()).toBe('Abandon beat');
    expect(abandon.find('[data-testid="abort-reason"]').exists()).toBe(true);
    for (const button of bar(wrapper).findAll('button').filter(item => item.text() !== 'Lock and draft')) expect(button.classes().some(name => name === 'secondary' || name === 'quiet')).toBe(true);
    expect(wrapper.get('h2').text()).toBe('Conversation');
    wrapper.unmount();
  });

  it('enables Roll the dice only for approved, unchanged stakes and Approve stakes only approves', async () => {
    const wrapper = await mountPanel(snapshot(beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], stakesApproved: true })), ['say-1']);
    expect(wrapper.get('[data-testid="lock"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="approve-stakes"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['approve_stakes']);
    await wrapper.get('[data-testid="lock"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['approve_stakes', 'lock_beat']);
    wrapper.unmount();
  });

  it('plans again with the ticked lines and nothing more', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes, 'live', { submissions: [line('say-1')] }), ['say-1']);
    await wrapper.get('[data-testid="plan-again"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['plan_beat']);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ submissionIds: ['say-1'] });
    wrapper.unmount();
  });

  it('keeps Regenerate script under More and shows Save edits only while the script is edited', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    expect(more(wrapper).get('[data-testid="regenerate"]').text()).toBe('Regenerate script');
    expect(wrapper.find('[data-testid="save-script"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="render"]').exists()).toBe(false);
    await wrapper.get('[data-testid="script-line-0"]').trigger('click');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Unsaved words.');
    await flushPromises();
    expect(more(wrapper).get('[data-testid="save-script"]').text()).toBe('Save edits');
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(true);
    expect(goldButtons(wrapper)).toEqual(['Publish']);
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="publish-text-only"]').attributes('disabled')).toBeDefined();
    expect(bar(wrapper).get('[data-testid="beat-next"]').text()).toContain('Save your edits under More before publishing.');
    await wrapper.get('[data-testid="save-script"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: [expect.objectContaining({ text: 'Unsaved words.' })] }));
    wrapper.unmount();
  });

  it('offers Save edits for a hand-written script before any draft exists', async () => {
    const wrapper = await mountPanel(snapshot(locked()));
    expect(wrapper.find('[data-testid="save-script"]').exists()).toBe(false);
    await wrapper.get('[data-testid="script-add-line"]').setValue('narration');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('The lamps gutter.');
    await flushPromises();
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(true);
    await more(wrapper).get('[data-testid="save-script"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'edit_script', segments: [expect.objectContaining({ text: 'The lamps gutter.' })] }));
    wrapper.unmount();
  });

  it('counts the steps for a conversation and an action round', async () => {
    const cases: Array<[ReturnType<typeof snapshot>, string[], string]> = [
      [snapshot(null), [], 'Step 1 of 3'],
      [snapshot(ordinaryStakes), ['say-1'], 'Step 1 of 3'],
      [snapshot(locked()), [], 'Step 2 of 3'],
      [snapshot(review()), [], 'Step 3 of 3'],
      [snapshot(beat({ kind: 'action' })), ['act-1'], 'Step 2 of 5'],
      [snapshot(actionStakes), ['act-1'], 'Step 3 of 5'],
      [snapshot(review({ kind: 'action' })), [], 'Step 5 of 5'],
    ];
    for (const [state, selected, text] of cases) {
      const wrapper = await mountPanel(state, selected);
      expect(wrapper.get('[data-testid="beat-step-count"]').text()).toBe(text);
      wrapper.unmount();
    }
  });

  it('keeps a space between the next sentence and the reason', async () => {
    const wrapper = await mountPanel(snapshot(beat()));
    expect(bar(wrapper).get('[data-testid="beat-next"]').text()).toBe('Tick the lines this beat should answer. Select at least one line to plan.');
    wrapper.unmount();
  });

  it('shows the beat error plainly in the bar and nowhere else', async () => {
    const wrapper = await mountPanel(snapshot(locked({ lastError: 'The AI timed out.' })));
    const shown = bar(wrapper).get('[data-testid="beat-error"]');
    expect(shown.text()).toBe('The AI timed out.');
    expect(shown.attributes('role')).toBe('alert');
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('enables only Resume show while paused, and Resume show sends set_status live', async () => {
    for (const [state, selected] of [[snapshot(null, 'paused'), ['say-1']], [snapshot(ordinaryStakes, 'paused'), ['say-1']], [snapshot(review(), 'paused'), []]] as const) {
      const wrapper = await mountPanel(state, [...selected]);
      const enabled = bar(wrapper).findAll('button').filter(button => button.attributes('disabled') === undefined).map(button => button.text());
      expect(enabled).toEqual(['Resume show']);
      expect(bar(wrapper).text()).toContain('The show is paused.');
      await wrapper.get('[data-testid="resume-show"]').trigger('click'); await flushPromises();
      expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'set_status', status: 'live', expectedStateRevision: 4 }));
      expect(sentTypes()).toEqual(['set_status']);
      transport.command.mockClear();
      wrapper.unmount();
    }
  });

  it('focuses the gold action', async () => {
    transport.snapshot.mockResolvedValue(snapshot(review()));
    const panel = { current: null as null | { focusPrimary: () => void } };
    const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(BeatPanel, { selected: [], ref: (value: unknown) => { panel.current = value as typeof panel.current; } }); } });
    const wrapper = mount(Host, { attachTo: document.body, global: { stubs: { DraftAudioPanel: DraftAudioPanelStub } } });
    await table.refresh();
    await flushPromises();
    panel.current!.focusPrimary();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="publish"]').element);
    wrapper.unmount();
  });
});

describe('beat panel chains', () => {
  const collecting = (overrides: Record<string, unknown> = {}) => beat({ revision: 0, ...overrides });
  const planned = (overrides: Record<string, unknown> = {}) => beat({ phase: 'stakes_review', revision: 1, selectedSubmissionIds: ['say-1', 'say-2'], classification: 'ordinary', ...overrides });
  const queue = (...states: Array<ReturnType<typeof snapshot>>) => {
    transport.snapshot.mockReset();
    for (const state of states) transport.snapshot.mockResolvedValueOnce(state);
    transport.snapshot.mockResolvedValue(states[states.length - 1]);
  };
  const lines = { submissions: [line('say-1'), line('say-2'), line('ooc-1', 'ooc')] };

  it('answers the ticked lines: open, plan in snapshot order, then approve, lock and draft with fresh revisions', async () => {
    const wrapper = await mountPanel(snapshot(null, 'live', lines), ['say-2', 'say-1']);
    queue(
      snapshot(collecting(), 'live', lines),
      snapshot(planned(), 'live', lines),
      snapshot(planned({ revision: 2, stakesApproved: true }), 'live', lines),
      snapshot(locked({ revision: 3 }), 'live', lines),
      snapshot(review({ revision: 4 }), 'live', lines),
    );
    await wrapper.get('[data-testid="answer-lines"]').trigger('click'); await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['open_beat', 'plan_beat', 'approve_stakes', 'lock_beat', 'render_beat']);
    expect(sent[0]).toMatchObject({ kind: 'conversation', expectedInputEpoch: 0 });
    expect(sent[1]).toMatchObject({ submissionIds: ['say-1', 'say-2'], expectedBeatRevision: 0 });
    expect(sent[2]).toMatchObject({ classification: 'ordinary', contracts: [], expectedBeatRevision: 1 });
    expect(sent.slice(3).map(command => command.expectedBeatRevision)).toEqual([2, 3]);
    expect(new Set(sent.map(command => command.commandId)).size).toBe(5);
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('keeps the starting button label for the whole Answer these lines chain', async () => {
    const wrapper = await mountPanel(snapshot(null, 'live', lines), ['say-1', 'say-2']);
    queue(
      snapshot(collecting(), 'live', lines),
      snapshot(planned(), 'live', lines),
      snapshot(planned({ revision: 2, stakesApproved: true }), 'live', lines),
      snapshot(locked({ revision: 3 }), 'live', lines),
      snapshot(review({ revision: 4 }), 'live', lines),
    );
    const finish: Array<() => void> = [];
    transport.command.mockImplementation(() => new Promise(resolve => { finish.push(() => resolve({})); }));
    const goldText = () => goldButtons(wrapper);
    expect(goldText()).toEqual(['Answer these lines']);
    await wrapper.get('[data-testid="answer-lines"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat']);
    expect(goldText()).toEqual(['Answer these lines']);
    finish[0](); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat']);
    expect(goldText()).toEqual(['Answer these lines']);
    finish[1](); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat', 'approve_stakes']);
    expect(goldText()).toEqual(['Answer these lines']);
    finish[2](); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat', 'approve_stakes', 'lock_beat']);
    expect(goldText()).toEqual(['Answer these lines']);
    finish[3](); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat', 'approve_stakes', 'lock_beat', 'render_beat']);
    expect(goldText()).toEqual(['Answer these lines']);
    finish[4](); await flushPromises();
    expect(goldText()).toEqual(['Publish']);
    wrapper.unmount();
  });

  it('plans at most 12 lines, the oldest first, and leaves the rest ticked', async () => {
    const many = { submissions: Array.from({ length: 14 }, (_, index) => line(`say-${index + 1}`)) };
    const ticked = many.submissions.map(item => item.id).reverse();
    const wrapper = await mountPanel(snapshot(beat(), 'live', many), ticked);
    queue(snapshot(planned({ classification: 'needs_action' }), 'live', many));
    await wrapper.get('[data-testid="plan-and-draft"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['plan_beat']);
    expect(transport.command.mock.calls[0][1].submissionIds).toEqual(many.submissions.slice(0, 12).map(item => item.id));
    wrapper.unmount();
  });

  it('stops at the stakes step when the plan needs dice', async () => {
    const wrapper = await mountPanel(snapshot(null, 'live', lines), ['say-1']);
    queue(snapshot(collecting(), 'live', lines), snapshot(planned({ classification: 'needs_action' }), 'live', lines));
    await wrapper.get('[data-testid="answer-lines"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat']);
    expect(goldButtons(wrapper)).toEqual(['Approve and roll']);
    wrapper.unmount();
  });

  it('stops at the stakes step when a ticked line is an action', async () => {
    const withAct = { submissions: [line('say-1'), line('act-1', 'act')] };
    const wrapper = await mountPanel(snapshot(beat(), 'live', withAct), ['say-1', 'act-1']);
    queue(snapshot(planned({ selectedSubmissionIds: ['say-1', 'act-1'] }), 'live', withAct));
    await wrapper.get('[data-testid="plan-and-draft"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['plan_beat']);
    wrapper.unmount();
  });

  it('stops when planning fails and shows the error in the bar', async () => {
    const wrapper = await mountPanel(snapshot(null, 'live', lines), ['say-1']);
    queue(snapshot(collecting(), 'live', lines), snapshot(collecting({ revision: 1, selectedSubmissionIds: ['say-1'], lastError: 'The planner timed out.' }), 'live', lines));
    await wrapper.get('[data-testid="answer-lines"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['open_beat', 'plan_beat']);
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('The planner timed out.');
    wrapper.unmount();
  });

  it('stops a chain at a refused step with its error in the bar, not the page notice', async () => {
    const wrapper = await mountPanel(snapshot(beat(), 'live', lines), ['say-1']);
    queue(snapshot(planned(), 'live', lines), snapshot(planned({ revision: 2, stakesApproved: true }), 'live', lines));
    transport.command.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('The beat changed.'));
    await wrapper.get('[data-testid="plan-and-draft"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['plan_beat', 'approve_stakes', 'lock_beat']);
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('The beat changed.');
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('plans an action round without going further', async () => {
    const acts = { submissions: [line('act-1', 'act')] };
    const wrapper = await mountPanel(snapshot(beat({ kind: 'action' }), 'live', acts), ['act-1']);
    queue(snapshot(planned({ kind: 'action', selectedSubmissionIds: ['act-1'] }), 'live', acts));
    await wrapper.get('[data-testid="plan"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['plan_beat']);
    wrapper.unmount();
  });

  it('approves the reviewed stakes, then locks (the server rolls) and drafts', async () => {
    const acts = { submissions: [line('act-1', 'act')] };
    const stakes = beat({ phase: 'stakes_review', kind: 'action', classification: 'needs_action', selectedSubmissionIds: ['act-1'], contracts: [actionContract()] });
    const wrapper = await mountPanel(snapshot(stakes, 'live', acts), ['act-1']);
    await wrapper.get('[data-testid="stakes-edit-33333333-3333-4333-8333-333333333333"]').trigger('click');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('It opens, and the guard hears.');
    queue(
      snapshot({ ...stakes, revision: 4, stakesApproved: true, classification: 'action' }, 'live', acts),
      snapshot(locked({ kind: 'action', revision: 5 }), 'live', acts),
      snapshot(review({ kind: 'action', revision: 6 }), 'live', acts),
    );
    await wrapper.get('[data-testid="approve-and-roll"]').trigger('click'); await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['approve_stakes', 'lock_beat', 'render_beat']);
    expect(sent[0]).toMatchObject({ classification: 'action', expectedBeatRevision: 3 });
    expect(sent[0].contracts).toHaveLength(1);
    expect(sent[0].contracts[0].outcomes.costly.publicText).toBe('It opens, and the guard hears.');
    expect(sent.slice(1).map(command => command.expectedBeatRevision)).toEqual([4, 5]);
    wrapper.unmount();
  });

  it('keeps an incomplete stakes check in the bar without sending anything', async () => {
    const stakes = beat({ phase: 'stakes_review', kind: 'action', classification: 'needs_action', selectedSubmissionIds: ['act-1'], contracts: [actionContract()] });
    const wrapper = await mountPanel(snapshot(stakes), ['act-1']);
    await wrapper.get('[data-testid="stakes-edit-33333333-3333-4333-8333-333333333333"]').trigger('click');
    await wrapper.get('[data-testid="outcome-setback"]').setValue('  ');
    await wrapper.get('[data-testid="approve-and-roll"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('Fill in the goal, approach, and all three outcome branches before approving stakes.');
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('tries the draft again after a failure', async () => {
    const wrapper = await mountPanel(snapshot(locked({ lastError: 'The AI timed out.' })));
    await wrapper.get('[data-testid="render"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'render_beat', beatId: 'beat-2', expectedBeatRevision: 3 }));
    wrapper.unmount();
  });
});

describe('beat panel status', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('counts the seconds while planning and clears the count when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = await mountPanel(snapshot(beat(), 'live', { submissions: [line('say-1')] }), ['say-1']);
    let finish: (value: unknown) => void = () => {};
    transport.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await wrapper.get('[data-testid="plan-and-draft"]').trigger('click'); await flushPromises();
    expect(bar(wrapper).get('[data-testid="beat-status"]').text()).toBe('Planning… 0 s');
    vi.advanceTimersByTime(4000); await flushPromises();
    expect(bar(wrapper).get('[data-testid="beat-status"]').text()).toBe('Planning… 4 s');
    transport.snapshot.mockResolvedValue(snapshot(beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], classification: 'needs_action', revision: 4 })));
    finish({}); await flushPromises();
    expect(bar(wrapper).find('[data-testid="beat-status"]').exists()).toBe(false);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows Writing the script for a running job found after a reload and stops the timer on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const job = { id: 'job-1', beatId: 'beat-2', task: 'render', generation: 1, status: 'running', error: null };
    const wrapper = await mountPanel(snapshot(locked(), 'live', { jobs: [job] }));
    expect(bar(wrapper).get('[data-testid="beat-status"]').text()).toBe('Writing the script… 0 s');
    expect(wrapper.get('[data-testid="render"]').attributes('disabled')).toBeDefined();
    vi.advanceTimersByTime(9000); await flushPromises();
    expect(bar(wrapper).get('[data-testid="beat-status"]').text()).toBe('Writing the script… 9 s');
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('beat panel safeguards', () => {
  it('asks before regenerating an existing draft', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Replace the current draft? Saved script edits are discarded; the dice stay the same.');
    await buttonNamed(wrapper, 'Keep draft')!.trigger('click');
    expect(wrapper.text()).not.toContain('Replace the current draft?');
    expect(transport.command).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="regenerate"]').trigger('click');
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

  it('passes the paused state to the draft audio panel', async () => {
    let wrapper = await mountPanel(snapshot(review(), 'paused'));
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('paused')).toBe(true);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.getComponent({ name: 'DraftAudioPanel' }).props('paused')).toBe(false);
    wrapper.unmount();
  });
});

describe('beat panel publish', () => {
  const panel = (wrapper: VueWrapper) => wrapper.getComponent(BeatPanel);
  const voice = async (wrapper: VueWrapper, state: Record<string, unknown>) => { wrapper.getComponent({ name: 'DraftAudioPanel' }).vm.$emit('voice', state); await flushPromises(); };
  const status = (wrapper: VueWrapper) => bar(wrapper).find('[data-testid="beat-status"]');
  const reload = async (state: ReturnType<typeof snapshot>) => { transport.snapshot.mockResolvedValue(state); await table.refresh(); await flushPromises(); };

  it('publishes with the ready recording and reports a voiced publish', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    expect(status(wrapper).text()).toBe('Voice ready');
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Publish');
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['publish_beat']);
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'publish_beat', textOnly: false, audioPreparationId: AUDIO_ID, draftRevision: 1, expectedStateRevision: 4 }));
    expect(panel(wrapper).emitted('published')).toEqual([['beat-2', true]]);
    wrapper.unmount();
  });

  it('publishes text only from Publish without voice', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    const textOnly = bar(wrapper).get('[data-testid="publish-text-only"]');
    expect(textOnly.text()).toBe('Publish without voice');
    expect(textOnly.classes()).toContain('secondary');
    expect(more(wrapper).element.contains(textOnly.element)).toBe(false);
    await textOnly.trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['publish_beat']);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ textOnly: true });
    expect(transport.command.mock.calls[0][1]).not.toHaveProperty('audioPreparationId');
    expect(panel(wrapper).emitted('published')).toEqual([['beat-2', false]]);
    wrapper.unmount();
  });

  it('hides Publish without voice when speech is unavailable, and Publish then sends text only', async () => {
    stubVoice = { status: 'unavailable' };
    const wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.find('[data-testid="publish-text-only"]').exists()).toBe(false);
    expect(status(wrapper).exists()).toBe(false);
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command.mock.calls[0][1]).toMatchObject({ type: 'publish_beat', textOnly: true });
    expect(transport.command.mock.calls[0][1]).not.toHaveProperty('audioPreparationId');
    expect(panel(wrapper).emitted('published')).toEqual([['beat-2', false]]);
    wrapper.unmount();
  });

  it('disables the gold Publish when the voice failed and keeps Publish without voice', async () => {
    stubVoice = { status: 'failed', message: 'The voice could not be prepared.' };
    const wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Publish');
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="publish-text-only"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('waits for a voice still preparing, then publishes with it', async () => {
    stubVoice = { status: 'preparing' };
    const wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Preparing voice…');
    expect(status(wrapper).text()).toBe('Preparing voice…');
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(status(wrapper).text()).toBe('Waiting for the voice, then publishing…');
    await voice(wrapper, READY);
    expect(sentTypes()).toEqual(['publish_beat']);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ textOnly: false, audioPreparationId: AUDIO_ID });
    expect(panel(wrapper).emitted('published')).toEqual([['beat-2', true]]);
    wrapper.unmount();
  });

  it('waits through a check too', async () => {
    stubVoice = { status: 'checking' };
    const wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Preparing voice…');
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    await voice(wrapper, { status: 'preparing' });
    expect(transport.command).not.toHaveBeenCalled();
    await voice(wrapper, READY);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ type: 'publish_beat', audioPreparationId: AUDIO_ID });
    wrapper.unmount();
  });

  it('keeps a pending publish through preparing, checking and ready', async () => {
    stubVoice = { status: 'preparing' };
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(status(wrapper).text()).toBe('Waiting for the voice, then publishing…');
    await voice(wrapper, { status: 'checking' });
    expect(transport.command).not.toHaveBeenCalled();
    expect(status(wrapper).text()).toBe('Waiting for the voice, then publishing…');
    await voice(wrapper, READY);
    expect(sentTypes()).toEqual(['publish_beat']);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ textOnly: false, audioPreparationId: AUDIO_ID });
    wrapper.unmount();
  });

  it('shows one line in the bar when the voice failed', async () => {
    stubVoice = { status: 'failed', message: 'The voice could not be prepared.' };
    const wrapper = await mountPanel(snapshot(review()));
    expect(bar(wrapper).get('[data-testid="voice-failed"]').text()).toBe('The voice could not be prepared. Press Prepare voice again, or Publish without voice.');
    await voice(wrapper, READY);
    expect(wrapper.find('[data-testid="voice-failed"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the playback error line and asks to start the narration again', async () => {
    let wrapper = await mountPanel(snapshot(null));
    expect(wrapper.find('[data-testid="playback-error"]').exists()).toBe(false);
    wrapper.unmount();
    wrapper = await mountPanel(snapshot(null), [], { playbackError: 'The narration did not start. Blocked.' });
    const line = bar(wrapper).get('[data-testid="playback-error"]');
    expect(line.attributes('role')).toBe('alert');
    expect(line.text()).toContain('The narration did not start. Blocked.');
    const button = line.get('[data-testid="start-playback"]');
    expect(button.text()).toBe('Play latest reviewed beat');
    await button.trigger('click');
    expect(wrapper.getComponent(BeatPanel).emitted('start-playback')).toEqual([[]]);
    wrapper.unmount();
  });

  it('stops waiting when the voice fails', async () => {
    stubVoice = { status: 'preparing' };
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    await voice(wrapper, { status: 'failed', message: 'No voice.' });
    expect(status(wrapper).exists()).toBe(false);
    await voice(wrapper, READY);
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('stops waiting when the script is edited', async () => {
    stubVoice = { status: 'preparing' };
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="script-line-0"]').trigger('click');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('Unsaved words.');
    await flushPromises();
    expect(wrapper.get('[data-testid="publish"]').text()).toBe('Publish');
    expect(bar(wrapper).text()).not.toContain('Waiting for the voice');
    await voice(wrapper, READY);
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('stops waiting when a render starts or the draft changes', async () => {
    stubVoice = { status: 'preparing' };
    let wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    await reload(snapshot(review(), 'live', { jobs: [{ id: 'job-1', beatId: 'beat-2', task: 'render', generation: 1, status: 'queued', error: null }] }));
    await reload(snapshot(review()));
    await voice(wrapper, READY);
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();

    wrapper = await mountPanel(snapshot(review()));
    await voice(wrapper, { status: 'preparing' });
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    await reload(snapshot(review({ draftRevision: 2 })));
    await voice(wrapper, READY);
    expect(transport.command).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('lists the facts to remember and keeps them before publishing', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    const facts = wrapper.get('[data-testid="facts-to-remember"]');
    expect(facts.text()).toContain('Facts to remember');
    expect(facts.text()).toContain('World fact: The ledger has a buyer.');
    expect(facts.get('label').text()).toBe("Don't keep these");
    expect((wrapper.get('[data-testid="skip-facts"]').element as HTMLInputElement).checked).toBe(false);
    expect(bar(wrapper).element.contains(facts.element)).toBe(false);
    expect(buttonNamed(wrapper, 'Approve continuity updates')).toBeUndefined();
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['approve_continuity', 'publish_beat']);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ beatId: 'beat-2', updates: continuity });
    expect(transport.command.mock.calls[1][1]).toMatchObject({ audioPreparationId: AUDIO_ID });
    expect(wrapper.text()).not.toContain('Publish anyway');
    wrapper.unmount();
  });

  it('keeps the facts before Publish without voice too', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    await wrapper.get('[data-testid="publish-text-only"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['approve_continuity', 'publish_beat']);
    expect(transport.command.mock.calls[1][1]).toMatchObject({ textOnly: true });
    wrapper.unmount();
  });

  it('publishes without the facts when Don\'t keep these is ticked, and unticks it for a new draft', async () => {
    const wrapper = await mountPanel(snapshot(pending()));
    await wrapper.get('[data-testid="skip-facts"]').setValue(true);
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['publish_beat']);
    await reload(snapshot(review({ draftRevision: 2, draft: { segments, continuity, directorSummary: '' } })));
    expect((wrapper.get('[data-testid="skip-facts"]').element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });

  it('hides the facts once they are kept', async () => {
    const wrapper = await mountPanel(snapshot(review({ draft: { segments, continuity, directorSummary: '' }, approvedContinuity: continuity })));
    expect(wrapper.find('[data-testid="facts-to-remember"]').exists()).toBe(false);
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['publish_beat']);
    wrapper.unmount();
  });

  it('does not publish when keeping the facts is refused, and shows why in the bar', async () => {
    transport.command.mockRejectedValueOnce(new Error('Review a script before approving continuity.'));
    const wrapper = await mountPanel(snapshot(pending()));
    await wrapper.get('[data-testid="publish"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['approve_continuity']);
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('Review a script before approving continuity.');
    expect(panel(wrapper).emitted('published')).toBeUndefined();
    wrapper.unmount();
  });

  it('says when the show audio is missing without blocking Publish', async () => {
    let wrapper = await mountPanel(snapshot(review()), [], { showAudio: 'none' });
    expect(bar(wrapper).get('[data-testid="no-show-audio"]').text()).toBe("No show audio: the main show link isn't open in OBS.");
    expect(wrapper.get('[data-testid="publish"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
    for (const showAudio of ['presenting', 'checking', 'unknown']) {
      wrapper = await mountPanel(snapshot(review()), [], { showAudio });
      expect(wrapper.find('[data-testid="no-show-audio"]').exists()).toBe(false);
      wrapper.unmount();
    }
    wrapper = await mountPanel(snapshot(locked()), [], { showAudio: 'none' });
    expect(wrapper.find('[data-testid="no-show-audio"]').exists()).toBe(false);
    wrapper.unmount();
    stubVoice = { status: 'unavailable' };
    wrapper = await mountPanel(snapshot(review()), [], { showAudio: 'none' });
    expect(wrapper.find('[data-testid="no-show-audio"]').exists()).toBe(false);
    wrapper.unmount();
  });

});

describe('beat panel lock and draft', () => {
  const ordinaryStakes = (overrides: Record<string, unknown> = {}) => beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], ...overrides });

  it('does not offer Lock and draft for an action', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes({ classification: 'needs_action' })), ['say-1']);
    expect(buttonNamed(wrapper, 'Lock and draft')).toBeUndefined();
    expect(goldButtons(wrapper)).toEqual(['Approve and roll']);
    wrapper.unmount();
  });

  it('shows the ordinary sentence in the bar', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes()), ['say-1']);
    expect(bar(wrapper).get('[data-testid="beat-next"]').text()).toBe('Ordinary conversation. Lock and draft writes the script.');
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

  it('stops at the first error and shows it in the bar', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes({ revision: 3 })), ['say-1']);
    transport.snapshot.mockReset();
    transport.snapshot.mockResolvedValue(snapshot(ordinaryStakes({ revision: 4, stakesApproved: true, classification: 'ordinary' })));
    transport.command.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('The beat changed.'));
    await buttonNamed(wrapper, 'Lock and draft')!.trigger('click'); await flushPromises();
    expect(transport.command.mock.calls.map(call => call[1].type)).toEqual(['approve_stakes', 'lock_beat']);
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('The beat changed.');
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('does nothing while the show is paused', async () => {
    const wrapper = await mountPanel(snapshot(ordinaryStakes(), 'paused'), ['say-1']);
    expect(buttonNamed(wrapper, 'Lock and draft')).toBeUndefined();
    expect(wrapper.get('[data-testid="approve-stakes"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('beat panel fix pass: bar sentences and dice', () => {
  const stakes = (overrides: Record<string, unknown> = {}) => beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'], ...overrides });
  const rolled = { rolls: [{ id: 'r1', actorCharacterId: 'pc-1', faces: [3, 4], traitModifier: 1, edge: false, total: 8, band: 'success' }], outcomes: [], effects: [] };

  it('does not say the stakes changed for a conversation the AI marked needs_action and nobody approved', async () => {
    const wrapper = await mountPanel(snapshot(stakes({ classification: 'needs_action', contracts: [actionContract()] })), ['say-1']);
    expect(bar(wrapper).get('[data-testid="beat-next"]').text()).not.toContain('Stakes changed');
    wrapper.unmount();
  });

  it('names Lock and draft in the sentence for approved ordinary stakes, matching the gold button', async () => {
    const wrapper = await mountPanel(snapshot(stakes({ stakesApproved: true })), ['say-1']);
    expect(bar(wrapper).get('[data-testid="beat-next"]').text()).toContain('Lock and draft');
    expect(goldButtons(wrapper)).toEqual(['Lock and draft']);
    wrapper.unmount();
  });

  it("shows What's at risk once during stakes review and names the round in the heading", async () => {
    const wrapper = await mountPanel(snapshot(stakes()), ['say-1']);
    expect(wrapper.text().split("What's at risk").length - 1).toBe(1);
    expect(wrapper.get('h2').text()).toBe('Conversation');
    wrapper.unmount();
    const action = await mountPanel(snapshot(stakes({ kind: 'action', classification: 'needs_action', contracts: [actionContract()] })), ['act-1']);
    expect(action.get('h2').text()).toBe('Action round');
    action.unmount();
  });

  it('shows the dice sentence only when the beat has rolls', async () => {
    const none = await mountPanel(snapshot(review()), []);
    expect(none.text()).not.toContain('The dice are rolled.');
    expect(none.text()).not.toContain('Input and results are fixed');
    none.unmount();
    const withRolls = await mountPanel(snapshot(review({ kind: 'action', classification: 'needs_action', resolution: rolled })), []);
    expect(withRolls.text()).toContain('The dice are rolled. Regenerating the script keeps them.');
    withRolls.unmount();
  });

  describe('lock and draft stops when a step did not land', () => {
    async function run(afterApprove: Record<string, unknown>, afterLock?: Record<string, unknown>) {
      const wrapper = await mountPanel(snapshot(stakes({ revision: 3 })), ['say-1']);
      transport.snapshot.mockReset();
      transport.snapshot.mockResolvedValueOnce(snapshot(afterApprove));
      if (afterLock) transport.snapshot.mockResolvedValueOnce(snapshot(afterLock));
      transport.snapshot.mockResolvedValue(snapshot(afterLock ?? afterApprove));
      transport.command.mockReset();
      transport.command.mockResolvedValue({});
      await buttonNamed(wrapper, 'Lock and draft')!.trigger('click'); await flushPromises();
      wrapper.unmount();
    }

    it('does not lock when the stakes were not approved', async () => {
      await run(stakes({ revision: 4, stakesApproved: false }));
      expect(sentTypes()).toEqual(['approve_stakes']);
    });

    it('does not lock when the approval left an error', async () => {
      await run(stakes({ revision: 4, stakesApproved: true, lastError: 'The beat changed.' }));
      expect(sentTypes()).toEqual(['approve_stakes']);
    });

    it('does not draft when the beat is not locked', async () => {
      await run(stakes({ revision: 4, stakesApproved: true }), stakes({ revision: 5, stakesApproved: true }));
      expect(sentTypes()).toEqual(['approve_stakes', 'lock_beat']);
    });
  });
});

describe('beat panel stage length cue', () => {
  const CONTRACT_ID = '22222222-2222-4222-8222-222222222222';
  const contract = (intent: string, costly: string) => ({
    id: CONTRACT_ID, version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], submissionIds: ['say-1'], ruling: 'check', intent, approach: 'Carefully.', trait: 'wits', risk: 'normal', edge: 0, dependsOnContractIds: [],
    outcomes: { clean: { publicText: 'It works.', effects: [] }, costly: { publicText: costly, effects: [] }, setback: { publicText: 'It fails.', effects: [] } },
  });
  const actionReview = (intent: string, costly: string) => beat({ phase: 'stakes_review', kind: 'action', classification: 'needs_action', selectedSubmissionIds: ['say-1'], contracts: [contract(intent, costly)] });
  const openEdit = (wrapper: VueWrapper) => wrapper.get(`[data-testid="stakes-edit-${CONTRACT_ID}"]`).trigger('click');

  it('shows no cue for short text', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('Open the ledger.', 'Open, with a cost.')), ['say-1']);
    await openEdit(wrapper);
    expect(wrapper.find('[data-testid="stage-length-costly"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="stage-length-goal"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('flags a costly outcome over 110 characters and keeps Approve and roll usable', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('Open the ledger.', 'x'.repeat(245))), ['say-1']);
    await openEdit(wrapper);
    const cue = wrapper.get('[data-testid="stage-length-costly"]');
    expect(cue.classes()).toContain('over');
    expect(cue.text()).toContain('Too long for the stage');
    expect(cue.text()).toContain('this has 245');
    expect(wrapper.get('[data-testid="approve-and-roll"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('flags a goal over 90 characters and a longer outcome as the text changes', async () => {
    const wrapper = await mountPanel(snapshot(actionReview('g'.repeat(91), 'Fine.')), ['say-1']);
    await openEdit(wrapper);
    const cue = wrapper.get('[data-testid="stage-length-goal"]');
    expect(cue.classes()).toContain('over');
    expect(cue.text()).toContain('it fits about 90 characters and this has 91');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('y'.repeat(111));
    expect(wrapper.get('[data-testid="stage-length-costly"]').classes()).toContain('over');
    wrapper.unmount();
  });
});

describe('beat panel stakes cards', () => {
  const CID = '33333333-3333-4333-8333-333333333333';
  const acts = { submissions: [line('act-1', 'act')] };

  it('shows the stakes as cards, with the ordinary line for an ordinary beat', async () => {
    const wrapper = await mountPanel(snapshot(beat({ phase: 'stakes_review', selectedSubmissionIds: ['say-1'] })), ['say-1']);
    expect(wrapper.get('[data-testid="stakes-cards"]').text()).toContain('Ordinary conversation: no dice, and nothing changes.');
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('builds the contracts when the classification switches to action, then sends the edited ones with Approve and roll', async () => {
    const withLine = { submissions: [line('act-1', 'act')] };
    const stakes = beat({ phase: 'stakes_review', selectedSubmissionIds: ['act-1'] });
    const wrapper = await mountPanel(snapshot(stakes, 'live', withLine), ['act-1']);
    await wrapper.get('[data-testid="stakes-ordinary-edit"]').trigger('click');
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action');
    await flushPromises();
    const card = wrapper.get('[data-testid^="stakes-card-"]');
    expect(card.text()).toContain('Skooty');
    expect(buttonNamed(wrapper, 'Lock and draft')).toBeUndefined();
    expect(goldButtons(wrapper)).toEqual(['Approve and roll']);
    await wrapper.get('[data-testid^="stakes-edit-"]').trigger('click');
    await wrapper.get('[data-testid="outcome-costly"]').setValue('It opens, and a guard looks up.');
    await wrapper.get('[data-testid="outcome-setback"]').setValue('It jams.');
    const queued = [
      snapshot({ ...stakes, revision: 4, stakesApproved: true, classification: 'action' }, 'live', withLine),
      snapshot(locked({ revision: 5 }), 'live', withLine),
      snapshot(review({ revision: 6 }), 'live', withLine),
    ];
    transport.snapshot.mockReset();
    for (const state of queued) transport.snapshot.mockResolvedValueOnce(state);
    transport.snapshot.mockResolvedValue(queued[2]);
    await wrapper.get('[data-testid="approve-and-roll"]').trigger('click'); await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['approve_stakes', 'lock_beat', 'render_beat']);
    expect(sent[0]).toMatchObject({ classification: 'action' });
    expect(sent[0].contracts).toHaveLength(1);
    expect(sent[0].contracts[0]).toMatchObject({ actorCharacterId: 'pc-1', submissionIds: ['act-1'] });
    expect(sent[0].contracts[0].outcomes.costly.publicText).toBe('It opens, and a guard looks up.');
    wrapper.unmount();
  });

  it('keeps the edited contract through a re-render of the same revision', async () => {
    const stakes = beat({ phase: 'stakes_review', kind: 'action', classification: 'needs_action', selectedSubmissionIds: ['act-1'], contracts: [actionContract()] });
    const wrapper = await mountPanel(snapshot(stakes, 'live', acts), ['act-1']);
    await wrapper.get(`[data-testid="stakes-edit-${CID}"]`).trigger('click');
    await wrapper.get('[data-testid="outcome-clean"]').setValue('It opens at once.');
    await table.refresh(); await flushPromises();
    expect((wrapper.get('[data-testid="outcome-clean"]').element as HTMLTextAreaElement).value).toBe('It opens at once.');
    wrapper.unmount();
  });
});

describe('beat panel script editor', () => {
  it('shows the script as lines and sends an edited line with Save edits', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    expect(wrapper.get('[data-testid="script-line-0"]').text()).toBe('Narrator: The room falls silent.');
    expect(wrapper.find('[data-testid="script-segment-0"]').exists()).toBe(false);
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(false);
    await wrapper.get('[data-testid="script-line-0"]').trigger('click');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('The room holds its breath.');
    await flushPromises();
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(true);
    await more(wrapper).get('[data-testid="save-script"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenLastCalledWith('show', expect.objectContaining({ type: 'edit_script', expectedBeatRevision: 3, segments: [expect.objectContaining({ text: 'The room holds its breath.' })] }));
    wrapper.unmount();
  });

  it('adds a narrator line and a present non-player character line from the Add a line box', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="script-add-line"]').setValue('mara');
    await flushPromises();
    expect(wrapper.get('[data-testid="script-line-1"]').text()).toContain('Mara:');
    expect(wrapper.find('[data-testid="script-speaker-1"]').exists()).toBe(true);
    await wrapper.get('[data-testid="script-remove-1"]').trigger('click');
    expect(wrapper.find('[data-testid="script-line-1"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens a blank narration line from Write it myself after a failed draft, and only then', async () => {
    const plain = await mountPanel(snapshot(locked()));
    expect(plain.find('[data-testid="write-it-myself"]').exists()).toBe(false);
    plain.unmount();
    const wrapper = await mountPanel(snapshot(locked({ lastError: 'The AI timed out.' })));
    const button = outsideMore(wrapper).find(item => item.attributes('data-testid') === 'write-it-myself')!;
    expect(button.text()).toBe('Write it myself');
    expect(button.classes()).toContain('secondary');
    expect(goldButtons(wrapper)).toEqual(['Try again']);
    await button.trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="script-line-0"]').text()).toBe('Narrator: (empty line)');
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('');
    expect((more(wrapper).element as HTMLDetailsElement).open).toBe(true);
    expect(more(wrapper).get('[data-testid="save-script"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="script-segment-0"]').setValue('The lamps gutter.');
    await flushPromises();
    expect(more(wrapper).get('[data-testid="save-script"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('beat panel regenerate with a note', () => {
  it('saves the note, then regenerates, in one press with fresh revisions and no confirmation', async () => {
    const wrapper = await mountPanel(snapshot(review({ revision: 3 })));
    transport.snapshot.mockReset();
    transport.snapshot.mockResolvedValueOnce(snapshot(review({ revision: 4, steering: 'Make Mara nervous.' })));
    transport.snapshot.mockResolvedValue(snapshot(review({ revision: 5 })));
    await wrapper.get('[data-testid="steer-text"]').setValue('  Make Mara nervous.  ');
    expect(wrapper.get('[data-testid="steer-text"]').attributes('maxlength')).toBe('3000');
    expect(more(wrapper).text()).toContain('Tell the AI what to change');
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    const sent = transport.command.mock.calls.map(call => call[1]);
    expect(sent.map(command => command.type)).toEqual(['set_beat_steering', 'render_beat']);
    expect(sent[0]).toMatchObject({ beatId: 'beat-2', expectedBeatRevision: 3, text: 'Make Mara nervous.' });
    expect(sent[1]).toMatchObject({ beatId: 'beat-2', expectedBeatRevision: 4 });
    expect(wrapper.text()).not.toContain('Replace the current draft?');
    expect((wrapper.get('[data-testid="steer-text"]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });

  it('keeps the note and shows the error in the bar when the note cannot be saved', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    transport.command.mockRejectedValueOnce(new Error('The beat changed.'));
    await wrapper.get('[data-testid="steer-text"]').setValue('Slower.');
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['set_beat_steering']);
    expect(bar(wrapper).get('[data-testid="beat-error"]').text()).toBe('The beat changed.');
    expect((wrapper.get('[data-testid="steer-text"]').element as HTMLInputElement).value).toBe('Slower.');
    expect(table.error.value).toBe('');
    wrapper.unmount();
  });

  it('keeps today\'s confirmation when the box is empty or blank', async () => {
    const wrapper = await mountPanel(snapshot(review()));
    await wrapper.get('[data-testid="steer-text"]').setValue('   ');
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Replace the current draft?');
    wrapper.unmount();
  });

  it('asks before a note regenerate throws away unsaved script edits, and sends nothing until confirmed', async () => {
    const wrapper = await mountPanel(snapshot(review({ revision: 3 })));
    await wrapper.get('[data-testid="script-line-0"]').trigger('click');
    await wrapper.get('[data-testid="script-segment-0"]').setValue('My own line.');
    await wrapper.get('[data-testid="steer-text"]').setValue('Make Mara nervous.');
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(bar(wrapper).text()).toContain('Replace the current draft? Saved script edits are discarded; the dice stay the same.');
    await buttonNamed(wrapper, 'Keep draft')!.trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('Replace the current draft?');
    expect((wrapper.get('[data-testid="steer-text"]').element as HTMLInputElement).value).toBe('Make Mara nervous.');
    transport.snapshot.mockReset();
    transport.snapshot.mockResolvedValueOnce(snapshot(review({ revision: 4, steering: 'Make Mara nervous.' })));
    transport.snapshot.mockResolvedValue(snapshot(review({ revision: 5 })));
    await wrapper.get('[data-testid="regenerate"]').trigger('click'); await flushPromises();
    expect(transport.command).not.toHaveBeenCalled();
    await buttonNamed(wrapper, 'Yes, regenerate')!.trigger('click'); await flushPromises();
    expect(sentTypes()).toEqual(['set_beat_steering', 'render_beat']);
    wrapper.unmount();
  });

  it('shows the saved note under the steer box', async () => {
    const wrapper = await mountPanel(snapshot(review({ steering: 'Make Mara nervous.' })));
    expect(wrapper.get('[data-testid="current-note"]').text()).toBe('Current note: Make Mara nervous. What you type here replaces it.');
    wrapper.unmount();
    const bare = await mountPanel(snapshot(review({ steering: 'Make Mara nervous ' })));
    expect(bare.get('[data-testid="current-note"]').text()).toBe('Current note: Make Mara nervous. What you type here replaces it.');
    bare.unmount();
    const plain = await mountPanel(snapshot(review()));
    expect(plain.find('[data-testid="current-note"]').exists()).toBe(false);
    plain.unmount();
  });
});

describe('beat panel replacing typed lines', () => {
  it('asks before Try again replaces lines typed after Write it myself', async () => {
    const wrapper = await mountPanel(snapshot(locked({ lastError: 'The AI timed out.' })));
    await wrapper.get('[data-testid="write-it-myself"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="script-segment-0"]').setValue('The lamps gutter.');
    await wrapper.get('[data-testid="render"]').trigger('click'); await flushPromises();
    expect(sentTypes()).not.toContain('render_beat');
    expect(bar(wrapper).text()).toContain('Replace what you wrote? The AI writes a new script and the lines you typed are lost. The dice stay the same.');
    await wrapper.get('[data-testid="keep-written"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="confirm-replace"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="script-segment-0"]').element as HTMLTextAreaElement).value).toBe('The lamps gutter.');
    expect(sentTypes()).not.toContain('render_beat');
    await wrapper.get('[data-testid="render"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="confirm-replace"]').trigger('click'); await flushPromises();
    expect(sentTypes()).toContain('render_beat');
    wrapper.unmount();
  });
});
