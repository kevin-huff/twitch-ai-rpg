// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot, PlayerSnapshot } from '@rpg/contracts';
import Lobby from './Lobby.vue';
import { api } from './api';

const card = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: 'A silver coat.', personality: 'Patient.', backstory: 'A former courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Navigation', flaw: 'Distrustful', possessions: ['Map', 'Compass', 'Coat'], connection: 'Owes the crew a favor.', secret: 'The map is a forgery.', extensions: {} };
function snapshot(role: 'director' | 'player') {
  const own = { ...card, id: 'pc-1', strain: 0, approved: false, cardRevision: 2, templateRef: { templateId: 'card', version: 1 }, draft: card, ready: false, acceptedBoundariesRevision: null };
  return {
    role, session: { id: 'show', stateRevision: 3, status: 'lobby', brief: { premise: 'Recover the observatory.', genre: 'Fantasy', tone: 'Hopeful', objectives: ['Enter the tower.'], playerHooks: ['An old debt.'] } },
    setup: { boundaries: ['No harm to children.'], boundariesRevision: 2, started: false, scenario: { templateId: 'scenario', version: 1 } },
    characters: [{ id: 'pc-1', displayName: 'Aster', approved: false, ready: false, strain: 0, appearance: 'A silver coat.' }, { id: 'pc-2', displayName: 'Briar', approved: true, ready: false, strain: 0, appearance: 'A green coat.' }],
    ...(role === 'director' ? { characterDetails: [own, { ...own, id: 'pc-2', displayName: 'Briar', approved: true, draft: null, secret: 'Other seat secret.' }] } : { ownCharacter: own }),
  } as unknown as DirectorSnapshot | PlayerSnapshot;
}
beforeEach(() => window.history.replaceState({}, '', `/sessions/show/lobby?identity=${'a'.repeat(32)}`));
afterEach(() => vi.restoreAllMocks());

describe('pre-show character review and readiness', () => {
  it('places card validation immediately before submit and preserves the editable draft', async () => {
    const wrapper = mount(Lobby, { props: { snapshot: snapshot('player'), busy: false } });
    await wrapper.get('[data-testid="card-name"]').setValue('');
    await wrapper.get('[data-testid="card-secret"]').setValue('Keep my unfinished secret.');
    const submit = wrapper.get('[data-testid="save-character-draft"]');
    await submit.trigger('click');
    const alert = wrapper.get('[role="alert"]');
    expect(submit.element.previousElementSibling).toBe(alert.element);
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    expect(form.element.compareDocumentPosition(alert.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((wrapper.get('[data-testid="card-secret"]').element as HTMLTextAreaElement).value).toBe('Keep my unfinished secret.');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="card-name"]').setValue('Aster');
    await submit.trigger('click');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('command')).toHaveLength(1);
    wrapper.unmount();
  });

  it.each(['director', 'player'] as const)('explains all %s lobby fields outside their labels', role => {
    const wrapper = mount(Lobby, { props: { snapshot: snapshot(role), busy: false } });
    for (const control of wrapper.findAll('input, textarea, select')) {
      const ids = control.attributes('aria-describedby')?.split(/\s+/) ?? [];
      expect(ids.length, control.element.outerHTML).toBeGreaterThan(0);
      for (const id of ids) {
        const descriptions = wrapper.findAll('[id]').filter(node => node.attributes('id') === id);
        expect(descriptions, id).toHaveLength(1);
        expect(descriptions[0]!.isVisible()).toBe(true);
        expect(descriptions[0]!.text().length).toBeGreaterThan(15);
        expect(descriptions[0]!.element.closest('label')).toBeNull();
      }
    }
    if (role === 'director') {
      const describedBy = (testId: string) => wrapper.findAll('[id]').find(node => node.attributes('id') === wrapper.get(`[data-testid="${testId}"]`).attributes('aria-describedby'))!.text();
      expect(describedBy('boundaries')).toMatch(/clears everyone.s readiness/);
      expect(describedBy('override-unready')).toMatch(/private/i);
      expect(wrapper.get('[data-testid="boundaries"]').element.closest('label')!.textContent).toBe('One boundary per line');
    }
    wrapper.unmount();
  });

  it('previews director boundaries and requires Apply followed by the existing explicit save', async () => {
    const generateField = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'No harm to children.\nFade to black for injury.' });
    const wrapper = mount(Lobby, { props: { snapshot: snapshot('director'), busy: false } });
    await wrapper.get('[data-testid="field-generator-open"]').trigger('click');
    await wrapper.get('[data-testid="field-generator-seed"]').setValue('No harm to children; fade to black for injury.');
    await wrapper.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(generateField).toHaveBeenCalledWith({ field: 'scenario.boundaries', seed: 'No harm to children; fade to black for injury.' });
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('No harm to children.');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('No harm to children.\nFade to black for injury.');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="save-boundaries"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toMatchObject({ type: 'set_boundaries', boundaries: ['No harm to children.', 'Fade to black for injury.'] });
    wrapper.unmount();
  });

  it.each(['revision', 'session', 'started'] as const)('discards pending boundary generation after a changed %s', async change => {
    const current = snapshot('director') as DirectorSnapshot;
    let resolve!: (value: { text: string }) => void;
    vi.spyOn(api, 'generateField').mockReturnValue(new Promise(result => { resolve = result; }));
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="field-generator-open"]').trigger('click');
    await wrapper.get('[data-testid="field-generator-generate"]').trigger('click');
    const next = change === 'session' ? { ...current, session: { ...current.session, id: 'other-show' } }
      : { ...current, setup: { ...current.setup!, ...(change === 'revision' ? { boundariesRevision: 3 } : { started: true }) } };
    await wrapper.setProps({ snapshot: next });
    resolve({ text: 'Stale generated boundary.' }); await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined();
    if (change !== 'started') expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('No harm to children.');
    wrapper.unmount();
  });

  it('offers boundary generation only to an editable director and disables it while busy', async () => {
    const current = snapshot('director') as DirectorSnapshot;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: true } });
    expect(wrapper.get('[data-testid="field-generator-open"]').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ busy: false });
    expect(wrapper.findAll('[data-testid="field-generator-open"]')).toHaveLength(1);
    await wrapper.setProps({ snapshot: snapshot('player') });
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    await wrapper.setProps({ snapshot: { ...current, setup: { ...current.setup!, started: true } } });
    expect(wrapper.find('[data-testid="field-generator-open"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not report a card conflict when another seat changes its readiness', async () => {
    const current = snapshot('player') as PlayerSnapshot;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="card-name"]').setValue('An unfinished local name');
    await wrapper.setProps({ snapshot: { ...current, eventSeq: 20, ownCharacter: { ...current.ownCharacter! }, characters: current.characters.map(character => ({ ...character, ready: character.id === 'pc-2' })) } });
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('An unfinished local name');
    expect(wrapper.text()).not.toContain('This card changed while you were editing.');
    wrapper.unmount();
  });

  it('keeps boundary acknowledgement across unrelated snapshots but resets it when the approved card changes', async () => {
    const current = snapshot('player') as PlayerSnapshot;
    current.ownCharacter!.approved = true;
    current.ownCharacter!.draft = null;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="accept-boundaries"]').setValue(true);
    await wrapper.setProps({ snapshot: { ...current, eventSeq: 20, ownCharacter: { ...current.ownCharacter! }, characters: current.characters.map(character => ({ ...character, ready: character.id === 'pc-2' })) } });
    expect((wrapper.get('[data-testid="accept-boundaries"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('[data-testid="ready-character"]').attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: current.ownCharacter!.cardRevision + 1 } } });
    expect((wrapper.get('[data-testid="accept-boundaries"]').element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });

  it('lets a player submit only their own explicit draft with its captured revision', async () => {
    const wrapper = mount(Lobby, { props: { snapshot: snapshot('player'), busy: false } });
    await wrapper.get('[data-testid="card-name"]').setValue('Aster Vale');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(expect.objectContaining({ type: 'save_character', expectedCharacterRevision: 2, card: expect.objectContaining({ displayName: 'Aster Vale' }) }));
    expect(wrapper.text()).not.toContain('Other seat secret.');
    expect(wrapper.find('[data-testid="start-session"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Test as ');
    wrapper.unmount();
  });

  it('requires explicit boundary acknowledgement and never marks ready on refresh', async () => {
    const current = snapshot('player') as PlayerSnapshot;
    current.ownCharacter!.approved = true;
    current.ownCharacter!.draft = null;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    expect(wrapper.get('[data-testid="ready-character"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="accept-boundaries"]').setValue(true);
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get('[data-testid="ready-character"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(expect.objectContaining({ type: 'set_ready', expectedCharacterRevision: 2, expectedBoundariesRevision: 2, ready: true }));
    await wrapper.setProps({ snapshot: { ...current, setup: { ...current.setup!, boundariesRevision: 3, boundaries: ['No harm to children.', 'Fade to black.'] } } });
    expect((wrapper.get('[data-testid="accept-boundaries"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.emitted('command')).toHaveLength(1);
    wrapper.unmount();
  });

  it('supports director approval, boundary review, and a reasoned readiness override', async () => {
    const current = snapshot('director') as DirectorSnapshot;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    expect(wrapper.text()).toContain('The map is a forgery.');
    await wrapper.get('[data-testid="approve-character-pc-1"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(expect.objectContaining({ type: 'approve_character', characterId: 'pc-1', expectedCharacterRevision: 2 }));
    expect(wrapper.get('[data-testid="start-session"]').attributes('disabled')).toBeDefined();
    const approved = { ...current, characters: current.characters.map(item => ({ ...item, approved: true })), characterDetails: current.characterDetails.map(item => ({ ...item, approved: true, draft: null })) };
    await wrapper.setProps({ snapshot: approved });
    await wrapper.get('[data-testid="override-unready"]').setValue('Briar will join after work.');
    await wrapper.get('[data-testid="start-session"]').trigger('click');
    expect(wrapper.emitted('command')?.at(-1)?.[0]).toEqual(expect.objectContaining({ type: 'start_session', expectedStateRevision: 3, overrideUnreadyReason: 'Briar will join after work.' }));
    await wrapper.get('[data-testid="boundaries"]').setValue('No harm to children.\nFade to black.');
    await wrapper.get('[data-testid="save-boundaries"]').trigger('click');
    expect(wrapper.emitted('command')?.at(-1)?.[0]).toEqual(expect.objectContaining({ type: 'set_boundaries', expectedStateRevision: 3, boundaries: ['No harm to children.', 'Fade to black.'] }));
    wrapper.unmount();
  });

  it('preserves a draft through incoming revisions and blocks card edits after start while allowing late acknowledgement', async () => {
    const current = snapshot('player') as PlayerSnapshot;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved name');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Unsaved name');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(expect.objectContaining({ expectedCharacterRevision: 2 }));
    await wrapper.setProps({ snapshot: { ...current, setup: { ...current.setup!, started: true }, ownCharacter: { ...current.ownCharacter!, approved: true, draft: null } } });
    expect(wrapper.find('[data-testid="save-character-draft"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ready-character"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('preserves but cannot overwrite unsaved boundaries after another director changes them', async () => {
    const current = snapshot('director') as DirectorSnapshot;
    const wrapper = mount(Lobby, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="boundaries"]').setValue('Local unfinished boundary.');
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, stateRevision: 4 }, setup: { ...current.setup!, boundariesRevision: 3, boundaries: ['Another director’s saved boundary.'] } } });
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('Local unfinished boundary.');
    expect(wrapper.get('[data-testid="save-boundaries"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('The saved boundaries changed while you were editing.');
    await wrapper.get('[data-testid="load-boundaries"]').trigger('click');
    expect((wrapper.get('[data-testid="boundaries"]').element as HTMLTextAreaElement).value).toBe('Another director’s saved boundary.');
    await wrapper.get('[data-testid="boundaries"]').setValue('Another director’s saved boundary.\nAgreed addition.');
    await wrapper.get('[data-testid="save-boundaries"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(expect.objectContaining({ type: 'set_boundaries', expectedStateRevision: 4, boundaries: ['Another director’s saved boundary.', 'Agreed addition.'] }));
    wrapper.unmount();
  });
});
