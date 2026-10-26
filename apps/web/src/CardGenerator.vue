<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { hasUsefulCharacterContext } from '@rpg/contracts';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';
import { characterFieldContext } from './field-context';

const props = defineProps<{
  card: CharacterCardDefinition;
  contextKey: string | number;
  disabled?: boolean;
  contextNote?: string;
  generate: (input: { prompt: string; keepFilled: boolean }) => Promise<CardGenerationResponse>;
}>();
const emit = defineEmits<{ apply: [response: CardGenerationResponse]; undo: [previous: CharacterCardDefinition] }>();

const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const cardJson = (value: CharacterCardDefinition) => JSON.stringify({ ...value, portraitId: undefined });
const STALE_MESSAGE = 'Your card changed while the AI was writing. Generate again.';
const CONTEXT_MESSAGE = 'Something on this page changed, so that draft was set aside. Press Generate again.';
const VALIDATION_MESSAGE = 'One of the boxes is longer than the form allows. Shorten it, then try again.';
const TRAIT_NAMES = { force: 'Force', finesse: 'Finesse', wits: 'Wits', presence: 'Presence' } as const;

const opened = ref(false);
const prompt = ref('');
const keep = ref(true);
const pending = ref(false);
const result = ref<CardGenerationResponse | null>(null);
const error = ref('');
const stale = ref(false);
const contextChanged = ref(false);
const undoPrevious = ref<CharacterCardDefinition | null>(null);
let undoJson: string | null = null;
let undoToken = 0;
let snapshot = '';
let generation = 0;
let disposed = false;

const hasContext = computed(() => hasUsefulCharacterContext(characterFieldContext(props.card)));
const canGenerate = computed(() => !props.disabled && !pending.value && prompt.value.trim().length > 0);
const promptHelp = computed(() => [
  'Say who this character is in a few words or a few sentences. The AI fills in every box and picks the traits.',
  "The card's current text, including the private secret, is sent to the AI. Other players' cards are not.",
  props.contextNote?.trim() ?? '',
].filter(Boolean).join(' '));

const traitLine = computed(() => {
  const card = result.value?.card;
  if (!card) return '';
  const entries = (Object.keys(TRAIT_NAMES) as (keyof typeof TRAIT_NAMES)[]).map(key => ({ key, value: card.traits[key] }));
  const best = entries.find(entry => entry.value === 2);
  const worst = entries.find(entry => entry.value === 0);
  if (!best || !worst) return '';
  return `Best at ${TRAIT_NAMES[best.key]} +2, weakest at ${TRAIT_NAMES[worst.key]} +0, the other two +1`;
});
const previewLines = computed(() => {
  const response = result.value;
  if (!response) return [];
  const { card } = response;
  const pronouns = !card.pronouns.trim() ? 'Pronouns: left blank'
    : response.pronounsSuggested ? `Pronouns (suggested): ${card.pronouns}` : `Pronouns: ${card.pronouns}`;
  const items = card.possessions.filter(value => value.trim());
  return [
    `Name: ${card.displayName}`, pronouns, `Look: ${card.appearance}`, `Personality: ${card.personality}`, traitLine.value,
    `Possessions: ${items.length ? items.join(', ') : 'none'}`, ...response.notes,
  ];
});

function invalidate() {
  generation++;
  pending.value = false; result.value = null; error.value = ''; stale.value = false; contextChanged.value = false;
}
function clearUndo() { undoToken++; undoPrevious.value = null; undoJson = null; }
function close() { invalidate(); opened.value = false; }
function open() {
  if (disposed || props.disabled || opened.value) return;
  invalidate(); keep.value = true; opened.value = true;
}
function isValidationFailure(cause: unknown) {
  return typeof cause === 'object' && cause !== null && Array.isArray((cause as { issues?: unknown }).issues);
}
async function requestCard() {
  if (!canGenerate.value) return;
  const requestGeneration = ++generation;
  snapshot = cardJson(props.card);
  pending.value = true; result.value = null; error.value = ''; stale.value = false; contextChanged.value = false;
  try {
    const response = await props.generate({ prompt: prompt.value.trim(), keepFilled: hasContext.value ? keep.value : false });
    if (requestGeneration !== generation || disposed || !opened.value) return;
    result.value = response;
  } catch (cause) {
    if (requestGeneration !== generation || disposed || !opened.value) return;
    error.value = isValidationFailure(cause) ? VALIDATION_MESSAGE
      : cause instanceof Error && cause.message ? cause.message : 'Drafting is unavailable. Try again.';
  } finally {
    if (requestGeneration === generation && !disposed) pending.value = false;
  }
}
async function useCharacter() {
  const response = result.value;
  if (!response || pending.value || props.disabled || !opened.value) return;
  if (cardJson(props.card) !== snapshot) {
    result.value = null; stale.value = true;
    return;
  }
  const previous = JSON.parse(snapshot) as CharacterCardDefinition;
  close(); prompt.value = '';
  const token = ++undoToken;
  undoPrevious.value = previous; undoJson = null;
  emit('apply', response);
  await nextTick();
  if (undoToken === token && undoPrevious.value && !disposed) undoJson = cardJson(props.card);
}
function undo() {
  const previous = undoPrevious.value;
  if (!previous || props.disabled) return;
  clearUndo();
  emit('undo', previous);
}

watch(() => props.contextKey, () => {
  const active = opened.value && (pending.value || result.value !== null);
  clearUndo(); invalidate();
  if (active) contextChanged.value = true;
}, { flush: 'sync' });
watch(() => props.card, () => {
  if (undoJson !== null && cardJson(props.card) !== undoJson) clearUndo();
}, { deep: true, flush: 'sync' });
onBeforeUnmount(() => { disposed = true; invalidate(); });
</script>

<template>
  <div class="card-generator">
    <div class="card-generator-bar">
      <button type="button" data-testid="card-generator-open" class="secondary" :aria-expanded="opened" :disabled="disabled || opened" @click="open">Create the whole card with AI</button>
      <button v-if="undoPrevious" type="button" data-testid="card-generator-undo" class="quiet" :disabled="disabled" @click="undo">Undo</button>
    </div>
    <section v-if="opened" class="card-generator-box" aria-label="Create the whole card" :aria-busy="pending">
      <label>Describe your character
        <textarea v-model="prompt" data-testid="card-generator-prompt" :aria-describedby="helpId('prompt')" maxlength="4000" rows="4" />
      </label>
      <p :id="helpId('prompt')" class="field-help">{{ promptHelp }}</p>
      <template v-if="hasContext">
        <label class="card-generator-keep"><input v-model="keep" type="checkbox" data-testid="card-generator-keep" :aria-describedby="helpId('keep')"> Keep what I've already written</label>
        <p :id="helpId('keep')" class="field-help">Leave this on to keep every box you already filled in. The AI writes only the empty ones. It always picks the four traits again.</p>
      </template>
      <p v-if="stale" class="notice error" role="alert">{{ STALE_MESSAGE }}</p>
      <p v-if="contextChanged" class="notice" role="alert">{{ CONTEXT_MESSAGE }}</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div v-if="result" class="card-generator-result">
        <strong>Preview</strong>
        <ul data-testid="card-generator-preview" class="card-generator-lines" role="status">
          <li v-for="(line, index) in previewLines" :key="index">{{ line }}</li>
        </ul>
      </div>
      <div class="card-generator-actions">
        <button type="button" data-testid="card-generator-generate" class="secondary" :disabled="!canGenerate" @click="requestCard">{{ pending ? 'Writing…' : error ? 'Try again' : 'Generate' }}</button>
        <button v-if="result" type="button" data-testid="card-generator-apply" :disabled="disabled || pending" @click="useCharacter">Use this character</button>
        <button type="button" data-testid="card-generator-cancel" class="quiet" :disabled="disabled" @click="close">Cancel</button>
      </div>
      <p class="card-generator-footer">Use this character fills in the form. Nothing is saved or sent until you press your usual save or submit button.</p>
    </section>
  </div>
</template>

<style scoped>
.card-generator { margin-bottom: 1rem; }
.card-generator-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
.card-generator-box { margin-top: .6rem; padding: 1rem; border: 1px solid var(--line); border-left: 3px solid var(--teal); border-radius: 8px; background: var(--panel); max-width: 100%; box-sizing: border-box; }
.card-generator-box label { display: grid; gap: .45rem; }
.card-generator-box label.card-generator-keep { display: flex; align-items: center; gap: .5rem; }
.card-generator-box textarea { min-height: 96px; width: 100%; box-sizing: border-box; }
.card-generator-result strong { font-size: .8rem; color: var(--teal); }
.card-generator-lines { list-style: none; margin: .4rem 0 0; padding: .7rem; border: 1px solid var(--line); border-radius: 5px; display: grid; gap: .3rem; font-size: .88rem; overflow-wrap: anywhere; }
.card-generator-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem; }
.card-generator-footer { color: var(--muted); font-size: .75rem; margin: .8rem 0 0; }
</style>
