// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot, PlayerSnapshot } from '@rpg/contracts';
import Lobby from './Lobby.vue';
import { api } from './api';

const card = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: 'A silver coat.', personality: 'Patient.', backstory: 'A former courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Navigation', flaw: 'Distrustful', possessions: ['Map', 'Compass', 'Coat'], connection: 'Owes the crew a favor.', secret: 'The map is a forgery.', extensions: {} };
const stub = (name: string) => defineComponent({ name, props: { snapshot: Object, busy: Boolean, editable: Boolean, showStart: Boolean, seats: Array, sessionId: String, characters: Array, mode: String, ownCharacterId: String }, emits: ['command', 'start', 'saving'], setup(_, { attrs }) { return () => h('div', { 'data-stub': name, ...attrs }); } });
const stubs = { ReadyStrip: stub('ReadyStrip'), CastSeats: stub('CastSeats'), PlayerCard: stub('PlayerCard'), StreamLinks: stub('StreamLinks'), SeatInvites: stub('SeatInvites') };

function snapshot(role: 'director' | 'player', over: { started?: boolean; noSetup?: boolean } = {}) {
  const own = { ...card, id: 'pc-1', strain: 0, approved: false, cardRevision: 2, templateRef: { templateId: 'card', version: 1 }, draft: null, ready: false, acceptedBoundariesRevision: null };
  const waiting = { ...own, displayName: 'Aster' };
  const withCard = { ...own, id: 'pc-2', displayName: 'Briar', approved: true, secret: 'Other seat secret.' };
  return {
    role, session: { id: 'show', stateRevision: 3, status: 'lobby', brief: { premise: 'Recover the observatory.', genre: 'Fantasy', tone: 'Hopeful', objectives: ['Enter the tower.'], playerHooks: ['An old debt.'] } },
    ...(over.noSetup ? {} : { setup: { boundaries: ['No harm to children.'], boundariesRevision: 2, started: over.started ?? false, scenario: { templateId: 'scenario', version: 1 } } }),
    characters: [{ id: 'pc-1', displayName: 'Aster', approved: false, ready: false, strain: 0, appearance: 'A silver coat.' }, { id: 'pc-2', displayName: 'Briar', approved: true, ready: false, strain: 0, appearance: 'A green coat.' }],
    ...(role === 'director' ? { characterDetails: [waiting, withCard] } : { ownCharacter: waiting }),
  } as unknown as DirectorSnapshot | PlayerSnapshot;
}
const mountLobby = (current: DirectorSnapshot | PlayerSnapshot, busy = false) => mount(Lobby, { props: { snapshot: current, busy }, global: { stubs } });

beforeEach(() => window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}`));
afterEach(() => vi.restoreAllMocks());

describe('Cast & lobby for the director', () => {
  it('puts the Ready to start strip first and gives it the seats and the start switch', () => {
    const wrapper = mountLobby(snapshot('director'));
    const first = wrapper.get('section.lobby').element.firstElementChild!;
    expect(first.getAttribute('data-stub')).toBe('ReadyStrip');
    const strip = wrapper.getComponent({ name: 'ReadyStrip' });
    expect(strip.props()).toMatchObject({ sessionId: 'show', showStart: true, busy: false, seats: [{ id: 'pc-1', displayName: 'Aster', hasCard: false }, { id: 'pc-2', displayName: 'Briar', hasCard: true }] });
    wrapper.unmount();
  });

  it('counts a seat with an unapproved draft as having no card', () => {
    const current = snapshot('director') as DirectorSnapshot;
    const drafted = { ...current, characterDetails: current.characterDetails.map(character => character.id === 'pc-2' ? { ...character, draft: card } : character) } as DirectorSnapshot;
    const wrapper = mountLobby(drafted);
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('seats')).toMatchObject([{ hasCard: false }, { hasCard: false }]);
    wrapper.unmount();
  });

  it('sends start_session with no reason when the strip says start', async () => {
    const wrapper = mountLobby(snapshot('director'));
    wrapper.getComponent({ name: 'ReadyStrip' }).vm.$emit('start');
    const sent = wrapper.emitted('command')![0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ type: 'start_session', expectedStateRevision: 3 });
    expect(sent.commandId).toEqual(expect.any(String));
    expect('overrideUnreadyReason' in sent).toBe(false);
    wrapper.unmount();
  });

  it('passes the seat commands from CastSeats through', () => {
    const wrapper = mountLobby(snapshot('director'));
    const seats = wrapper.getComponent({ name: 'CastSeats' });
    expect(seats.props()).toMatchObject({ busy: false, editable: true });
    const command = { type: 'remove_seat', commandId: crypto.randomUUID(), characterId: 'pc-1', expectedStateRevision: 3 };
    seats.vm.$emit('command', command);
    expect(wrapper.emitted('command')![0]![0]).toEqual(command);
    wrapper.unmount();
  });

  it('has no Approve buttons, readiness controls, reason box or old card form', () => {
    const wrapper = mountLobby(snapshot('director'));
    const text = wrapper.text();
    for (const gone of ['Approve', 'Mark ready', 'Withdraw readiness', 'Not ready', 'Reason to start', 'Review the cast', 'Content boundaries']) expect(text).not.toContain(gone);
    for (const id of ['accept-boundaries', 'ready-character', 'override-unready', 'absent-player-hint', 'save-character-draft']) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(text).toContain('Testing on your own?');
    expect(wrapper.find('[data-stub="StreamLinks"]').exists()).toBe(true);
    expect(wrapper.find('[data-stub="SeatInvites"]').exists()).toBe(true);
    expect(text).toContain('The director starts the show when every seat has a card.');
    wrapper.unmount();
  });

  it('keeps the boundaries in a closed section and saves them as before', async () => {
    const wrapper = mountLobby(snapshot('director'));
    const section = wrapper.get('[data-testid="boundaries-section"]');
    expect(section.element.tagName).toBe('DETAILS');
    expect(section.attributes('open')).toBeUndefined();
    expect(section.get('summary').text()).toBe("What the AI won't write");
    expect(section.text()).toContain('One per line. The AI stays away from these when it writes. Players never see this list.');
    const box = wrapper.get('[data-testid="boundaries"]');
    expect((box.element as HTMLTextAreaElement).value).toBe('No harm to children.');
    expect(wrapper.get('[data-testid="save-boundaries"]').attributes('disabled')).toBeDefined();
    await box.setValue('No harm to children.\n  Fade to black for injury.  \n');
    await wrapper.get('[data-testid="save-boundaries"]').trigger('click');
    expect(wrapper.emitted('command')![0]![0]).toMatchObject({ type: 'set_boundaries', expectedStateRevision: 3, boundaries: ['No harm to children.', 'Fade to black for injury.'] });
    wrapper.unmount();
  });

  it('previews generated boundaries and needs Apply and then Save', async () => {
    vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'No harm to children.\nFade to black for injury.' });
    const wrapper = mountLobby(snapshot('director'));
    await wrapper.get('[data-testid="field-generator-open"]').trigger('click');
    await wrapper.get('[data-testid="field-generator-seed"]').setValue('fade to black for injury');
    await wrapper.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="field-generator-apply"]').trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="save-boundaries"]').trigger('click');
    expect(wrapper.emitted('command')![0]![0]).toMatchObject({ type: 'set_boundaries', boundaries: ['No harm to children.', 'Fade to black for injury.'] });
    wrapper.unmount();
  });

  it('keeps unsaved boundary text when the saved list changes elsewhere, and offers the latest', async () => {
    const current = snapshot('director') as DirectorSnapshot;
    const wrapper = mountLobby(current);
    await wrapper.get('[data-testid="boundaries"]').setValue('My unsaved line.');
    await wrapper.setProps({ snapshot: { ...current, setup: { ...current.setup!, boundariesRevision: 3, boundaries: ['Saved elsewhere.'] } } });
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('My unsaved line.');
    expect(wrapper.get('[data-testid="save-boundaries"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="load-boundaries"]').trigger('click');
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('Saved elsewhere.');
    wrapper.unmount();
  });

  it('is fixed after the start: no Start show, no boundaries editor, seats not editable, and Back to the show', () => {
    const wrapper = mountLobby(snapshot('director', { started: true }));
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('showStart')).toBe(false);
    expect(wrapper.getComponent({ name: 'CastSeats' }).props('editable')).toBe(false);
    expect(wrapper.find('[data-testid="boundaries-section"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="back-to-show"]').text()).toBe('Back to the show');
    expect(wrapper.get('a.button').attributes('href')).toBe(`/sessions/show/director?identity=${'a'.repeat(32)}`);
    expect(wrapper.text()).not.toContain('The director starts the show');
    wrapper.unmount();
  });

  it('gives a practice show (no setup) the strip without Start show', () => {
    const wrapper = mountLobby(snapshot('director', { noSetup: true }));
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('showStart')).toBe(false);
    expect(wrapper.getComponent({ name: 'CastSeats' }).props('editable')).toBe(false);
    expect(wrapper.find('[data-testid="boundaries-section"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="back-to-show"]').text()).toBe('Back to the show');
    wrapper.unmount();
  });

  it('turns the strip off for an ended show', () => {
    const current = snapshot('director') as DirectorSnapshot;
    const wrapper = mountLobby({ ...current, session: { ...current.session, status: 'ended' } } as DirectorSnapshot);
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('showStart')).toBe(false);
    expect(wrapper.getComponent({ name: 'CastSeats' }).props('editable')).toBe(false);
    wrapper.unmount();
  });

  it('has the Cast & lobby heading and keeps Start show busy while a seat save runs', async () => {
    const wrapper = mountLobby(snapshot('director'));
    expect(wrapper.get('h2').text()).toBe('Cast & lobby');
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('busy')).toBe(false);
    wrapper.getComponent({ name: 'CastSeats' }).vm.$emit('saving', true);
    await flushPromises();
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('busy')).toBe(true);
    wrapper.getComponent({ name: 'CastSeats' }).vm.$emit('saving', false);
    await flushPromises();
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('busy')).toBe(false);
    wrapper.unmount();
  });

  it('passes busy down to the strip and the seats', async () => {
    const wrapper = mountLobby(snapshot('director'), true);
    expect(wrapper.getComponent({ name: 'ReadyStrip' }).props('busy')).toBe(true);
    expect(wrapper.getComponent({ name: 'CastSeats' }).props('busy')).toBe(true);
    expect(wrapper.get('[data-testid="save-boundaries"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('Cast & lobby for a player', () => {
  it('shows the brief, the cast with waiting seats, and their card, and nothing about boundaries or readiness', () => {
    const wrapper = mountLobby(snapshot('player'));
    expect(wrapper.text()).toContain('Recover the observatory.');
    const cast = wrapper.get('[data-testid="lobby-cast"]');
    expect(cast.findAll('li').map(item => item.text())).toEqual(['Aster · waiting', 'Briar']);
    expect(wrapper.getComponent({ name: 'PlayerCard' }).props()).toMatchObject({ busy: false });
    expect(wrapper.getComponent({ name: 'StreamLinks' }).props()).toMatchObject({ mode: 'player', ownCharacterId: 'pc-1' });
    for (const hidden of ['boundaries-section', 'boundaries', 'save-boundaries']) expect(wrapper.find(`[data-testid="${hidden}"]`).exists()).toBe(false);
    for (const gone of ['No harm to children.', "What the AI won't write", 'Ready', 'Mark ready', 'accept the current content boundaries']) expect(wrapper.text()).not.toContain(gone);
    expect(wrapper.find('[data-stub="ReadyStrip"]').exists()).toBe(false);
    expect(wrapper.find('[data-stub="CastSeats"]').exists()).toBe(false);
    expect(wrapper.find('[data-stub="SeatInvites"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('The director starts the show when every seat has a card.');
    wrapper.unmount();
  });

  it('passes the card commands from PlayerCard through', () => {
    const wrapper = mountLobby(snapshot('player'));
    const command = { type: 'save_character', commandId: crypto.randomUUID(), expectedCharacterRevision: 2, card };
    wrapper.getComponent({ name: 'PlayerCard' }).vm.$emit('command', command);
    expect(wrapper.emitted('command')![0]![0]).toEqual(command);
    wrapper.unmount();
  });

  it('links a player to the seat after the start', () => {
    const wrapper = mountLobby(snapshot('player', { started: true }));
    expect(wrapper.get('a.button').attributes('href')).toBe(`/sessions/show/play?identity=${'a'.repeat(32)}`);
    wrapper.unmount();
  });
});
