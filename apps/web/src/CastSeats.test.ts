// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot } from '@rpg/contracts';
import CastSeats from './CastSeats.vue';

const transport = vi.hoisted(() => ({ generateCard: vi.fn(), command: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const card = { schemaVersion: 1, displayName: 'Briar', pronouns: 'she/her', appearance: 'A green coat.', personality: 'Sharp.', backstory: 'A courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Locks', flaw: 'Proud', possessions: ['Pick'], connection: 'Owes Rook', secret: 'Stole the key.', extensions: {} };
const seat = (id: string, name: string, over: Record<string, unknown> = {}) => ({ ...card, id, displayName: name, strain: 0, approved: true, cardRevision: 2, templateRef: null, draft: null, ready: false, acceptedBoundariesRevision: null, ...over });
function snap(details: unknown[], over: Record<string, unknown> = {}) {
  return { role: 'director', session: { id: 'show 1', stateRevision: 7, status: 'lobby', brief: { premise: ' Recover the observatory. ', genre: 'x', tone: 'y', objectives: [], playerHooks: [] } }, picturesEnabled: false, characters: [], characterDetails: details, ...over } as unknown as DirectorSnapshot;
}
const withCard = seat('pc-1', 'Rook');
const waiting = seat('pc-2', 'Wren', { approved: false, cardRevision: 5, displayName: 'Wren' });
const mountIt = (props: Record<string, unknown> = {}) => mount(CastSeats, { props: { snapshot: snap([withCard, waiting]), busy: false, editable: true, ...props } });

beforeEach(() => {
  vi.resetAllMocks();
  transport.command.mockResolvedValue({});
  window.history.replaceState({}, '', `/sessions/show%201/lobby?identity=${'a'.repeat(32)}`);
});

describe('CastSeats', () => {
  it('lists each seat with a closed Read card and a Test as link', () => {
    const wrapper = mountIt();
    const line = wrapper.get('[data-testid="seat-line-pc-1"]');
    expect(line.text()).toContain('Rook');
    const details = line.get('details');
    expect(details.attributes('open')).toBeUndefined();
    expect(details.get('summary').text()).toBe('Read card');
    for (const text of ['she/her', 'A green coat.', 'Sharp.', 'A courier.', 'Locks', 'Proud', 'Owes Rook', 'Stole the key.', 'finesse +2', 'Pick']) expect(details.text()).toContain(text);
    const link = line.get('a');
    expect(link.text()).toBe('Test as Rook');
    expect(link.attributes('href')).toBe(`/sessions/show%201/play?testCharacterId=pc-1&identity=${'a'.repeat(32)}`);
    expect(link.attributes('target')).toBe('_blank');
    const waitingLine = wrapper.get('[data-testid="seat-line-pc-2"]');
    expect(waitingLine.find('details').exists()).toBe(false);
    expect(waitingLine.get('[data-testid="waiting-for-card-pc-2"]').text()).toBe("Waiting for this player's card");
    expect(waitingLine.get('a').text()).toBe('Test as Wren');
  });

  it('treats a seat with a draft as waiting and shows the portrait only when pictures are on', () => {
    const drafted = seat('pc-3', 'Ash', { approved: true, draft: card, portraitId: 'img-1' });
    const off = mountIt({ snapshot: snap([withCard, drafted]) });
    expect(off.find('[data-testid="card-waiting-pc-3"]').text()).toBe('Card waiting to be used');
    expect(off.find('[data-testid="waiting-for-card-pc-3"]').exists()).toBe(false);
    expect(off.find('img').exists()).toBe(false);
    const on = mountIt({ snapshot: snap([seat('pc-1', 'Rook', { portraitId: 'img-1' }), waiting], { picturesEnabled: true }) });
    expect(on.get('[data-testid="seat-line-pc-1"] img').attributes('src')).toContain('/api/sessions/show%201/images/img-1');
  });

  it('writes a card for a waiting seat and sends save_character for that seat', async () => {
    let finish!: (value: unknown) => void;
    transport.generateCard.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const wrapper = mountIt();
    expect(wrapper.find('[data-testid="write-card-for-pc-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="write-card-input-pc-2"]').exists()).toBe(false);
    await wrapper.get('[data-testid="write-card-for-pc-2"]').trigger('click');
    const input = wrapper.get('[data-testid="write-card-input-pc-2"]');
    expect(wrapper.get('label').text()).toBe('Describe this character in one sentence');
    expect(input.attributes('maxlength')).toBe('4000');
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').attributes('disabled')).toBeDefined();
    await input.setValue('  A nervous ferry pilot  ');
    await wrapper.get('[data-testid="write-card-submit-pc-2"]').trigger('click');
    expect(transport.generateCard).toHaveBeenCalledWith({ prompt: 'A nervous ferry pilot', keepFilled: true, premise: 'Recover the observatory.' });
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').text()).toBe('Writing this card…');
    expect(transport.command).not.toHaveBeenCalled();
    finish({ card: { ...card, displayName: 'Wren', pronouns: 'they/them' }, notes: [], pronounsSuggested: true });
    await flushPromises();
    expect(wrapper.emitted('command')).toBeUndefined();
    const [sessionId, command] = transport.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(sessionId).toBe('show 1');
    expect(command).toMatchObject({ type: 'save_character', characterId: 'pc-2', expectedCharacterRevision: 5, card: { displayName: 'Wren', pronouns: 'they/them' } });
    expect(typeof command.commandId).toBe('string');
    expect(wrapper.find('[data-testid="write-card-input-pc-2"]').exists()).toBe(false);
  });

  it('keeps a writer open on each seat and saves two finished cards in turn', async () => {
    const third = seat('pc-3', 'Ash', { approved: false, cardRevision: 9 });
    const finishes: Array<(value: unknown) => void> = [];
    transport.generateCard.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    const saves: Array<() => void> = [];
    transport.command.mockImplementation(() => new Promise<unknown>(resolve => { saves.push(() => resolve({})); }));
    const wrapper = mountIt({ snapshot: snap([withCard, waiting, third]) });
    for (const id of ['pc-2', 'pc-3']) {
      await wrapper.get(`[data-testid="write-card-for-${id}"]`).trigger('click');
      await wrapper.get(`[data-testid="write-card-input-${id}"]`).setValue(`Prompt ${id}`);
    }
    expect(wrapper.find('[data-testid="write-card-input-pc-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="write-card-input-pc-3"]').exists()).toBe(true);
    await wrapper.get('[data-testid="write-card-submit-pc-2"]').trigger('click');
    await wrapper.get('[data-testid="write-card-submit-pc-3"]').trigger('click');
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').text()).toBe('Writing this card…');
    expect(wrapper.get('[data-testid="write-card-submit-pc-3"]').text()).toBe('Writing this card…');
    finishes[0]({ card: { ...card, displayName: 'Wren' }, notes: [], pronounsSuggested: false });
    finishes[1]({ card: { ...card, displayName: 'Ash' }, notes: [], pronounsSuggested: false });
    await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(transport.command.mock.calls[0][1]).toMatchObject({ type: 'save_character', characterId: 'pc-2', expectedCharacterRevision: 5 });
    expect(wrapper.find('[data-testid="write-card-input-pc-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="write-card-input-pc-3"]').exists()).toBe(true);
    saves[0]();
    await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(2);
    expect(transport.command.mock.calls[1][1]).toMatchObject({ type: 'save_character', characterId: 'pc-3', expectedCharacterRevision: 9, card: { displayName: 'Ash' } });
    expect(wrapper.find('[data-testid="write-card-input-pc-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="write-card-input-pc-3"]').exists()).toBe(true);
    saves[1]();
    await flushPromises();
    expect(wrapper.find('[data-testid="write-card-input-pc-3"]').exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined();
  });

  it('shows a failed save on that seat only and keeps its writer open', async () => {
    const third = seat('pc-3', 'Ash', { approved: false, cardRevision: 9 });
    transport.generateCard.mockResolvedValue({ card, notes: [], pronounsSuggested: false });
    transport.command.mockRejectedValue(new Error('Someone else changed this seat.'));
    const wrapper = mountIt({ snapshot: snap([withCard, waiting, third]) });
    await wrapper.get('[data-testid="write-card-for-pc-2"]').trigger('click');
    await wrapper.get('[data-testid="write-card-input-pc-2"]').setValue('A pilot');
    await wrapper.get('[data-testid="write-card-submit-pc-2"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-2"]').text()).toBe('Someone else changed this seat.');
    expect(wrapper.get('[data-testid="seat-error-pc-2"]').attributes('role')).toBe('alert');
    expect(wrapper.find('[data-testid="seat-error-pc-3"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="write-card-input-pc-2"]').element).toHaveProperty('value', 'A pilot');
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').text()).toBe('Write the card');
  });

  it('leaves the premise out when the show has none and shows a failure message', async () => {
    transport.generateCard.mockRejectedValue(new Error('The AI is busy.'));
    const wrapper = mountIt({ snapshot: snap([withCard, waiting], { session: { id: 'show', stateRevision: 7, status: 'lobby', brief: null } }) });
    await wrapper.get('[data-testid="write-card-for-pc-2"]').trigger('click');
    await wrapper.get('[data-testid="write-card-input-pc-2"]').setValue('A pilot');
    await wrapper.get('[data-testid="write-card-submit-pc-2"]').trigger('click'); await flushPromises();
    expect(transport.generateCard).toHaveBeenCalledWith({ prompt: 'A pilot', keepFilled: true });
    expect(wrapper.get('[role="alert"]').text()).toBe('The AI is busy.');
    expect(transport.command).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="write-card-input-pc-2"]').element).toHaveProperty('value', 'A pilot');
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').text()).toBe('Write the card');
  });

  it('asks before removing a waiting seat and emits remove_seat on confirm', async () => {
    const wrapper = mountIt();
    expect(wrapper.find('[data-testid="remove-seat-pc-1"]').exists()).toBe(false);
    const start = wrapper.get('[data-testid="remove-seat-pc-2"]');
    expect(start.text()).toBe('Start without this seat');
    await start.trigger('click');
    expect(wrapper.text()).toContain('Remove this seat? Its invitation stops working.');
    expect(wrapper.emitted('command')).toBeUndefined();
    const keep = wrapper.findAll('button').find(button => button.text() === 'Keep seat')!;
    await keep.trigger('click');
    expect(wrapper.find('[data-testid="remove-seat-confirm-pc-2"]').exists()).toBe(false);
    await wrapper.get('[data-testid="remove-seat-pc-2"]').trigger('click');
    const confirm = wrapper.get('[data-testid="remove-seat-confirm-pc-2"]');
    expect(confirm.text()).toBe('Remove seat');
    await confirm.trigger('click');
    const [command] = wrapper.emitted('command')![0] as [Record<string, unknown>];
    expect(command).toMatchObject({ type: 'remove_seat', characterId: 'pc-2', expectedStateRevision: 7 });
    expect(typeof command.commandId).toBe('string');
    expect(wrapper.find('[data-testid="remove-seat-confirm-pc-2"]').exists()).toBe(false);
  });

  it('offers no removal on the last seat or when not editable, and no card writing when not editable', () => {
    const last = mountIt({ snapshot: snap([waiting]) });
    expect(last.find('[data-testid="remove-seat-pc-2"]').exists()).toBe(false);
    expect(last.find('[data-testid="write-card-for-pc-2"]').exists()).toBe(true);
    const fixed = mountIt({ editable: false });
    expect(fixed.find('[data-testid="remove-seat-pc-2"]').exists()).toBe(false);
    expect(fixed.find('[data-testid="write-card-for-pc-2"]').exists()).toBe(false);
    expect(fixed.find('[data-testid="waiting-for-card-pc-2"]').exists()).toBe(true);
  });

  it('shows a legacy draft seat as a card waiting, reads the draft and uses it', async () => {
    const drafted = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, displayName: 'Ash', pronouns: '', appearance: '', draft: { ...card, displayName: 'Ash', appearance: 'A drafted coat.', pronouns: 'he/him', possessions: ['Lantern'] } });
    const wrapper = mountIt({ snapshot: snap([withCard, drafted]) });
    const line = wrapper.get('[data-testid="seat-line-pc-3"]');
    expect(line.get('[data-testid="card-waiting-pc-3"]').text()).toBe('Card waiting to be used');
    expect(line.find('[data-testid="waiting-for-card-pc-3"]').exists()).toBe(false);
    expect(line.get('summary').text()).toBe('Read card');
    for (const text of ['A drafted coat.', 'he/him', 'Lantern', 'finesse +2']) expect(line.get('details').text()).toContain(text);
    expect(line.find('[data-testid="change-card-pc-3"]').exists()).toBe(false);
    expect(line.find('[data-testid="write-card-for-pc-3"]').exists()).toBe(true);
    expect(line.find('[data-testid="remove-seat-pc-3"]').exists()).toBe(true);
    await line.get('[data-testid="use-card-pc-3"]').trigger('click'); await flushPromises();
    const [sessionId, command] = transport.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(sessionId).toBe('show 1');
    expect(command).toMatchObject({ type: 'approve_character', characterId: 'pc-3', expectedCharacterRevision: 4 });
    expect(typeof command.commandId).toBe('string');
    expect(wrapper.emitted('command')).toBeUndefined();
  });

  it('disables Use this card while busy and shows a failed use on that seat', async () => {
    const drafted = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, draft: card });
    transport.command.mockRejectedValue(new Error('That card changed.'));
    const busyWrapper = mountIt({ snapshot: snap([withCard, drafted]), busy: true });
    expect(busyWrapper.get('[data-testid="use-card-pc-3"]').attributes('disabled')).toBeDefined();
    const wrapper = mountIt({ snapshot: snap([withCard, drafted]) });
    await wrapper.get('[data-testid="use-card-pc-3"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-3"]').text()).toBe('That card changed.');
  });

  it('changes an approved card from its Read card and saves it with that seat id', async () => {
    const wrapper = mountIt();
    const line = wrapper.get('[data-testid="seat-line-pc-1"]');
    expect(line.find('[data-testid="card-name"]').exists()).toBe(false);
    await line.get('[data-testid="change-card-pc-1"]').trigger('click');
    expect(line.find('[data-testid="change-card-pc-1"]').exists()).toBe(false);
    expect(line.get('[data-testid="card-name"]').element).toHaveProperty('value', 'Rook');
    expect(line.get('[data-testid="card-appearance"]').element).toHaveProperty('value', 'A green coat.');
    expect(line.get('[data-testid="card-secret"]').element).toHaveProperty('value', 'Stole the key.');
    await line.get('[data-testid="card-name"]').setValue('Rook Vale');
    await line.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    const [sessionId, command] = transport.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(sessionId).toBe('show 1');
    expect(command).toMatchObject({ type: 'save_character', characterId: 'pc-1', expectedCharacterRevision: 2, card: { displayName: 'Rook Vale', appearance: 'A green coat.', possessions: ['Pick'] } });
    expect(wrapper.find('[data-testid="change-card-save-pc-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="change-card-pc-1"]').exists()).toBe(true);
  });

  it('cancels a change, keeps the form open on a failed save, and offers no change when not editable', async () => {
    const wrapper = mountIt();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="change-card-cancel-pc-1"]').trigger('click');
    expect(wrapper.find('[data-testid="change-card-save-pc-1"]').exists()).toBe(false);
    expect(transport.command).not.toHaveBeenCalled();
    transport.command.mockRejectedValue(new Error('Someone else changed this seat.'));
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-1"]').text()).toBe('Someone else changed this seat.');
    expect(wrapper.find('[data-testid="change-card-save-pc-1"]').exists()).toBe(true);
    const drafted = seat('pc-3', 'Ash', { approved: false, draft: card });
    const fixed = mountIt({ editable: false, snapshot: snap([withCard, drafted]) });
    for (const id of ['change-card-pc-1', 'use-card-pc-3']) expect(fixed.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(fixed.find('[data-testid="card-waiting-pc-3"]').exists()).toBe(true);
  });

  it('saves a change against the revision it was opened from and keeps the typed description when the seat moves on', async () => {
    const wrapper = mountIt({ snapshot: snap([seat('pc-1', 'Rook', { appearance: '', cardRevision: 2 }), waiting]) });
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall rook in a green coat.');
    await wrapper.setProps({ snapshot: snap([seat('pc-1', 'Rook', { appearance: '', cardRevision: 3 }), waiting]) });
    expect(wrapper.get('[data-testid="card-description"]').element).toHaveProperty('value', 'A tall rook in a green coat.');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    const [, command] = transport.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toMatchObject({ type: 'save_character', characterId: 'pc-1', expectedCharacterRevision: 2, card: { appearance: 'A tall rook in a green coat.' } });
  });

  it('shows a rejected change save on that seat and keeps the form open at the opened revision', async () => {
    const wrapper = mountIt();
    transport.command.mockRejectedValue(new Error('409: this card changed.'));
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.setProps({ snapshot: snap([seat('pc-1', 'Rook', { cardRevision: 3 }), waiting]) });
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(transport.command.mock.calls[0][1]).toMatchObject({ expectedCharacterRevision: 2 });
    expect(wrapper.get('[data-testid="seat-error-pc-1"]').text()).toBe('409: this card changed.');
    expect(wrapper.find('[data-testid="change-card-save-pc-1"]').exists()).toBe(true);
  });

  it('sends approve_character once on a double press and keeps the seat buttons off while the save runs', async () => {
    const drafted = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, draft: card });
    let finish!: () => void;
    transport.command.mockImplementation(() => new Promise<unknown>(resolve => { finish = () => resolve({}); }));
    const wrapper = mountIt({ snapshot: snap([withCard, drafted, waiting]) });
    const use = wrapper.get('[data-testid="use-card-pc-3"]');
    await use.trigger('click');
    await use.trigger('click');
    for (const id of ['use-card-pc-3', 'write-card-for-pc-3', 'remove-seat-pc-3']) expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="use-card-pc-2"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="write-card-for-pc-2"]').attributes('disabled')).toBeUndefined();
    expect(transport.command).toHaveBeenCalledTimes(1);
    finish(); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="seat-error-pc-3"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="use-card-pc-3"]').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ snapshot: snap([withCard, seat('pc-3', 'Ash', { approved: true, cardRevision: 5 }), waiting]) });
    expect(wrapper.find('[data-testid="use-card-pc-3"]').exists()).toBe(false);
  });

  it('keeps the seat buttons off after Use this card resolves until a higher cardRevision arrives', async () => {
    const drafted = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, draft: card });
    const wrapper = mountIt({ snapshot: snap([withCard, drafted, waiting]) });
    await wrapper.get('[data-testid="use-card-pc-3"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    for (const id of ['use-card-pc-3', 'write-card-for-pc-3', 'remove-seat-pc-3']) expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="use-card-pc-3"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('saving')).toEqual([[true]]);
    await wrapper.setProps({ snapshot: snap([withCard, seat('pc-3', 'Ash', { approved: false, cardRevision: 5, draft: card }), waiting]) });
    for (const id of ['use-card-pc-3', 'write-card-for-pc-3', 'remove-seat-pc-3']) expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('saving')).toEqual([[true], [false]]);
  });

  it('keeps Save this card off after it resolves until the seat revision changes, and re-enables it after a failure', async () => {
    const wrapper = mountIt();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    expect(wrapper.get('[data-testid="change-card-save-pc-1"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(transport.command).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ snapshot: snap([seat('pc-1', 'Rook', { cardRevision: 3 }), waiting]) });
    expect(wrapper.get('[data-testid="change-card-save-pc-1"]').attributes('disabled')).toBeUndefined();
    transport.command.mockRejectedValue(new Error('Nope.'));
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="change-card-save-pc-1"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('saving')).toEqual([[true], [false], [true], [false]]);
  });

  it('emits saving true while Write my card generates inside Change this card, and false when it settles', async () => {
    let finish!: (value: unknown) => void;
    transport.generateCard.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const wrapper = mountIt();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall rook in a green coat.');
    await wrapper.get('[data-testid="write-card"]').trigger('click');
    expect(transport.generateCard).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('saving')).toEqual([[true]]);
    finish({ card, notes: [], pronounsSuggested: false }); await flushPromises();
    expect(wrapper.emitted('saving')).toEqual([[true], [false]]);
    transport.generateCard.mockRejectedValue(new Error('The AI is busy.'));
    await wrapper.get('[data-testid="write-card"]').trigger('click'); await flushPromises();
    expect(wrapper.emitted('saving')).toEqual([[true], [false], [true], [false]]);
  });

  it('disables the write and change buttons of a seat while its save is queued or running', async () => {
    let finish!: () => void;
    transport.command.mockImplementation(() => new Promise<unknown>(resolve => { finish = () => resolve({}); }));
    transport.generateCard.mockResolvedValue({ card, notes: [], pronounsSuggested: false });
    const wrapper = mountIt();
    await wrapper.get('[data-testid="write-card-for-pc-2"]').trigger('click');
    await wrapper.get('[data-testid="write-card-input-pc-2"]').setValue('A pilot');
    await wrapper.get('[data-testid="write-card-submit-pc-2"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="write-card-submit-pc-2"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="remove-seat-pc-2"]').attributes('disabled')).toBeDefined();
    finish(); await flushPromises();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click');
    expect(wrapper.get('[data-testid="change-card-save-pc-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="change-card-cancel-pc-1"]').attributes('disabled')).toBeDefined();
    finish(); await flushPromises();
  });

  it('emits saving true when a save is queued and false when the queue empties', async () => {
    const finishes: Array<() => void> = [];
    transport.command.mockImplementation(() => new Promise<unknown>(resolve => { finishes.push(() => resolve({})); }));
    const first = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, draft: card });
    const second = seat('pc-4', 'Ivy', { approved: false, cardRevision: 6, draft: card });
    const wrapper = mountIt({ snapshot: snap([withCard, first, second]) });
    expect(wrapper.emitted('saving')).toBeUndefined();
    await wrapper.get('[data-testid="use-card-pc-3"]').trigger('click');
    await wrapper.get('[data-testid="use-card-pc-4"]').trigger('click');
    expect(wrapper.emitted('saving')).toEqual([[true]]);
    finishes[0](); await flushPromises();
    expect(wrapper.emitted('saving')).toEqual([[true]]);
    finishes[1](); await flushPromises();
    expect(wrapper.emitted('saving')).toEqual([[true]]);
    await wrapper.setProps({ snapshot: snap([withCard, seat('pc-3', 'Ash', { cardRevision: 5 }), seat('pc-4', 'Ivy', { cardRevision: 7 })]) });
    expect(wrapper.emitted('saving')).toEqual([[true], [false]]);
  });

  it('emits saving false after a failed save too', async () => {
    transport.command.mockRejectedValue(new Error('Nope.'));
    const drafted = seat('pc-3', 'Ash', { approved: false, cardRevision: 4, draft: card });
    const wrapper = mountIt({ snapshot: snap([withCard, drafted]) });
    await wrapper.get('[data-testid="use-card-pc-3"]').trigger('click'); await flushPromises();
    expect(wrapper.emitted('saving')).toEqual([[true], [false]]);
  });

  it('says what is wrong when Save this card finds no name, broken traits or a box that is too long', async () => {
    const wrapper = mountIt();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="card-name"]').setValue('');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-1"]').text()).toBe('Give your character a name. Nothing has been saved.');
    await wrapper.get('[data-testid="card-name"]').setValue('Rook');
    await wrapper.get('[data-testid="card-trait-force"]').setValue('2');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-1"]').text()).toBe('Give the four traits one +2, two +1 and one +0. They are under More about your character.');
    await wrapper.get('[data-testid="card-trait-force"]').setValue('0');
    await wrapper.get('[data-testid="card-appearance"]').setValue('x'.repeat(1001));
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="seat-error-pc-1"]').text()).toBe('Check Appearance under More about your character. Nothing has been saved.');
    expect(transport.command).not.toHaveBeenCalled();
  });

  it('clears the seat error when Cancel closes the change form', async () => {
    const wrapper = mountIt();
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    await wrapper.get('[data-testid="card-name"]').setValue('');
    await wrapper.get('[data-testid="change-card-save-pc-1"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="seat-error-pc-1"]').exists()).toBe(true);
    await wrapper.get('[data-testid="change-card-cancel-pc-1"]').trigger('click');
    expect(wrapper.find('[data-testid="seat-error-pc-1"]').exists()).toBe(false);
    await wrapper.get('[data-testid="change-card-pc-1"]').trigger('click');
    expect(wrapper.find('[data-testid="seat-error-pc-1"]').exists()).toBe(false);
  });
});
