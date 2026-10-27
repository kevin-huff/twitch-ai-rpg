<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';

const props = defineProps<{
  card: CharacterCardDefinition;
  prompt: string;
  contextKey: string | number;
  disabled?: boolean;
  contextNote?: string;
  generate: (input: { prompt: string; keepFilled: boolean }) => Promise<CardGenerationResponse>;
}>();
const emit = defineEmits<{ apply: [response: CardGenerationResponse]; undo: [previous: CharacterCardDefinition] }>();

const helpId = `${useId()}-help`;
const cardJson = (value: CharacterCardDefinition) => JSON.stringify({ ...value, portraitId: undefined });
const STALE_MESSAGE = 'Your card changed while the AI was writing. Press Write my card again.';
const CONTEXT_MESSAGE = 'Something on this page changed, so that draft was set aside. Press Write my card again.';
const VALIDATION_MESSAGE = 'One of the boxes is longer than the form allows. Shorten it, then try again.';
const HELP_LINE = "The AI writes the rest of the card from your description and keeps a name you typed. Other players' cards are not sent.";

const pending = ref(false);
const error = ref('');
const stale = ref(false);
const contextChanged = ref(false);
const applied = ref<CardGenerationResponse | null>(null);
const undoPrevious = ref<CharacterCardDefinition | null>(null);
let undoJson: string | null = null;
let undoToken = 0;
let generation = 0;
let disposed = false;

const canWrite = computed(() => !props.disabled && !pending.value && props.prompt.trim().length > 0);
const help = computed(() => [HELP_LINE, props.contextNote?.trim() ?? ''].filter(Boolean).join(' '));
const summary = computed(() => {
  const card = applied.value?.card;
  if (!card) return [];
  return [
    { label: 'Name', value: card.displayName },
    { label: 'Appearance', value: card.appearance },
    { label: 'Personality', value: card.personality },
  ];
});

function clearUndo() { undoToken++; undoPrevious.value = null; applied.value = null; undoJson = null; }
function isValidationFailure(cause: unknown) {
  return typeof cause === 'object' && cause !== null && Array.isArray((cause as { issues?: unknown }).issues);
}
async function write() {
  if (!canWrite.value) return;
  const requestGeneration = ++generation;
  const snapshot = cardJson(props.card);
  clearUndo();
  pending.value = true; error.value = ''; stale.value = false; contextChanged.value = false;
  try {
    const response = await props.generate({ prompt: props.prompt.trim(), keepFilled: true });
    if (requestGeneration !== generation || disposed) return;
    if (cardJson(props.card) !== snapshot) { stale.value = true; return; }
    const token = ++undoToken;
    undoPrevious.value = JSON.parse(snapshot) as CharacterCardDefinition;
    applied.value = response;
    emit('apply', response);
    await nextTick();
    if (undoToken === token && undoPrevious.value && !disposed) undoJson = cardJson(props.card);
  } catch (cause) {
    if (requestGeneration !== generation || disposed) return;
    error.value = isValidationFailure(cause) ? VALIDATION_MESSAGE
      : cause instanceof Error && cause.message ? cause.message : 'Drafting is unavailable. Try again.';
  } finally {
    if (requestGeneration === generation && !disposed) pending.value = false;
  }
}
function undo() {
  const previous = undoPrevious.value;
  if (!previous || props.disabled) return;
  clearUndo();
  emit('undo', previous);
}

watch(() => props.contextKey, () => {
  const active = pending.value;
  generation++;
  clearUndo();
  pending.value = false; error.value = ''; stale.value = false; contextChanged.value = active;
}, { flush: 'sync' });
watch(() => props.card, () => {
  if (undoJson !== null && cardJson(props.card) !== undoJson) clearUndo();
}, { deep: true, flush: 'sync' });
onBeforeUnmount(() => { disposed = true; generation++; });
</script>

<template>
  <div class="card-generator">
    <div class="card-generator-bar">
      <button type="button" data-testid="write-card" class="secondary" :aria-describedby="helpId" :aria-busy="pending" :disabled="!canWrite" @click="write">{{ pending ? 'Writing…' : error ? 'Try again' : 'Write my card' }}</button>
    </div>
    <p :id="helpId" class="field-help">{{ help }}</p>
    <p v-if="stale" class="notice error" role="alert">{{ STALE_MESSAGE }}</p>
    <p v-if="contextChanged" class="notice" role="alert">{{ CONTEXT_MESSAGE }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div v-if="applied" class="card-generator-result" data-testid="card-summary" role="status">
      <p v-for="line in summary" :key="line.label" class="card-generator-line"><strong>{{ line.label }}:</strong> {{ line.value }}</p>
      <p v-if="applied.pronounsSuggested" class="field-help" data-testid="card-pronouns-note">The AI picked these pronouns. Change them if you like.</p>
      <button v-if="undoPrevious" type="button" data-testid="card-generator-undo" class="quiet" :disabled="disabled" @click="undo">Undo</button>
    </div>
  </div>
</template>

<style scoped>
.card-generator { margin-bottom: 1rem; }
.card-generator-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
.card-generator-result { margin-top: .6rem; padding: .7rem 1rem; border: 1px solid var(--line); border-left: 3px solid var(--teal); border-radius: 8px; background: var(--panel); max-width: 100%; box-sizing: border-box; display: grid; gap: .3rem; justify-items: start; }
.card-generator-line { margin: 0; font-size: .88rem; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
</style>
