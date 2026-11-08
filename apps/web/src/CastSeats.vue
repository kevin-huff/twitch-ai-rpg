<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue';
import { CARD_ENTRY_MAX, CharacterCardDefinitionSchema, CommandSchema, FEELINGS_MAX, LOOKS_CHANGED_MAX, OWES_MAX, WEARING_MAX, type Character, type CharacterCardDefinition, type Command, type DirectorSnapshot, type FieldGenerationCharacterContext } from '@rpg/contracts';
import CharacterForm from './CharacterForm.vue';
import { withDescription } from './card-description';
import PictureAvatar from './PictureAvatar.vue';
import { api } from './api';
import { identityPath } from './identity';
import { pictureUrl } from './pictures';
import { cardSaveMessage } from './card-errors';

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean; editable: boolean }>();
const emit = defineEmits<{ command: [command: Command]; saving: [active: boolean] }>();
const prefix = useId();
const fieldId = (key: string) => `${prefix}-${key}`;

const hasCard = (character: Character) => character.approved && !character.draft;
const picturesOn = computed(() => props.snapshot.picturesEnabled === true);
const portrait = (character: Character) => picturesOn.value && character.portraitId ? pictureUrl({ kind: 'session', sessionId: props.snapshot.session.id }, character.portraitId) : null;
const testSeatUrl = (character: Character) => identityPath(`/sessions/${encodeURIComponent(props.snapshot.session.id)}/play?testCharacterId=${encodeURIComponent(character.id)}`);
const premise = computed(() => {
  const text = props.snapshot.session.brief?.premise.trim() ?? '';
  return text.length >= 1 && text.length <= 4000 ? text : undefined;
});
const liveEditable = computed(() => {
  const status = props.snapshot.session.status;
  return (!props.snapshot.setup || props.snapshot.setup.started) && (status === 'live' || status === 'paused');
});
const canRemove = computed(() => props.editable && props.snapshot.characterDetails.length > 1);

const open = reactive<Record<string, boolean>>({});
const prompts = reactive<Record<string, string>>({});
const writing = reactive<Record<string, boolean>>({});
const errors = reactive<Record<string, string>>({});
const confirming = ref('');
const changing = reactive<Record<string, boolean>>({});
const changeCards = reactive<Record<string, CharacterCardDefinition>>({});
const changeDescriptions = reactive<Record<string, string>>({});
const changeRevisions = reactive<Record<string, number>>({});
const changeSaving = reactive<Record<string, boolean>>({});

const cardFields = ['pronouns', 'appearance', 'personality', 'backstory', 'specialty', 'flaw', 'connection', 'secret'] as const;
const shownCard = (character: Character) => hasCard(character) ? character : character.draft;
const fieldLabel = (field: (typeof cardFields)[number]) => field === 'secret' ? 'Private secret' : field;
function approvedCard(character: Character): CharacterCardDefinition {
  return CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: character.displayName, pronouns: character.pronouns, appearance: character.appearance, personality: character.personality, backstory: character.backstory, traits: character.traits, specialty: character.specialty, flaw: character.flaw, possessions: character.possessions.slice(0, 3).filter(Boolean), connection: character.connection, secret: character.secret, extensions: {}, portraitId: character.portraitId });
}
const generating = reactive<Record<string, number>>({});
async function generateChangedCard(characterId: string, input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }) {
  if (input.current.kind !== 'character') throw new Error('This character card is unavailable for generation.');
  generating[characterId] = (generating[characterId] ?? 0) + 1;
  try { return await api.generateCard({ prompt: input.prompt, keepFilled: input.keepFilled, current: input.current, ...(premise.value ? { premise: premise.value } : {}) }); }
  finally { generating[characterId] = Math.max(0, (generating[characterId] ?? 1) - 1); }
}

const pending = reactive<Record<string, number>>({});
const awaiting = reactive<Record<string, number>>({});
const pendingTotal = ref(0);
const currentRevision = (characterId: string) => props.snapshot.characterDetails.find(character => character.id === characterId)?.cardRevision;
const isSaving = (characterId: string) => (pending[characterId] ?? 0) > 0 || (characterId in awaiting && awaiting[characterId] === currentRevision(characterId));
const anyActive = computed(() => pendingTotal.value > 0 || Object.keys(awaiting).length > 0 || Object.values(generating).some(count => count > 0));
watch(anyActive, active => emit('saving', active), { flush: 'sync' });
watch(() => props.snapshot.characterDetails, details => {
  for (const id of Object.keys(awaiting)) {
    if (details.find(character => character.id === id)?.cardRevision !== awaiting[id]) delete awaiting[id];
  }
}, { deep: true });
let saveChain: Promise<unknown> = Promise.resolve();
function queueSave(characterId: string, command: Command): Promise<boolean> {
  const sessionId = props.snapshot.session.id;
  pending[characterId] = (pending[characterId] ?? 0) + 1;
  pendingTotal.value++;
  const run = saveChain.then(async () => {
    try {
      await api.command(sessionId, command);
      if (command.type === 'approve_character' || command.type === 'save_character') {
        if (currentRevision(characterId) === command.expectedCharacterRevision) awaiting[characterId] = command.expectedCharacterRevision;
      }
      return true;
    }
    catch (caught) { errors[characterId] = caught instanceof Error ? caught.message : "Couldn't save this card."; return false; }
    finally {
      pending[characterId] = Math.max(0, (pending[characterId] ?? 1) - 1);
      pendingTotal.value--;
    }
  });
  saveChain = run;
  return run;
}

function openWriter(character: Character) { open[character.id] = true; errors[character.id] = ''; confirming.value = ''; }
async function writeCard(character: Character) {
  const prompt = (prompts[character.id] ?? '').trim();
  if (!prompt || writing[character.id]) return;
  writing[character.id] = true; errors[character.id] = '';
  try {
    const result = await api.generateCard({ prompt, keepFilled: true, ...(premise.value ? { premise: premise.value } : {}) });
    const saved = await queueSave(character.id, { type: 'save_character', commandId: crypto.randomUUID(), characterId: character.id, expectedCharacterRevision: character.cardRevision, card: result.card });
    if (saved) { open[character.id] = false; prompts[character.id] = ''; }
  } catch (caught) { errors[character.id] = caught instanceof Error ? caught.message : "Couldn't write this card."; }
  finally { writing[character.id] = false; }
}
function openChange(character: Character) {
  changeCards[character.id] = approvedCard(character); changeDescriptions[character.id] = ''; changeRevisions[character.id] = character.cardRevision;
  errors[character.id] = ''; confirming.value = ''; changing[character.id] = true;
}
function closeChange(character: Character) { changing[character.id] = false; errors[character.id] = ''; }
async function saveChange(character: Character) {
  if (changeSaving[character.id]) return;
  const source = changeCards[character.id];
  if (!source) return;
  errors[character.id] = '';
  const parsed = CharacterCardDefinitionSchema.safeParse(withDescription({ ...source, possessions: source.possessions.map(value => value?.trim() ?? '').filter(Boolean) }, changeDescriptions[character.id] ?? ''));
  if (!parsed.success) { errors[character.id] = cardSaveMessage(parsed.error.issues); return; }
  changeSaving[character.id] = true;
  try {
    const saved = await queueSave(character.id, { type: 'save_character', commandId: crypto.randomUUID(), characterId: character.id, expectedCharacterRevision: changeRevisions[character.id], card: parsed.data });
    if (saved) closeChange(character);
  } finally { changeSaving[character.id] = false; }
}
const liveOpen = reactive<Record<string, boolean>>({});
const liveLook = reactive<Record<string, string>>({});
const liveItems = reactive<Record<string, string[]>>({});
const liveChanged = reactive<Record<string, string>>({});
type CardListKey = 'wearing' | 'owes' | 'feelings';
const cardLists: { key: CardListKey; legend: string; add: string; max: number; help: (name: string) => string }[] = [
  { key: 'wearing', legend: 'Wearing', add: 'Add something worn', max: WEARING_MAX, help: name => `Something ${name} wears now. Outcomes you approve can put things on or take them off.` },
  { key: 'owes', legend: 'Promises and debts', add: 'Add a promise or debt', max: OWES_MAX, help: name => `A promise or debt ${name} owes or is owed. Outcomes you approve can add or settle it.` },
  { key: 'feelings', legend: 'How people feel', add: 'Add a feeling', max: FEELINGS_MAX, help: name => `How someone feels about ${name}. Outcomes you approve can change it.` },
];
const liveLists = reactive<Record<string, Record<CardListKey, string[]>>>({});
const liveRevisions = reactive<Record<string, number>>({});
const liveSaving = reactive<Record<string, boolean>>({});
interface LiveSnapshot { look: string; items: string[]; changed: string; wearing: string[]; owes: string[]; feelings: string[] }
const liveLoaded: Record<string, LiveSnapshot> = {};
const maxLiveItems = 20;
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
function loadLive(character: Character) {
  const lists = { wearing: [...(character.wearing ?? [])], owes: [...(character.owes ?? [])], feelings: [...(character.feelings ?? [])] };
  liveLook[character.id] = character.appearance; liveItems[character.id] = [...character.possessions]; liveRevisions[character.id] = character.cardRevision;
  liveChanged[character.id] = character.looksChanged ?? '';
  liveLists[character.id] = { wearing: [...lists.wearing], owes: [...lists.owes], feelings: [...lists.feelings] };
  liveLoaded[character.id] = { look: character.appearance, items: [...character.possessions], changed: character.looksChanged ?? '', ...lists };
}
function openLive(character: Character) {
  loadLive(character);
  errors[character.id] = ''; liveOpen[character.id] = true;
}
function liveUntouched(id: string) {
  const loaded = liveLoaded[id];
  if (!loaded) return false;
  const items = (liveItems[id] ?? []).filter(item => item.trim());
  const lists = liveLists[id];
  return liveLook[id] === loaded.look && (liveChanged[id] ?? '') === loaded.changed && sameList(items, loaded.items)
    && cardLists.every(list => sameList((lists?.[list.key] ?? []).filter(entry => entry.trim()), loaded[list.key]));
}
watch(() => props.snapshot.characterDetails, details => {
  for (const character of details) {
    if (!liveOpen[character.id] || liveSaving[character.id]) continue;
    if (character.cardRevision === liveRevisions[character.id]) continue;
    if (liveUntouched(character.id)) { loadLive(character); errors[character.id] = ''; }
  }
}, { deep: true });
function closeLive(character: Character) { liveOpen[character.id] = false; errors[character.id] = ''; }
function addLiveItem(character: Character) {
  const items = liveItems[character.id];
  if (items && items.length < maxLiveItems) items.push('');
}
function removeLiveItem(character: Character, index: number) { liveItems[character.id]?.splice(index, 1); }
function addLiveEntry(character: Character, key: CardListKey) {
  const entries = liveLists[character.id]?.[key];
  const max = cardLists.find(list => list.key === key)?.max ?? 0;
  if (entries && entries.length < max) entries.push('');
}
function removeLiveEntry(character: Character, key: CardListKey, index: number) { liveLists[character.id]?.[key].splice(index, 1); }
const cleaned = (values: string[] | undefined) => (values ?? []).map(value => value.trim()).filter(Boolean);
async function saveLive(character: Character) {
  if (liveSaving[character.id]) return;
  errors[character.id] = '';
  const lists = liveLists[character.id];
  const command = CommandSchema.safeParse({ type: 'save_live_character', commandId: crypto.randomUUID(), characterId: character.id, expectedCharacterRevision: liveRevisions[character.id], appearance: liveLook[character.id] ?? '', possessions: cleaned(liveItems[character.id]), wearing: cleaned(lists?.wearing), owes: cleaned(lists?.owes), feelings: cleaned(lists?.feelings), looksChanged: (liveChanged[character.id] ?? '').trim() });
  if (!command.success) { errors[character.id] = 'The look or one of the entries is too long. Shorten it and try again.'; return; }
  liveSaving[character.id] = true;
  try {
    if (await queueSave(character.id, command.data)) closeLive(character);
  } finally { liveSaving[character.id] = false; }
}
function useDraft(character: Character) {
  if (isSaving(character.id)) return;
  errors[character.id] = '';
  void queueSave(character.id, { type: 'approve_character', commandId: crypto.randomUUID(), characterId: character.id, expectedCharacterRevision: character.cardRevision });
}
function askRemove(character: Character) { confirming.value = character.id; open[character.id] = false; }
function removeSeat(character: Character) {
  confirming.value = '';
  emit('command', { type: 'remove_seat', commandId: crypto.randomUUID(), characterId: character.id, expectedStateRevision: props.snapshot.session.stateRevision });
}
</script>

<template>
  <div class="cast-seats">
    <article v-for="character in snapshot.characterDetails" :key="character.id" class="seat-line" :data-testid="`seat-line-${character.id}`">
      <div class="seat-head">
        <PictureAvatar :name="character.displayName" :src="portrait(character)" />
        <strong>{{ character.displayName }}</strong>
        <span v-if="character.condition" class="condition-badge" :data-testid="`cast-condition-${character.id}`">{{ character.condition === 'dead' ? 'Dead' : 'Down' }}</span>
        <a class="seat-test" :href="testSeatUrl(character)" target="_blank" rel="noopener">Test as {{ character.displayName }} <span class="glyph-new-tab" aria-hidden="true"></span></a>
      </div>
      <details v-if="shownCard(character)" class="seat-card">
        <summary>Read card</summary>
        <dl>
          <template v-for="field in cardFields" :key="field">
            <dt>{{ fieldLabel(field) }}</dt><dd>{{ shownCard(character)![field] || '—' }}</dd>
          </template>
          <dt>Traits</dt><dd><span v-for="(value, trait) in shownCard(character)!.traits" :key="trait">{{ trait }} +{{ value }} &nbsp;</span></dd>
          <dt>Possessions</dt><dd>{{ shownCard(character)!.possessions.join(', ') || '—' }}</dd>
          <template v-if="character.looksChanged"><dt>Changed by the story</dt><dd>{{ character.looksChanged }}</dd></template>
          <template v-for="list in cardLists" :key="list.key">
            <template v-if="character[list.key]?.length"><dt>{{ list.legend }}</dt><dd>{{ character[list.key]!.join(list.key === 'wearing' ? ', ' : '; ') }}</dd></template>
          </template>
        </dl>
        <template v-if="hasCard(character) && editable">
          <button v-if="!changing[character.id]" type="button" class="secondary" :data-testid="`change-card-${character.id}`" @click="openChange(character)">Change this card</button>
          <div v-else class="seat-change">
            <CharacterForm v-model="changeCards[character.id]" v-model:description="changeDescriptions[character.id]" generation-enabled :generation-context="`${character.id}:${changeRevisions[character.id]}`" :premise="premise" premise-label="Story premise" :generate-card="input => generateChangedCard(character.id, input)" :card-generation-note="premise ? 'The story\'s premise is sent too.' : undefined" />
            <div class="seat-actions">
              <button type="button" :disabled="changeSaving[character.id] || isSaving(character.id)" :data-testid="`change-card-save-${character.id}`" @click="saveChange(character)">Save this card</button>
              <button type="button" class="secondary" :disabled="isSaving(character.id)" :data-testid="`change-card-cancel-${character.id}`" @click="closeChange(character)">Cancel</button>
            </div>
          </div>
        </template>
      </details>
      <div v-if="hasCard(character) && liveEditable" class="seat-live">
        <button v-if="!liveOpen[character.id]" type="button" class="secondary" :data-testid="`edit-look-${character.id}`" @click="openLive(character)">Edit look and items</button>
        <div v-else class="seat-live-form">
          <label :for="fieldId(`look-${character.id}`)">Look</label>
          <textarea :id="fieldId(`look-${character.id}`)" v-model="liveLook[character.id]" rows="3" maxlength="1000" :data-testid="`live-look-${character.id}`"></textarea>
          <label :for="fieldId(`changed-${character.id}`)">Changed by the story</label>
          <textarea :id="fieldId(`changed-${character.id}`)" v-model="liveChanged[character.id]" rows="2" :maxlength="LOOKS_CHANGED_MAX" :aria-describedby="fieldId(`changed-help-${character.id}`)" :data-testid="`live-looks-${character.id}`"></textarea>
          <p :id="fieldId(`changed-help-${character.id}`)" class="field-help">{{ `How the story changed ${character.displayName}'s look, such as torn or soaked clothes. The AI and pictures read it after the look.` }}</p>
          <fieldset class="seat-items">
            <legend>Carrying</legend>
            <div v-for="(_, index) in liveItems[character.id]" :key="index" class="seat-item">
              <input v-model="liveItems[character.id]![index]" type="text" maxlength="160" :aria-label="`Item ${index + 1} for ${character.displayName}`" :data-testid="`live-item-${character.id}-${index}`" />
              <button type="button" class="secondary" :aria-label="`Remove item ${index + 1} for ${character.displayName}`" :data-testid="`live-item-remove-${character.id}-${index}`" @click="removeLiveItem(character, index)">Remove</button>
            </div>
            <button type="button" class="secondary" :disabled="(liveItems[character.id]?.length ?? 0) >= maxLiveItems" :data-testid="`live-item-add-${character.id}`" @click="addLiveItem(character)">Add an item</button>
          </fieldset>
          <fieldset v-for="list in cardLists" :key="list.key" class="seat-items">
            <legend>{{ list.legend }}</legend>
            <div v-for="(_, index) in liveLists[character.id]?.[list.key]" :key="index" class="seat-item">
              <input v-model="liveLists[character.id]![list.key][index]" type="text" :maxlength="CARD_ENTRY_MAX" :aria-label="`${list.legend} ${index + 1} for ${character.displayName}`" :aria-describedby="fieldId(`${list.key}-help-${character.id}-${index}`)" :data-testid="`live-${list.key}-${character.id}-${index}`" />
              <button type="button" class="secondary" :aria-label="`Remove ${list.legend} ${index + 1} for ${character.displayName}`" :data-testid="`live-${list.key}-remove-${character.id}-${index}`" @click="removeLiveEntry(character, list.key, index)">Remove</button>
              <p :id="fieldId(`${list.key}-help-${character.id}-${index}`)" class="field-help">{{ list.help(character.displayName) }}</p>
            </div>
            <button type="button" class="secondary" :disabled="(liveLists[character.id]?.[list.key].length ?? 0) >= list.max" :data-testid="`live-${list.key}-add-${character.id}`" @click="addLiveEntry(character, list.key)">{{ list.add }}</button>
          </fieldset>
          <p class="muted">The AI and pictures use this from the next plan or script. If the stakes are already showing, press Plan again to use it.</p>
          <p v-if="errors[character.id]" role="alert" class="notice error" :data-testid="`live-edit-error-${character.id}`">{{ errors[character.id] }}</p>
          <div class="seat-actions">
            <button type="button" :disabled="liveSaving[character.id] || isSaving(character.id)" :data-testid="`live-edit-save-${character.id}`" @click="saveLive(character)">Save look and items</button>
            <button type="button" class="secondary" :disabled="liveSaving[character.id]" :data-testid="`live-edit-cancel-${character.id}`" @click="closeLive(character)">Cancel</button>
          </div>
        </div>
      </div>
      <p v-if="hasCard(character) && editable && errors[character.id]" role="alert" class="notice error" :data-testid="`seat-error-${character.id}`">{{ errors[character.id] }}</p>
      <template v-if="!hasCard(character)">
        <p v-if="character.draft" class="muted" :data-testid="`card-waiting-${character.id}`">Card waiting to be used</p>
        <p v-else class="muted" :data-testid="`waiting-for-card-${character.id}`">Waiting for this player's card</p>
        <div v-if="editable" class="seat-actions">
          <button v-if="character.draft" type="button" :disabled="busy || isSaving(character.id)" :data-testid="`use-card-${character.id}`" @click="useDraft(character)">Use this card</button>
          <button v-if="!open[character.id]" type="button" class="secondary" :disabled="busy || isSaving(character.id)" :data-testid="`write-card-for-${character.id}`" @click="openWriter(character)">Write this card for them</button>
          <button v-if="canRemove && confirming !== character.id" type="button" class="quiet" :disabled="busy || isSaving(character.id)" :data-testid="`remove-seat-${character.id}`" @click="askRemove(character)">Start without this seat</button>
        </div>
        <div v-if="editable && open[character.id]" class="seat-writer">
          <label :for="fieldId(`write-${character.id}`)">Describe this character in one sentence</label>
          <textarea :id="fieldId(`write-${character.id}`)" v-model="prompts[character.id]" rows="2" maxlength="4000" :disabled="writing[character.id]" :data-testid="`write-card-input-${character.id}`"></textarea>
          <div class="seat-actions">
            <button type="button" :disabled="busy || isSaving(character.id) || writing[character.id] || !(prompts[character.id] ?? '').trim()" :data-testid="`write-card-submit-${character.id}`" @click="writeCard(character)">{{ writing[character.id] ? 'Writing this card…' : 'Write the card' }}</button>
          </div>
        </div>
        <p v-if="editable && errors[character.id]" role="alert" class="notice error" :data-testid="`seat-error-${character.id}`">{{ errors[character.id] }}</p>
        <div v-if="editable && confirming === character.id" class="seat-confirm" role="group" :aria-label="`Remove ${character.displayName}`">
          <p>Remove this seat? Its invitation stops working.</p>
          <div class="seat-actions">
            <button type="button" :disabled="busy" :data-testid="`remove-seat-confirm-${character.id}`" @click="removeSeat(character)">Remove seat</button>
            <button type="button" class="secondary" @click="confirming = ''">Keep seat</button>
          </div>
        </div>
      </template>
    </article>
  </div>
</template>

<style scoped>
.condition-badge { font-family: var(--font-label); border: 2px solid currentColor; padding: 0 6px; white-space: nowrap; }
.cast-seats { display: grid; }
.seat-line { padding: 16px 0; border-bottom: 2px solid var(--night-raised); display: grid; gap: 8px; }
.seat-line:last-child { border-bottom: 0; }
.seat-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.seat-test { margin-left: auto; font-size: 20px; line-height: 24px; color: var(--candle); }
.seat-line p { margin: 0; }
.seat-card dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 4fr); gap: 8px 20px; }
.seat-card dt { color: var(--dust); text-transform: capitalize; }
.seat-card dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.seat-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.seat-change { display: grid; gap: 12px; margin-top: 12px; }
.seat-live, .seat-live-form { display: grid; gap: 8px; justify-items: start; }
.seat-live-form { width: 100%; justify-items: stretch; }
.seat-live-form textarea, .seat-item input { width: 100%; }
.seat-items { display: grid; gap: 8px; border: 0; padding: 0; margin: 0; min-width: 0; justify-items: start; }
.seat-item { display: flex; gap: 12px; align-items: center; width: 100%; flex-wrap: wrap; }
.seat-item input { flex: 1 1 200px; min-width: 0; width: auto; }
.seat-item .field-help { flex: 1 0 100%; margin: 0; }
.seat-writer { display: grid; gap: 8px; }
.seat-writer textarea { width: 100%; }
</style>
