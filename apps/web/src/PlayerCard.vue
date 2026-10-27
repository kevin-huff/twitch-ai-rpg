<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { CharacterCardDefinitionSchema } from '@rpg/contracts';
import type { CardGenerationResponse, Character, CharacterCardDefinition, Command, FieldGenerationCharacterContext, FieldGenerationRequest, FieldGenerationResponse, PictureIdResponse, PlayerSnapshot, PortraitDetails } from '@rpg/contracts';
import CharacterForm from './CharacterForm.vue';
import PictureAvatar from './PictureAvatar.vue';
import { api } from './api';
import { withDescription } from './card-description';
import { characterFieldContext } from './field-context';
import { pictureUrl } from './pictures';
import { CARD_NAME_MESSAGE, cardSaveMessage } from './card-errors';

const props = defineProps<{ snapshot: PlayerSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command] }>();
const own = computed(() => props.snapshot.ownCharacter ?? null);
const setup = computed(() => props.snapshot.setup);
const editable = computed(() => Boolean(setup.value && !setup.value.started && props.snapshot.session.status === 'lobby'));
const hasCard = computed(() => Boolean(own.value?.approved && !own.value.draft));
const writing = computed(() => Boolean(own.value && !own.value.draft && !own.value.approved));
const briefPremise = computed(() => props.snapshot.session.brief?.premise.trim() ?? '');
const picturesOn = computed(() => props.snapshot.picturesEnabled === true);
const form = ref<CharacterCardDefinition | null>(null);
const formCharacterId = ref('');
const formRevision = ref(0);
const formBaseline = ref('');
const cardKey = (card: CharacterCardDefinition) => { const { extensions, portraitId, ...rest } = card; return JSON.stringify({ ...rest, displayName: card.displayName.trim(), possessions: card.possessions.map(value => value?.trim() ?? '').filter(Boolean), portraitId: portraitId ?? null, extensions }); };
const description = ref('');
const dirty = computed(() => Boolean(form.value && (cardKey(form.value) !== formBaseline.value || description.value.trim() !== '')));
let lastSent: string | null = null;
const error = ref('');
const changedElsewhere = ref(false);
const foldOpen = ref(false);
const sessionScope = () => ({ kind: 'session', sessionId: props.snapshot.session.id }) as const;
const portraitSrc = (portraitId: string | null | undefined) => portraitId ? pictureUrl(sessionScope(), portraitId) : null;
const ownPortrait = computed(() => picturesOn.value ? portraitSrc(own.value?.portraitId) : null);
const portraitUrlFor = (imageId: string) => pictureUrl(sessionScope(), imageId);
const summaryRows = computed(() => {
  const character = own.value;
  if (!character) return [];
  return ([['Pronouns', character.pronouns], ['Looks', character.appearance], ['Personality', character.personality]] as const)
    .map(([label, value]) => ({ label, value: (value ?? '').trim() })).filter(row => row.value);
});
function characterCard(character: Character): CharacterCardDefinition {
  if (!character.draft && !character.approved) return { schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: ['', '', ''], connection: '', secret: '', extensions: {} };
  if (character.draft) return JSON.parse(JSON.stringify(character.draft));
  return CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: character.displayName, pronouns: character.pronouns, appearance: character.appearance, personality: character.personality, backstory: character.backstory, traits: character.traits, specialty: character.specialty, flaw: character.flaw, possessions: character.possessions.slice(0, 3).filter(Boolean), connection: character.connection, secret: character.secret, extensions: {}, portraitId: character.portraitId });
}
function resetDraft() {
  if (!own.value) return;
  form.value = characterCard(own.value); formBaseline.value = cardKey(form.value); formRevision.value = own.value.cardRevision;
  formCharacterId.value = own.value.id; changedElsewhere.value = false; error.value = '';
}
let seenRevision: number | undefined;
watch([() => own.value?.id, () => own.value?.cardRevision, () => setup.value?.scenario.templateId], () => {
  if (!own.value) { form.value = null; return; }
  const moved = seenRevision !== undefined && own.value.cardRevision !== seenRevision;
  seenRevision = own.value.cardRevision;
  const incoming = characterCard(own.value);
  const incomingKey = cardKey(incoming);
  const typed = description.value;
  const sameSeat = Boolean(form.value) && own.value.id === formCharacterId.value;
  const savedHere = sameSeat && lastSent !== null && incomingKey === lastSent;
  lastSent = null;
  if (savedHere) { description.value = ''; resetDraft(); }
  else if (!form.value || !sameSeat || !dirty.value || incomingKey === cardKey(form.value)) resetDraft();
  else if (writing.value && incomingKey === formBaseline.value) formRevision.value = own.value.cardRevision;
  else { changedElsewhere.value = true; foldOpen.value = true; }
  if (typed && !savedHere) void nextTick(() => { if (!description.value) description.value = typed; });
  if (moved && !changedElsewhere.value) foldOpen.value = false;
}, { immediate: true });
function send(command: Command) { error.value = ''; emit('command', command); }
async function generateField(request: FieldGenerationRequest): Promise<FieldGenerationResponse> {
  const supplied = request.characterContext ?? (form.value ? characterFieldContext(form.value) : undefined);
  if (!editable.value || !supplied || supplied.kind !== 'character') throw new Error('This character card is unavailable for generation.');
  const characterContext: Extract<FieldGenerationCharacterContext, { kind: 'character' }> = supplied;
  return api.generateSeatField(props.snapshot.session.id, { expectedCharacterRevision: formRevision.value, field: request.field, seed: request.seed, characterContext, usePremise: request.premise !== undefined });
}
async function generatePortrait(details: PortraitDetails): Promise<PictureIdResponse> {
  if (!editable.value) throw new Error('This character card is unavailable for generation.');
  return api.createSeatPortrait(props.snapshot.session.id, { expectedCharacterRevision: formRevision.value, details });
}
async function generateCard(input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }): Promise<CardGenerationResponse> {
  const current = input.current;
  if (!editable.value || current.kind !== 'character') throw new Error('This character card is unavailable for generation.');
  return api.generateSeatCard(props.snapshot.session.id, { expectedCharacterRevision: formRevision.value, prompt: input.prompt, keepFilled: input.keepFilled, current });
}
function saveCard(revision = formRevision.value) {
  if (!form.value || !editable.value) return;
  const withText = withDescription(form.value, description.value);
  if (!withText.displayName.trim()) { error.value = CARD_NAME_MESSAGE; return; }
  const parsed = CharacterCardDefinitionSchema.safeParse({ ...withText, possessions: withText.possessions.map(value => value?.trim() ?? '').filter(Boolean) });
  if (!parsed.success) {
    error.value = cardSaveMessage(parsed.error.issues);
    return;
  }
  lastSent = cardKey(parsed.data);
  send({ type: 'save_character', commandId: crypto.randomUUID(), expectedCharacterRevision: revision, card: parsed.data });
}
function useHostCard() { description.value = ''; resetDraft(); }
function keepMine() { if (own.value) saveCard(own.value.cardRevision); }
</script>

<template>
  <section v-if="own" class="player-card" data-testid="player-card">
    <h2>Your character</h2>
    <template v-if="hasCard">
      <div class="card-summary">
        <PictureAvatar v-if="ownPortrait" :name="own.displayName" :src="ownPortrait" :size="72" />
        <div><h3>{{ own.displayName }}</h3><dl v-if="summaryRows.length"><template v-for="row in summaryRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl></div>
      </div>
      <p v-if="own.cardSource === 'host'" class="muted" data-testid="host-picked-note">Your host picked this character for you.</p>
    </template>
    <template v-if="editable && form">
      <details v-if="hasCard" class="change-card" data-testid="change-my-card" :open="foldOpen" @toggle="foldOpen = ($event.target as HTMLDetailsElement).open"><summary>Change my card</summary>
        <div v-if="changedElsewhere && own.cardSource === 'host'" class="notice"><p data-testid="host-saved-notice">Your host just saved a card for this seat.</p><button class="quiet" data-testid="use-host-card" @click="useHostCard">Use the host's card</button><button class="quiet" data-testid="keep-my-card" :disabled="busy" @click="keepMine">Keep mine</button></div>
        <p v-else-if="changedElsewhere" class="notice">This card changed while you were editing. Your unsaved words are preserved. Review the latest saved card before replacing it.<button class="quiet" @click="resetDraft">Load latest saved card</button></p>
        <CharacterForm v-model="form" v-model:description="description" :disabled="busy" generation-enabled :generation-context="`${own.id}:${formRevision}`" :premise="briefPremise || undefined" premise-label="Story premise" :generate="generateField" :generate-card="generateCard" :card-generation-note="briefPremise ? 'The story\'s premise is sent too.' : undefined" :pictures-enabled="picturesOn" :generate-portrait="generatePortrait" :portrait-url="portraitUrlFor" />
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <button :disabled="busy" data-testid="save-character-draft" @click="saveCard()">Save my card</button>
      </details>
      <template v-else>
        <div v-if="changedElsewhere && own.cardSource === 'host'" class="notice"><p data-testid="host-saved-notice">Your host just saved a card for this seat.</p><button class="quiet" data-testid="use-host-card" @click="useHostCard">Use the host's card</button><button class="quiet" data-testid="keep-my-card" :disabled="busy" @click="keepMine">Keep mine</button></div>
        <p v-else-if="changedElsewhere" class="notice">This card changed while you were editing. Your unsaved words are preserved. Review the latest saved card before replacing it.<button class="quiet" @click="resetDraft">Load latest saved card</button></p>
        <CharacterForm v-model="form" v-model:description="description" :disabled="busy" generation-enabled :generation-context="`${own.id}:${formRevision}`" :premise="briefPremise || undefined" premise-label="Story premise" :generate="generateField" :generate-card="generateCard" :card-generation-note="briefPremise ? 'The story\'s premise is sent too.' : undefined" :pictures-enabled="picturesOn" :generate-portrait="generatePortrait" :portrait-url="portraitUrlFor" />
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <button :disabled="busy" data-testid="save-character-draft" @click="saveCard()">Save my card</button>
      </template>
    </template>
    <p v-else-if="!hasCard" class="muted">Your character card is fixed once the show starts.</p>
  </section>
</template>

<style scoped>
.player-card { margin: 1.5rem 0; }
.card-summary { display: flex; gap: 1rem; align-items: flex-start; }
.card-summary h3 { margin: 0 0 .4rem; }
.card-summary dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .3rem 1rem; margin: 0; }
.card-summary dt { color: var(--muted); }
.card-summary dd { margin: 0; overflow-wrap: anywhere; }
.change-card { margin-top: 1rem; }
.change-card > summary { cursor: pointer; }
.change-card[open] > summary { margin-bottom: 1rem; }
</style>
