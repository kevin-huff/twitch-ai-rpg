// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import DirectorGuidance from './DirectorGuidance.vue';
import BeatPanel from './BeatPanel.vue';
import { createTable, provideTable } from './table';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), login: vi.fn(), redeem: vi.fn(), create: vi.fn(), testSeat: vi.fn(), sessions: vi.fn(), library: vi.fn(), generateField: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

const npc = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, displayName: name, status: 'present', locationId: 'bar', communicationChannel: null, ...over });
const NPCS = [npc('dolores', 'Dolores'), npc('mara', 'Mara'), npc('ghost', 'Ghost', { status: 'away', locationId: 'cellar' }), npc('radio', 'Radio Voice', { status: 'away', locationId: 'cellar', communicationChannel: 'radio' }), npc('hank', 'Hank', { status: 'away', locationId: 'cellar' })];

function snapshot(guidance?: Record<string, unknown>, status = 'live', extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 4, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find it.', locationId: 'bar' } },
    characters: [], npcs: [], tracks: [], facts: [], activeBeat: null, history: [], submissions: [], npcDetails: NPCS, characterDetails: [], jobs: [], directorNotes: '',
    ...(guidance ? { guidance: { storyPlan: '', standingNote: '', aiCastNpcIds: [], ...guidance } } : {}), ...extra,
  } as never;
}

function mountGuidance(state: ReturnType<typeof snapshot>) {
  const onCommand = vi.fn();
  const wrapper = mount(DirectorGuidance, { props: { snapshot: state, onCommand } });
  return { wrapper, onCommand };
}
const commandOf = (onCommand: ReturnType<typeof vi.fn>, call = 0) => onCommand.mock.calls[call]![0];
const doneOf = (onCommand: ReturnType<typeof vi.fn>, call = 0) => onCommand.mock.calls[call]![1] as (error?: string) => void;

beforeEach(() => { vi.clearAllMocks(); transport.subscribe.mockReturnValue(() => {}); });

describe('DirectorGuidance cast list', () => {
  it('lists exactly the characters who can speak here and nobody else', () => {
    const { wrapper } = mountGuidance(snapshot());
    expect(wrapper.get('legend').text()).toBe('On stage for the AI');
    const ids = wrapper.findAll('input[type="checkbox"]').map(box => box.attributes('data-testid'));
    expect(ids).toEqual(['ai-cast-dolores', 'ai-cast-mara', 'ai-cast-radio']);
    expect(wrapper.text()).not.toContain('Ghost');
    expect(wrapper.get('[data-testid="ai-cast-help"]').text()).toBe('Nobody ticked: the AI gives lines to the characters the players talk to, or else to two characters, those in the room first.');
  });

  it('ticks listed characters and shows the some-ticked line', () => {
    const { wrapper } = mountGuidance(snapshot({ aiCastNpcIds: ['mara'] }));
    expect((wrapper.get('[data-testid="ai-cast-mara"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[data-testid="ai-cast-dolores"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.get('[data-testid="ai-cast-help"]').text()).toBe('The AI can give lines to the ticked characters who are here, plus anyone the players talk to.');
  });

  it('keeps a ticked character who is away, marked not here, and still shows the nobody-ticked line', () => {
    const { wrapper } = mountGuidance(snapshot({ aiCastNpcIds: ['ghost'] }));
    const away = wrapper.get('[data-testid="ai-cast-away-ghost"]');
    expect((away.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).toContain('Ghost (not here)');
    expect(wrapper.get('[data-testid="ai-cast-help"]').text()).toMatch(/^Nobody ticked/);
  });

  it('says so when nobody can speak in the scene', () => {
    const { wrapper } = mountGuidance(snapshot(undefined, 'live', { npcDetails: [npc('ghost', 'Ghost', { status: 'away', locationId: 'cellar' })] }));
    expect(wrapper.get('[data-testid="ai-cast-empty"]').text()).toBe('No non-player characters can speak in this scene.');
  });

  it('tolerates a missing npc list and missing guidance', () => {
    const { wrapper } = mountGuidance(snapshot(undefined, 'live', { npcDetails: undefined }));
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('emits set_guidance with only the full new cast list on each change', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ aiCastNpcIds: ['mara', 'ghost'] }));
    await wrapper.get('[data-testid="ai-cast-dolores"]').setValue(true);
    const added = commandOf(onCommand);
    expect(added).toMatchObject({ type: 'set_guidance', aiCastNpcIds: ['mara', 'ghost', 'dolores'] });
    expect(Object.keys(added).sort()).toEqual(['aiCastNpcIds', 'commandId', 'type']);
    doneOf(onCommand)();
    await flushPromises();
    await wrapper.get('[data-testid="ai-cast-mara"]').setValue(false);
    expect(commandOf(onCommand, 1).aiCastNpcIds).toEqual(['ghost']);
    doneOf(onCommand, 1)();
    await flushPromises();
    await wrapper.get('[data-testid="ai-cast-away-ghost"]').setValue(false);
    expect(commandOf(onCommand, 2).aiCastNpcIds).toEqual(['mara']);
  });
});

describe('DirectorGuidance standing note', () => {
  it('saves only the note and shows the saved line', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot());
    await wrapper.get('[data-testid="standing-note-text"]').setValue('  Keep the fight tense.  ');
    await wrapper.get('[data-testid="save-standing-note"]').trigger('click');
    const command = commandOf(onCommand);
    expect(command).toMatchObject({ type: 'set_guidance', standingNote: 'Keep the fight tense.' });
    expect(Object.keys(command).sort()).toEqual(['commandId', 'standingNote', 'type']);
    doneOf(onCommand)();
    await flushPromises();
    expect(wrapper.get('[data-testid="standing-note-status"]').text()).toBe('Standing note saved. The AI reads it on every plan and script until you clear it.');
  });

  it('clears the note, empties the box and shows the cleared line', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ standingNote: 'Keep it tense.' }));
    expect((wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('Keep it tense.');
    await wrapper.get('[data-testid="clear-standing-note"]').trigger('click');
    expect(commandOf(onCommand)).toMatchObject({ type: 'set_guidance', standingNote: '' });
    expect(Object.keys(commandOf(onCommand)).sort()).toEqual(['commandId', 'standingNote', 'type']);
    doneOf(onCommand)();
    await flushPromises();
    expect((wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.get('[data-testid="standing-note-status"]').text()).toBe('Standing note cleared.');
  });

  it('keeps unsaved text when the cast changes elsewhere, and follows the saved note when the box is clean', async () => {
    const { wrapper } = mountGuidance(snapshot({ standingNote: 'Old.' }));
    await wrapper.get('[data-testid="standing-note-text"]').setValue('Half-typed');
    await wrapper.setProps({ snapshot: snapshot({ standingNote: 'Old.', aiCastNpcIds: ['mara'] }) });
    expect((wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('Half-typed');
    await wrapper.setProps({ snapshot: snapshot({ standingNote: 'New.', aiCastNpcIds: ['mara'] }) });
    expect((wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('Half-typed');
    const clean = mountGuidance(snapshot({ standingNote: 'Old.' }));
    await clean.wrapper.setProps({ snapshot: snapshot({ standingNote: 'New.' }) });
    expect((clean.wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('New.');
  });
});

describe('DirectorGuidance AI plan', () => {
  const planBox = (wrapper: ReturnType<typeof mountGuidance>['wrapper']) => wrapper.get('[data-testid="ai-plan-text"]').element as HTMLTextAreaElement;

  it('has a closed For the AI fold with a labelled box, its own help line and secondary buttons', () => {
    const { wrapper } = mountGuidance(snapshot({ storyPlan: 'Head for the vault.' }));
    const fold = wrapper.get('[data-testid="ai-plan"]');
    expect(fold.element.tagName).toBe('DETAILS');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('For the AI');
    expect(fold.get('label').text()).toBe('AI plan for this show');
    const box = wrapper.get('[data-testid="ai-plan-text"]');
    expect(box.attributes('maxlength')).toBe('12000');
    expect(box.attributes('rows')).toBe('6');
    expect(planBox(wrapper).value).toBe('Head for the vault.');
    const help = wrapper.get(`#${box.attributes('aria-describedby')}`);
    expect(help.classes()).toContain('field-help');
    expect(help.text()).toBe("The AI reads this on every plan and script and follows it. Players and the stream never see it. A new show starts with the scenario's For the AI text.");
    expect(help.element.closest('label')).toBeNull();
    expect(wrapper.get('[data-testid="save-ai-plan"]').text()).toBe('Save AI plan');
    expect(wrapper.get('[data-testid="clear-ai-plan"]').text()).toBe('Clear AI plan');
    expect(wrapper.get('[data-testid="save-ai-plan"]').classes()).toContain('secondary');
    expect(wrapper.get('[data-testid="clear-ai-plan"]').classes()).toContain('secondary');
  });

  it('gives the plan box and the note box different help lines', () => {
    const { wrapper } = mountGuidance(snapshot());
    expect(wrapper.get('[data-testid="ai-plan-text"]').attributes('aria-describedby')).not.toBe(wrapper.get('[data-testid="standing-note-text"]').attributes('aria-describedby'));
  });

  it('saves only the plan, trimmed, and shows the saved line', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot());
    await wrapper.get('[data-testid="ai-plan-text"]').setValue('  Build toward the heist.  ');
    await wrapper.get('[data-testid="save-ai-plan"]').trigger('click');
    const command = commandOf(onCommand);
    expect(command).toMatchObject({ type: 'set_guidance', storyPlan: 'Build toward the heist.' });
    expect(Object.keys(command).sort()).toEqual(['commandId', 'storyPlan', 'type']);
    doneOf(onCommand)();
    await flushPromises();
    const status = wrapper.get('[data-testid="ai-plan-status"]');
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toBe('AI plan saved. The AI reads it on every plan and script.');
  });

  it('clears the plan, empties the box and shows the cleared line', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ storyPlan: 'Old plan.' }));
    await wrapper.get('[data-testid="clear-ai-plan"]').trigger('click');
    const command = commandOf(onCommand);
    expect(command).toMatchObject({ type: 'set_guidance', storyPlan: '' });
    expect(Object.keys(command).sort()).toEqual(['commandId', 'storyPlan', 'type']);
    doneOf(onCommand)();
    await flushPromises();
    expect(planBox(wrapper).value).toBe('');
    expect(wrapper.get('[data-testid="ai-plan-status"]').text()).toBe('AI plan cleared.');
  });

  it('keeps the typed words and shows the error when a save fails', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ storyPlan: 'Old plan.' }));
    await wrapper.get('[data-testid="ai-plan-text"]').setValue('New plan, not saved yet.');
    await wrapper.get('[data-testid="save-ai-plan"]').trigger('click');
    doneOf(onCommand)('The show changed. Try again.');
    await flushPromises();
    expect(planBox(wrapper).value).toBe('New plan, not saved yet.');
    expect(wrapper.get('[role="alert"]').text()).toBe('The show changed. Try again.');
    expect(wrapper.find('[data-testid="ai-plan-status"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="save-ai-plan"]').attributes('disabled')).toBeUndefined();
  });

  it('keeps the typed words when a failed clear is refused', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ storyPlan: 'Old plan.' }));
    await wrapper.get('[data-testid="ai-plan-text"]').setValue('Half-typed');
    await wrapper.get('[data-testid="clear-ai-plan"]').trigger('click');
    doneOf(onCommand)('Only the director can do that.');
    await flushPromises();
    expect(planBox(wrapper).value).toBe('Half-typed');
    expect(wrapper.get('[role="alert"]').text()).toBe('Only the director can do that.');
  });

  it('updates an untouched box from a new snapshot, but not a box with typed words', async () => {
    const clean = mountGuidance(snapshot({ storyPlan: 'Old.' }));
    await clean.wrapper.setProps({ snapshot: snapshot({ storyPlan: 'New.' }) });
    expect(planBox(clean.wrapper).value).toBe('New.');
    const dirty = mountGuidance(snapshot({ storyPlan: 'Old.' }));
    await dirty.wrapper.get('[data-testid="ai-plan-text"]').setValue('Half-typed');
    await dirty.wrapper.setProps({ snapshot: snapshot({ storyPlan: 'New.' }) });
    expect(planBox(dirty.wrapper).value).toBe('Half-typed');
  });

  it('does not touch the standing note box when the plan changes', async () => {
    const { wrapper } = mountGuidance(snapshot({ standingNote: 'Keep it tense.', storyPlan: 'A.' }));
    await wrapper.setProps({ snapshot: snapshot({ standingNote: 'Keep it tense.', storyPlan: 'B.' }) });
    expect((wrapper.get('[data-testid="standing-note-text"]').element as HTMLTextAreaElement).value).toBe('Keep it tense.');
  });
});

describe('DirectorGuidance availability', () => {
  it('works while paused and disables only its own controls while a save is in flight', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot(undefined, 'paused'));
    const buttons = wrapper.findAll('button');
    expect(buttons.every(button => button.attributes('disabled') === undefined)).toBe(true);
    expect(buttons.every(button => button.classes('secondary'))).toBe(true);
    await wrapper.get('[data-testid="ai-cast-mara"]').setValue(true);
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
    expect(wrapper.get('[data-testid="ai-cast-dolores"]').attributes('disabled')).toBeDefined();
    doneOf(onCommand)();
    await flushPromises();
    expect(wrapper.get('[data-testid="save-standing-note"]').attributes('disabled')).toBeUndefined();
  });

  it('shows a failed save in an alert and lets the director try again', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot());
    await wrapper.get('[data-testid="save-standing-note"]').trigger('click');
    doneOf(onCommand)('The show changed. Try again.');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('The show changed. Try again.');
    expect(wrapper.get('[data-testid="save-standing-note"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="standing-note-status"]').exists()).toBe(false);
  });

  it('puts a clicked box back to its saved state when the save fails', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ aiCastNpcIds: ['ghost'] }));
    const box = wrapper.get('[data-testid="ai-cast-dolores"]');
    await box.setValue(true);
    expect((box.element as HTMLInputElement).checked).toBe(true);
    doneOf(onCommand)('The show changed. Try again.');
    await flushPromises();
    expect((box.element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toBe('The show changed. Try again.');
  });

  it('shows a not-here box as ticked again when unticking it fails', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot({ aiCastNpcIds: ['ghost'] }));
    const box = wrapper.get('[data-testid="ai-cast-away-ghost"]');
    await box.setValue(false);
    expect((box.element as HTMLInputElement).checked).toBe(false);
    doneOf(onCommand)('The show changed. Try again.');
    await flushPromises();
    expect((box.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('The show changed. Try again.');
  });

  it('keeps the new box state when the save works', async () => {
    const { wrapper, onCommand } = mountGuidance(snapshot());
    const box = wrapper.get('[data-testid="ai-cast-dolores"]');
    await box.setValue(true);
    doneOf(onCommand)();
    await flushPromises();
    expect((box.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('never uses the queue-item class', () => {
    expect(mountGuidance(snapshot({ aiCastNpcIds: ['ghost'] })).wrapper.html()).not.toContain('queue-item');
  });
});

describe('BeatPanel with guidance', () => {
  async function mountPanel(state: ReturnType<typeof snapshot>) {
    transport.snapshot.mockResolvedValue(state);
    let table!: ReturnType<typeof createTable>;
    const Host = defineComponent({ setup() { table = createTable(); provideTable(table); return () => h(BeatPanel, { selected: [] }); } });
    const wrapper = mount(Host);
    await table.refresh();
    await flushPromises();
    return wrapper;
  }

  it('shows Standing note on directly above the gold button row only when a note is saved', async () => {
    const on = await mountPanel(snapshot({ standingNote: 'Keep it tense.' }));
    const indicator = on.get('[data-testid="standing-note-on"]');
    expect(indicator.text()).toBe('Standing note on');
    expect(indicator.element.nextElementSibling?.classList.contains('actions')).toBe(true);
    expect(indicator.element.closest('.beat-actions')).not.toBeNull();
    const off = await mountPanel(snapshot({ standingNote: '' }));
    expect(off.find('[data-testid="standing-note-on"]').exists()).toBe(false);
    const none = await mountPanel(snapshot());
    expect(none.find('[data-testid="standing-note-on"]').exists()).toBe(false);
  });

  it('mounts the guidance panel outside the beat actions bar and sends set_guidance without the busy lock', async () => {
    transport.command.mockResolvedValue(null);
    const wrapper = await mountPanel(snapshot());
    const panel = wrapper.get('[data-testid="director-guidance"]');
    expect(panel.element.closest('.beat-actions')).toBeNull();
    await wrapper.get('[data-testid="ai-cast-mara"]').setValue(true);
    await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.command.mock.calls[0]![1]).toMatchObject({ type: 'set_guidance', aiCastNpcIds: ['mara'] });
  });

  it('shows a server refusal inside the guidance panel', async () => {
    transport.command.mockRejectedValue(new Error('Only the director can do that.'));
    const wrapper = await mountPanel(snapshot());
    await wrapper.get('[data-testid="save-standing-note"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="director-guidance"] [role="alert"]').text()).toBe('Only the director can do that.');
  });
});
