// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerSnapshot } from '@rpg/contracts';
import PreShow from './PreShow.vue';
import { api } from './api';

const card = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: 'A silver coat.', personality: 'Patient.', backstory: 'A former courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Navigation', flaw: 'Distrustful', possessions: ['Map', 'Compass', 'Coat'], connection: 'Owes the crew a favor.', secret: 'The map is a forgery.', extensions: {} };
const portraitId = '11111111-1111-4111-8111-111111111111';
const CharacterFormStub = defineComponent({
  name: 'CharacterForm',
  props: { modelValue: Object, description: String, disabled: Boolean, generationEnabled: Boolean, generationContext: [String, Number], premise: String, premiseLabel: String, generate: Function, generateCard: Function, cardGenerationNote: String, picturesEnabled: Boolean, generatePortrait: Function, portraitUrl: Function },
  emits: ['update:description'],
  template: '<div class="form-stub"><textarea data-testid="card-description" :value="description" @input="$emit(\'update:description\', $event.target.value)" /><input data-testid="card-name" v-model="modelValue.displayName"><textarea data-testid="card-appearance" v-model="modelValue.appearance" /><input v-for="index in 3" :key="index" :data-testid="`possession-${index}`" v-model="modelValue.possessions[index - 1]"></div>',
});
type Own = { approved: boolean; draft: unknown; cardSource?: 'host' | 'player'; cardRevision: number };
function snapshot(own: Partial<Own> & Record<string, unknown> = {}, extra: Record<string, unknown> = {}): PlayerSnapshot {
  const character = { ...card, id: 'pc-1', strain: 0, approved: true, cardRevision: 2, templateRef: { templateId: 'card', version: 1 }, draft: null, ready: false, acceptedBoundariesRevision: null, cardSource: 'host', ...own };
  return {
    role: 'player', session: { id: 'show', title: 'The Ledger Job', stateRevision: 3, status: 'lobby', brief: { premise: 'Recover the observatory.', genre: 'Fantasy', tone: 'Hopeful', objectives: [], playerHooks: [] } },
    setup: { boundaries: ['No harm to children.'], boundariesRevision: 2, started: false, scenario: { templateId: 'scenario', version: 1 } },
    characters: [{ id: 'pc-1', displayName: character.displayName, approved: character.approved, ready: false, strain: 0, appearance: character.appearance }, { id: 'pc-2', displayName: 'Briar', approved: true, ready: false, strain: 0, appearance: 'A green coat.' }, { id: 'pc-3', displayName: 'Seat 3', approved: false, ready: false, strain: 0, appearance: '' }],
    ownCharacter: character, picturesEnabled: false, ...extra,
  } as unknown as PlayerSnapshot;
}
const writing = (extra: Record<string, unknown> = {}) => snapshot({ approved: false, draft: null, displayName: 'Seat 1', appearance: '', secret: '', cardSource: undefined }, extra);
const mountShow = (current: PlayerSnapshot, busy = false) => mount(PreShow, { props: { snapshot: current, busy }, global: { stubs: { CharacterForm: CharacterFormStub } } });
const generated = (pronounsSuggested: boolean) => ({ card: { ...card, schemaVersion: 1 as const, displayName: 'Mira', pronouns: 'she/her', traits: { force: 0, finesse: 1, wits: 2, presence: 1 } }, notes: [], pronounsSuggested });
const openFold = async (wrapper: ReturnType<typeof mountShow>) => { const details = wrapper.get('[data-testid="change-my-card"]'); (details.element as HTMLDetailsElement).open = true; await details.trigger('toggle'); };

beforeEach(() => window.history.replaceState({}, '', `/sessions/show/play?identity=${'a'.repeat(32)}`));
afterEach(() => vi.restoreAllMocks());

describe('the pre-show page', () => {
  it('shows the title, the premise, the cast and the soon line, and never the boundaries', () => {
    const wrapper = mountShow(snapshot());
    expect(wrapper.get('[data-testid="pre-show"]').text()).toContain('The Ledger Job');
    expect(wrapper.text()).toContain('Recover the observatory.');
    const cast = wrapper.get('[data-testid="pre-show-cast"]').findAll('li').map(item => item.text());
    expect(cast).toEqual(['Aster (you)', 'Briar', 'Seat 3 · waiting']);
    expect(wrapper.text()).toContain('The cast');
    expect(wrapper.text()).toContain('The show will start soon.');
    expect(wrapper.text()).not.toContain('No harm to children.');
    expect(wrapper.text().toLowerCase()).not.toContain('boundaries');
    expect(wrapper.text().toLowerCase()).not.toContain('ready');
    wrapper.unmount();
  });

  it("marks the player's own seat as theirs, with waiting until it is approved", () => {
    const waiting = mountShow(writing());
    expect(waiting.get('[data-testid="pre-show-cast"]').findAll('li').map(item => item.text())).toEqual(['Seat 1 (you) · waiting', 'Briar', 'Seat 3 · waiting']);
    waiting.unmount();
    const approved = mountShow(snapshot());
    const items = approved.get('[data-testid="pre-show-cast"]').findAll('li').map(item => item.text());
    expect(items[0]).toBe('Aster (you)');
    expect(items.slice(1).join(' ')).not.toContain('(you)');
    approved.unmount();
  });

  it('works when the show has no premise', () => {
    const current = snapshot();
    const wrapper = mountShow({ ...current, session: { ...current.session, brief: undefined } });
    expect(wrapper.find('.premise').exists()).toBe(false);
    expect(wrapper.text()).toContain('The show will start soon.');
    wrapper.unmount();
  });

  it('re-emits the card command from the player card', async () => {
    const wrapper = mountShow(writing());
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toMatchObject({ type: 'save_character', card: { displayName: 'Mira' } });
    wrapper.unmount();
  });
});

describe('the player card', () => {
  it('shows a host-made card as a summary with the host line and a closed Change my card', () => {
    const wrapper = mountShow(snapshot());
    const section = wrapper.get('[data-testid="player-card"]');
    expect(section.get('h2').text()).toBe('Your character');
    expect(section.text()).toContain('Aster');
    expect(section.text()).toContain('they/them');
    expect(section.text()).toContain('A silver coat.');
    expect(section.text()).toContain('Patient.');
    expect(section.text()).not.toContain('The map is a forgery.');
    expect(wrapper.get('[data-testid="host-picked-note"]').text()).toBe('Your host picked this character for you.');
    const fold = wrapper.get('[data-testid="change-my-card"]');
    expect(fold.element.tagName).toBe('DETAILS');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    expect(fold.get('summary').text()).toBe('Change my card');
    expect(fold.find('[data-testid="save-character-draft"]').exists()).toBe(true);
    expect(fold.get('[data-testid="save-character-draft"]').text()).toBe('Save my card');
    wrapper.unmount();
  });

  it("shows a player's own card without the host line", () => {
    const wrapper = mountShow(snapshot({ cardSource: 'player' }));
    expect(wrapper.get('[data-testid="player-card"]').text()).toContain('Aster');
    expect(wrapper.find('[data-testid="host-picked-note"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('leaves out summary lines the card does not fill', () => {
    const wrapper = mountShow(snapshot({ pronouns: '', personality: '' }));
    const text = wrapper.get('[data-testid="player-card"]').text();
    expect(text).not.toContain('Pronouns');
    expect(text).not.toContain('Personality');
    expect(text).toContain('Looks');
    wrapper.unmount();
  });

  it('shows the form directly for a seat without a card', () => {
    const wrapper = mountShow(writing());
    expect(wrapper.find('[data-testid="change-my-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="host-picked-note"]').exists()).toBe(false);
    expect(wrapper.get('h2').text()).toBe('The cast');
    expect(wrapper.get('[data-testid="player-card"] h2').text()).toBe('Your character');
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    expect(form.props('modelValue')).toMatchObject({ displayName: '', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: ['', '', ''], extensions: {} });
    expect(wrapper.get('[data-testid="save-character-draft"]').text()).toBe('Save my card');
    wrapper.unmount();
  });

  it('does not bind a pronoun gate and never blocks saving', () => {
    const wrapper = mountShow(writing());
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    expect(form.props()).not.toHaveProperty('pronounsPending');
    expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="save-character-draft"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('opens the short form from Change my card and saves with the form revision and no seat id', async () => {
    const wrapper = mountShow(snapshot());
    await openFold(wrapper);
    await wrapper.get('[data-testid="card-appearance"]').setValue('A silver coat, newly mended.');
    await wrapper.get('[data-testid="card-name"]').setValue('Aster ');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    const command = wrapper.emitted('command')![0]![0] as Record<string, unknown>;
    expect(command).toMatchObject({ type: 'save_character', expectedCharacterRevision: 2, card: { displayName: 'Aster', appearance: 'A silver coat, newly mended.' } });
    expect(command).not.toHaveProperty('characterId');
    expect(typeof command.commandId).toBe('string');
    wrapper.unmount();
  });

  it('trims possessions and drops blank ones', async () => {
    const wrapper = mountShow(snapshot());
    await openFold(wrapper);
    await wrapper.get('[data-testid="possession-1"]').setValue(' a lantern ');
    await wrapper.get('[data-testid="possession-2"]').setValue('   ');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    const sent = wrapper.emitted('command')![0]![0] as unknown as { card: { possessions: string[] } };
    expect(sent.card.possessions).toEqual(['a lantern', 'Coat']);
    wrapper.unmount();
  });

  it('shows the plain error when a blank card is saved and sends nothing', async () => {
    const wrapper = mountShow(writing());
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toBe('Give your character a name. Nothing has been saved.');
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('closes the fold after the save lands and shows the new summary', async () => {
    const current = snapshot();
    const wrapper = mountShow(current);
    await openFold(wrapper);
    await wrapper.get('[data-testid="card-name"]').setValue('Aster Vale');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    const sent = (wrapper.emitted('command')![0]![0] as unknown as { card: Record<string, unknown> }).card;
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, ...sent, cardSource: 'player', cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="change-my-card"]').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.get('[data-testid="player-card"]').text()).toContain('Aster Vale');
    expect(wrapper.find('[data-testid="host-picked-note"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('This card changed while you were editing');
    wrapper.unmount();
  });

  it('turns a saved blank seat into a summary with a closed fold', async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    const sent = (wrapper.emitted('command')![0]![0] as unknown as { card: Record<string, unknown> }).card;
    await wrapper.setProps({ snapshot: { ...current, characters: current.characters.map(item => item.id === 'pc-1' ? { ...item, displayName: 'Mira', approved: true } : item), ownCharacter: { ...current.ownCharacter!, ...sent, approved: true, draft: null, cardSource: 'player', cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="change-my-card"]').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.get('[data-testid="player-card"]').text()).toContain('Mira');
    expect(wrapper.get('[data-testid="pre-show-cast"]').text()).toContain('Mira');
    expect(wrapper.text()).not.toContain('Unsaved');
    wrapper.unmount();
  });

  it('keeps unsaved words and offers the latest card when the card changes elsewhere', async () => {
    const current = snapshot({ cardSource: 'player' });
    const wrapper = mountShow(current);
    await openFold(wrapper);
    await wrapper.get('[data-testid="card-name"]').setValue('Typed Name');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, displayName: 'Director Name', appearance: 'Written by another window.', cardSource: 'player', cardRevision: 3 } } });
    await flushPromises();
    expect(wrapper.text()).toContain('This card changed while you were editing.');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Typed Name');
    expect((wrapper.get('[data-testid="change-my-card"]').element as HTMLDetailsElement).open).toBe(true);
    await wrapper.get('button.quiet').trigger('click');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Director Name');
    expect(wrapper.text()).not.toContain('This card changed while you were editing.');
    wrapper.unmount();
  });

  it('keeps the form, the description and both choices when the host saves into the seat meanwhile', async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall clerk with ink on her sleeves.');
    const hosted = { ...current.ownCharacter!, displayName: 'Director Name', appearance: 'Written by the host.', approved: true, draft: null, cardSource: 'host' as const, cardRevision: 3 };
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: hosted } });
    await flushPromises();
    expect(wrapper.get('[data-testid="host-saved-notice"]').text()).toBe('Your host just saved a card for this seat.');
    expect(wrapper.get('[data-testid="use-host-card"]').text()).toBe("Use the host's card");
    expect(wrapper.get('[data-testid="keep-my-card"]').text()).toBe('Keep mine');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Mira');
    expect((wrapper.get('[data-testid="card-description"]').element as HTMLTextAreaElement).value).toBe('A tall clerk with ink on her sleeves.');
    expect((wrapper.get('[data-testid="change-my-card"]').element as HTMLDetailsElement).open).toBe(true);
    wrapper.unmount();
  });

  it('keeps mine against the host revision, with the description copied into a blank Appearance', async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall clerk.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, displayName: 'Director Name', appearance: 'Written by the host.', approved: true, draft: null, cardSource: 'host', cardRevision: 3 } } });
    await flushPromises();
    await wrapper.get('[data-testid="keep-my-card"]').trigger('click');
    expect(wrapper.emitted('command')).toHaveLength(1);
    expect(wrapper.emitted('command')![0]![0]).toMatchObject({ type: 'save_character', expectedCharacterRevision: 3, card: { displayName: 'Mira', appearance: 'A tall clerk.' } });
    wrapper.unmount();
  });

  it("loads the host's card and clears the description when asked", async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall clerk.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, displayName: 'Director Name', appearance: 'Written by the host.', approved: true, draft: null, cardSource: 'host', cardRevision: 3 } } });
    await flushPromises();
    await wrapper.get('[data-testid="use-host-card"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Director Name');
    expect((wrapper.get('[data-testid="card-description"]').element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.find('[data-testid="host-saved-notice"]').exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('keeps the description through a revision bump with the same card, and clears it once the save lands', async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall clerk.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="card-description"]').element as HTMLTextAreaElement).value).toBe('A tall clerk.');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    const sent = (wrapper.emitted('command')![0]![0] as unknown as { card: Record<string, unknown> }).card;
    expect(sent.appearance).toBe('A tall clerk.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, ...sent, approved: true, draft: null, cardSource: 'player', cardRevision: 4 } } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('This card changed while you were editing');
    expect(wrapper.find('[data-testid="host-saved-notice"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="change-my-card"]').element as HTMLDetailsElement).open).toBe(false);
    wrapper.unmount();
  });

  it('names the traits, not the name, when the traits are wrong', async () => {
    const wrapper = mountShow(writing());
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    const model = wrapper.getComponent({ name: 'CharacterForm' }).props('modelValue') as { traits: Record<string, number> };
    model.traits.force = 2; model.traits.finesse = 2; model.traits.wits = 2; model.traits.presence = 2;
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toBe('Give the four traits one +2, two +1 and one +0. They are under More about your character.');
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('names the box to fix when another box is wrong', async () => {
    const wrapper = mountShow(writing());
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    const model = wrapper.getComponent({ name: 'CharacterForm' }).props('modelValue') as { pronouns: string };
    model.pronouns = 'x'.repeat(81);
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toBe('Check Pronouns under More about your character. Nothing has been saved.');
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('prefills a legacy draft and saves its fields', async () => {
    const draft = { ...card, displayName: 'Draft Name', appearance: 'Drafted look.', personality: 'Drafted nerve.' };
    const wrapper = mountShow(snapshot({ approved: false, draft, cardSource: undefined }));
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Draft Name');
    expect(wrapper.getComponent({ name: 'CharacterForm' }).props('modelValue')).toMatchObject({ displayName: 'Draft Name', appearance: 'Drafted look.', personality: 'Drafted nerve.' });
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')![0]![0]).toMatchObject({ type: 'save_character', expectedCharacterRevision: 2, card: { displayName: 'Draft Name', appearance: 'Drafted look.', personality: 'Drafted nerve.', backstory: card.backstory } });
    wrapper.unmount();
  });

  it('adopts a revision bump on a seat being written without losing the typed words', async () => {
    const current = writing();
    const wrapper = mountShow(current);
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-appearance"]').setValue('Tall, with ink on her sleeves.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Mira');
    expect((wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value).toBe('Tall, with ink on her sleeves.');
    expect(wrapper.text()).not.toContain('This card changed while you were editing');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toMatchObject({ type: 'save_character', expectedCharacterRevision: 3, card: { displayName: 'Mira' } });
    wrapper.unmount();
  });

  it('makes the card read-only after the start', () => {
    const current = snapshot();
    const wrapper = mountShow({ ...current, setup: { ...current.setup!, started: true }, session: { ...current.session, status: 'live' } });
    expect(wrapper.get('[data-testid="player-card"]').text()).toContain('Aster');
    expect(wrapper.find('[data-testid="change-my-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="save-character-draft"]').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'CharacterForm' }).exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a portrait in the summary only when pictures are on', () => {
    const on = mountShow(snapshot({ portraitId }, { picturesEnabled: true }));
    expect(on.get('[data-testid="player-card"] img').attributes('src')).toBe(`/api/sessions/show/images/${portraitId}?identity=${'a'.repeat(32)}`);
    expect(on.get('[data-testid="player-card"] img').attributes('alt')).toBe('Portrait of Aster');
    on.unmount();
    const off = mountShow(snapshot({ portraitId }, { picturesEnabled: false }));
    expect(off.find('[data-testid="player-card"] img').exists()).toBe(false);
    off.unmount();
  });

  it('renders nothing for the card when the seat has no character', () => {
    const wrapper = mountShow({ ...snapshot(), ownCharacter: null } as unknown as PlayerSnapshot);
    expect(wrapper.find('[data-testid="player-card"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('The show will start soon.');
    wrapper.unmount();
  });
});

describe('seat generation from the player card', () => {
  it('sends per-field generation through the seat route with usePremise and never the premise text', async () => {
    const generateSeatField = vi.spyOn(api, 'generateSeatField').mockResolvedValue({ text: 'A quiet clerk.' });
    const wrapper = mountShow(writing());
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    expect(form.props('premise')).toBe('Recover the observatory.');
    expect(form.props('premiseLabel')).toBe('Story premise');
    expect(form.props('generationEnabled')).toBe(true);
    await form.props('generate')({ field: 'character.personality', seed: 'A shy clerk.', premise: 'Recover the observatory.' });
    expect(generateSeatField).toHaveBeenCalledTimes(1);
    const body = generateSeatField.mock.calls[0]![1];
    expect(generateSeatField.mock.calls[0]![0]).toBe('show');
    expect(body).toMatchObject({ expectedCharacterRevision: 2, field: 'character.personality', seed: 'A shy clerk.', usePremise: true });
    expect(body.characterContext.kind).toBe('character');
    expect(JSON.stringify(body)).not.toContain('Recover the observatory.');
    wrapper.unmount();
  });

  it('sends the whole card through the seat card route with the form revision', async () => {
    const generateSeatCard = vi.spyOn(api, 'generateSeatCard').mockResolvedValue(generated(false));
    const wrapper = mountShow(writing());
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    expect(form.props('cardGenerationNote')).toBe("The story's premise is sent too.");
    const current = { kind: 'character', name: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: card.traits, specialty: '', flaw: '', possessions: [], connection: '' };
    await form.props('generateCard')({ prompt: 'A clever clerk.', keepFilled: true, current });
    expect(generateSeatCard).toHaveBeenCalledTimes(1);
    expect(generateSeatCard.mock.calls[0]![0]).toBe('show');
    expect(generateSeatCard.mock.calls[0]![1]).toMatchObject({ expectedCharacterRevision: 2, prompt: 'A clever clerk.', keepFilled: true });
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('uses the latest revision after a bump', async () => {
    const seatCard = vi.spyOn(api, 'generateSeatCard').mockResolvedValue(generated(false));
    const portrait = vi.spyOn(api, 'createSeatPortrait').mockResolvedValue({ imageId: portraitId });
    const current = writing({ picturesEnabled: true });
    const wrapper = mountShow(current);
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: 3 } } });
    await flushPromises();
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    await form.props('generateCard')({ prompt: 'A clever clerk.', keepFilled: false, current: { kind: 'character', name: '' } });
    expect(seatCard.mock.calls[0]![1]).toMatchObject({ expectedCharacterRevision: 3 });
    await form.props('generatePortrait')({ appearance: 'A silver coat.', role: '', pronouns: '', name: 'Aster' });
    expect(portrait).toHaveBeenCalledWith('show', { expectedCharacterRevision: 3, details: { appearance: 'A silver coat.', role: '', pronouns: '', name: 'Aster' } });
    wrapper.unmount();
  });

  it('gives the form the portrait props only when pictures are on', async () => {
    const on = mountShow(writing({ picturesEnabled: true }));
    const form = on.getComponent({ name: 'CharacterForm' });
    expect(form.props('picturesEnabled')).toBe(true);
    expect(form.props('portraitUrl')!(portraitId)).toBe(`/api/sessions/show/images/${portraitId}?identity=${'a'.repeat(32)}`);
    const create = vi.spyOn(api, 'createSeatPortrait').mockResolvedValue({ imageId: portraitId });
    await form.props('generatePortrait')!({ appearance: 'A silver coat.', role: '', pronouns: '', name: 'Aster' });
    expect(create).toHaveBeenCalledWith('show', { expectedCharacterRevision: 2, details: { appearance: 'A silver coat.', role: '', pronouns: '', name: 'Aster' } });
    on.unmount();
    const off = mountShow(writing({ picturesEnabled: false }));
    expect(off.getComponent({ name: 'CharacterForm' }).props('picturesEnabled')).toBe(false);
    off.unmount();
  });

  it('refuses to generate once the card can no longer be edited', async () => {
    const current = writing({ picturesEnabled: true });
    const wrapper = mountShow(current);
    const form = wrapper.getComponent({ name: 'CharacterForm' });
    const create = vi.spyOn(api, 'createSeatPortrait').mockResolvedValue({ imageId: portraitId });
    const seatCard = vi.spyOn(api, 'generateSeatCard').mockResolvedValue(generated(false));
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'live' } } });
    await expect(form.props('generatePortrait')({ appearance: 'A silver coat.', role: '', pronouns: '', name: 'Aster' })).rejects.toThrow('unavailable');
    await expect(form.props('generateCard')({ prompt: 'x', keepFilled: false, current: { kind: 'character', name: '' } })).rejects.toThrow('unavailable');
    expect(create).not.toHaveBeenCalled();
    expect(seatCard).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the portrait of a saved card when it is edited and saved again', async () => {
    const wrapper = mountShow(snapshot({ portraitId }, { picturesEnabled: true }));
    await openFold(wrapper);
    await wrapper.get('[data-testid="card-appearance"]').setValue('A silver coat, newly mended.');
    await wrapper.get('[data-testid="save-character-draft"]').trigger('click');
    expect(wrapper.emitted('command')?.[0]?.[0]).toMatchObject({ type: 'save_character', expectedCharacterRevision: 2, card: { displayName: 'Aster', appearance: 'A silver coat, newly mended.', portraitId } });
    wrapper.unmount();
  });
});

describe('the player card with the real character form', () => {
  it('keeps a typed description through a revision bump with the same card', async () => {
    const current = writing();
    const wrapper = mount(PreShow, { props: { snapshot: current, busy: false } });
    await wrapper.get('[data-testid="card-name"]').setValue('Mira');
    await wrapper.get('[data-testid="card-description"]').setValue('A tall clerk.');
    await wrapper.setProps({ snapshot: { ...current, ownCharacter: { ...current.ownCharacter!, cardRevision: 3 } } });
    await flushPromises();
    expect((wrapper.get('[data-testid="card-description"]').element as HTMLTextAreaElement).value).toBe('A tall clerk.');
    wrapper.unmount();
  });
});
