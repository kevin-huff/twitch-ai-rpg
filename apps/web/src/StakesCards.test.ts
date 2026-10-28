// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import StakesCards from './StakesCards.vue';
import { createTable, provideTable, type Table } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

function contract(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, version: 1, actorCharacterId: 'pc-1', helperCharacterIds: [], submissionIds: ['act-1'],
    intent: 'Pick the lock', approach: 'Quietly, with a hairpin', ruling: 'check', trait: 'finesse', edge: 0, edgeReason: null,
    risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
    outcomes: {
      clean: { publicText: 'The door opens.', effects: [] },
      costly: { publicText: 'It opens, but noisily.', effects: [{ kind: 'strain_delta', characterId: 'pc-1', delta: 1 }] },
      setback: { publicText: 'The pick snaps.', effects: [] },
    },
    ...overrides,
  };
}

function beat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'beat-1', sessionId: 'show', kind: 'action', phase: 'stakes_review', revision: 3, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: ['act-1'], lockedSubmissions: [], contracts: [], classification: 'needs_action', stakesApproved: false, inputSnapshotHash: null,
    resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null, ...overrides,
  };
}

function snapshot() {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 4, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [{ id: 'pc-1', displayName: 'Skooty' }], npcs: [], tracks: [], facts: [], activeBeat: null, history: [],
    submissions: [], npcDetails: [], characterDetails: [{ id: 'pc-1', displayName: 'Skooty', traits: { force: 0, finesse: 2, wits: 1, presence: 1 } }], jobs: [], directorNotes: '',
  };
}

let table: Table;
async function mountCards(options: { contracts?: ReturnType<typeof contract>[]; classification?: 'ordinary' | 'action'; beatOverrides?: Record<string, unknown> } = {}) {
  transport.snapshot.mockResolvedValue(snapshot());
  const contracts = reactive(options.contracts ?? []);
  const state = reactive({ classification: options.classification ?? 'action' as 'ordinary' | 'action' });
  const Host = defineComponent({
    setup() {
      table = createTable(); provideTable(table);
      return () => h(StakesCards, {
        beat: beat(options.beatOverrides) as never, contracts: contracts as never, classification: state.classification, busy: false,
        'onUpdate:classification': (value: 'ordinary' | 'action') => { state.classification = value; },
      });
    },
  });
  const wrapper = mount(Host);
  await table.refresh();
  await flushPromises();
  return { wrapper, contracts, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.subscribe.mockReturnValue(() => {});
  window.history.replaceState({}, '', '/sessions/show/director');
});
afterEach(() => { document.body.innerHTML = ''; });

describe('StakesCards', () => {
  it('shows one line for an ordinary conversation and reveals the classification select with Edit', async () => {
    const { wrapper } = await mountCards({ classification: 'ordinary', beatOverrides: { classification: 'ordinary', kind: 'conversation' } });
    expect(wrapper.text()).toContain('What\'s at risk');
    expect(wrapper.text()).toContain('Ordinary conversation: no dice, and nothing changes.');
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(false);
    await wrapper.get('[data-testid="stakes-ordinary-edit"]').trigger('click');
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('emits the new classification and disables Ordinary when the exchange needs action', async () => {
    const { wrapper, state } = await mountCards({ classification: 'ordinary', beatOverrides: { classification: 'needs_action' } });
    await wrapper.get('[data-testid="stakes-ordinary-edit"]').trigger('click');
    const ordinary = wrapper.findAll('[data-testid="stakes-classification"] option').find(option => option.attributes('value') === 'ordinary')!;
    expect(ordinary.attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="stakes-classification"]').setValue('action');
    expect(state.classification).toBe('action');
    wrapper.unmount();
  });

  it('renders a read-only card with goal, approach, labelled outcomes with effects, and the roll in words', async () => {
    const { wrapper } = await mountCards({ contracts: [contract('c-1')] });
    const card = wrapper.get('[data-testid="stakes-card-c-1"]');
    expect(card.text()).toContain('Skooty');
    expect(card.text()).toContain('Pick the lock');
    expect(card.text()).toContain('Quietly, with a hairpin');
    expect(card.text()).toContain('10 or more: Clean success');
    expect(card.text()).toContain('The door opens.');
    expect(card.text()).toContain('7 to 9: Success with a cost');
    expect(card.text()).toContain('Skooty strain +1');
    expect(card.text()).toContain('6 or less: Setback');
    expect(card.text()).toContain('Roll: two dice + Finesse (+2)');
    expect(card.find('textarea').exists()).toBe(false);
    expect(card.find('[data-testid="outcome-clean"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    ['an edge', { edge: 1 }, 'Roll: two dice + Finesse (+2) + 1 edge'],
    ['no check', { ruling: 'no_check' }, 'No roll: it simply works.'],
    ['blocked', { ruling: 'blocked' }, 'Blocked: it can\'t happen yet.'],
  ])('words the roll for %s', async (_label, overrides, expected) => {
    const { wrapper } = await mountCards({ contracts: [contract('c-1', overrides)] });
    expect(wrapper.get('[data-testid="stakes-card-c-1"]').text()).toContain(expected);
    wrapper.unmount();
  });

  it('opens today\'s fields with Edit and changes the contracts array the parent passed', async () => {
    const { wrapper, contracts } = await mountCards({ contracts: [contract('c-1')] });
    expect(wrapper.get('[data-testid="stakes-edit-c-1"]').text()).toBe('Edit');
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    expect(wrapper.get('[data-testid="stakes-edit-c-1"]').text()).toBe('Done');
    await wrapper.get('[data-testid="outcome-clean"]').setValue('The door swings wide.');
    await wrapper.get('[data-testid="contract-ruling"]').setValue('no_check');
    expect(contracts[0].outcomes.clean.publicText).toBe('The door swings wide.');
    expect(contracts[0].ruling).toBe('no_check');
    expect(wrapper.find('[data-testid="outcome-costly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="outcome-setback"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stakes-classification"]').exists()).toBe(true);
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    expect(wrapper.get('[data-testid="stakes-card-c-1"]').text()).toContain('No roll: it simply works.');
    wrapper.unmount();
  });

  it('shows the stage-length notes only when the text is over 90 or 110 characters', async () => {
    const { wrapper } = await mountCards({ contracts: [contract('c-1')] });
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    expect(wrapper.find('[data-testid="stage-length-goal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="stage-length-clean"]').exists()).toBe(false);
    await wrapper.get('textarea:not([data-testid])').setValue('g'.repeat(90));
    expect(wrapper.find('[data-testid="stage-length-goal"]').exists()).toBe(false);
    await wrapper.get('textarea:not([data-testid])').setValue('g'.repeat(91));
    expect(wrapper.get('[data-testid="stage-length-goal"]').text()).toContain('this has 91');
    await wrapper.get('[data-testid="outcome-clean"]').setValue('o'.repeat(110));
    expect(wrapper.find('[data-testid="stage-length-clean"]').exists()).toBe(false);
    await wrapper.get('[data-testid="outcome-clean"]').setValue('o'.repeat(111));
    expect(wrapper.get('[data-testid="stage-length-clean"]').text()).toContain('this has 111');
    expect(wrapper.find('[data-testid="stage-length-costly"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the critical row only when the branch exists', async () => {
    const withCritical = contract('c-1');
    (withCritical.outcomes as Record<string, unknown>).critical = { publicText: 'The lock jams for good.', effects: [{ kind: 'strain_delta', characterId: 'pc-1', delta: 3 }] };
    const { wrapper } = await mountCards({ contracts: [withCritical, contract('c-2')] });
    const card = wrapper.get('[data-testid="stakes-card-c-1"]');
    expect(card.text()).toContain('Double 1s: Critical failure');
    expect(card.text()).toContain('The lock jams for good.');
    expect(card.text()).toContain('Skooty strain +3');
    expect(wrapper.get('[data-testid="stakes-card-c-2"]').text()).not.toContain('Critical failure');
    wrapper.unmount();
  });

  it('leaves the contract alone on Edit and creates the critical branch on first input', async () => {
    const { wrapper, contracts } = await mountCards({ contracts: [contract('c-1')] });
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    expect(wrapper.get('[data-testid="outcome-critical"]').element).toHaveProperty('value', '');
    expect('critical' in contracts[0].outcomes).toBe(false);
    await wrapper.get('[data-testid="outcome-critical"]').setValue('It all goes wrong.');
    expect((contracts[0].outcomes as { critical?: unknown }).critical).toEqual({ publicText: 'It all goes wrong.', effects: [] });
    expect(wrapper.find('[data-testid="stage-length-critical"]').exists()).toBe(false);
    await wrapper.get('[data-testid="outcome-critical"]').setValue('c'.repeat(110));
    expect(wrapper.find('[data-testid="stage-length-critical"]').exists()).toBe(false);
    await wrapper.get('[data-testid="outcome-critical"]').setValue('c'.repeat(111));
    expect(wrapper.get('[data-testid="stage-length-critical"]').text()).toContain('this has 111');
    wrapper.unmount();
  });

  it('loads contract edits that carry a critical branch', async () => {
    const { wrapper, contracts } = await mountCards({ contracts: [contract('c-1')] });
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    const edited = contract('c-1');
    (edited.outcomes as Record<string, unknown>).critical = { publicText: 'Disaster.', effects: [] };
    await wrapper.get('[data-testid="contract-data"]').setValue(JSON.stringify([edited]));
    await wrapper.get('[data-testid="load-contract-edits"]').trigger('click');
    expect(wrapper.find('[data-testid="contract-json-error"]').exists()).toBe(false);
    expect((contracts[0].outcomes as { critical?: { publicText: string } }).critical?.publicText).toBe('Disaster.');
    wrapper.unmount();
  });

  it('loads typed-effects JSON into the same array and shows its own error', async () => {
    const { wrapper, contracts } = await mountCards({ contracts: [contract('c-1')] });
    expect(wrapper.find('[data-testid="contract-data"]').exists()).toBe(false);
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    const edited = contract('c-1', { intent: 'Break the door down' });
    await wrapper.get('[data-testid="contract-data"]').setValue(JSON.stringify([edited]));
    await wrapper.get('[data-testid="load-contract-edits"]').trigger('click');
    expect(contracts[0].intent).toBe('Break the door down');
    expect(wrapper.find('[data-testid="contract-json-error"]').exists()).toBe(false);
    await wrapper.get('[data-testid="contract-data"]').setValue('not json');
    await wrapper.get('[data-testid="load-contract-edits"]').trigger('click');
    expect(wrapper.get('[data-testid="contract-json-error"]').text()).toContain('not valid');
    expect(contracts[0].intent).toBe('Break the door down');
    wrapper.unmount();
  });

  it('keeps the planning-failed and needs-action notices, and every button is secondary or quiet', async () => {
    const { wrapper } = await mountCards({ contracts: [contract('c-1')], beatOverrides: { phase: 'collecting', lastError: 'The AI timed out.' } });
    expect(wrapper.text()).toContain('Planning failed.');
    expect(wrapper.text()).toContain('This exchange has consequences.');
    await wrapper.get('[data-testid="stakes-edit-c-1"]').trigger('click');
    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) expect(button.classes().some(name => name === 'secondary' || name === 'quiet')).toBe(true);
    wrapper.unmount();
  });
});
