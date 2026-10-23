<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { FIELD_GENERATION_FIELDS, FieldGenerationRequestSchema, MAX_FIELD_GENERATION_REQUEST_BYTES, allowsPremise } from '@rpg/contracts';
import type { FieldGenerationCharacterContext, FieldGenerationField, FieldGenerationRequest, FieldGenerationResponse } from '@rpg/contracts';
import { api } from './api';

const props = defineProps<{ field: FieldGenerationField; modelValue: string; contextKey: string | number; disabled?: boolean; premise?: string; premiseLabel?: string; characterContext?: FieldGenerationCharacterContext; instructions?: string; generate?: (request: FieldGenerationRequest) => Promise<FieldGenerationResponse> }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const spec = computed(() => FIELD_GENERATION_FIELDS[props.field]);
const opened = ref(false);
const seed = ref('');
const hint = ref('');
const source = ref<'description' | 'premise'>('description');
const hasPremiseChoice = computed(() => allowsPremise(props.field) && (props.premise !== undefined || source.value === 'premise'));
const premiseAvailable = computed(() => hasPremiseChoice.value && !!props.premise?.trim() && props.premise.trim().length <= 4000);
const premiseName = computed(() => props.premiseLabel || 'Scenario premise');
const usedSeed = computed(() => source.value === 'premise' ? hint.value : seed.value);
const pending = ref(false);
const preview = ref<string | null>(null);
const error = ref('');
const instructions = computed(() => props.instructions?.trim() ?? '');
const requestInput = computed(() => ({
  field: props.field,
  seed: usedSeed.value,
  ...(source.value === 'premise' ? { premise: props.premise } : {}),
  ...(props.characterContext !== undefined ? { characterContext: props.characterContext } : {}),
  ...(instructions.value ? { instructions: instructions.value } : {}),
}));
const validatedRequest = computed(() => FieldGenerationRequestSchema.safeParse(requestInput.value));
const requestSizeError = computed(() => validatedRequest.value.success && new TextEncoder().encode(JSON.stringify(requestInput.value)).byteLength > MAX_FIELD_GENERATION_REQUEST_BYTES
  ? 'The drafting request is too large. Shorten the description or character notes.' : '');
const contextError = computed(() => {
  const parsed = validatedRequest.value;
  if (parsed.success || props.characterContext === undefined) return '';
  const issue = parsed.error.issues.find(issue => issue.path[0] === 'characterContext');
  return issue ? `Character context cannot be used: ${issue.message}` : '';
});
const instructionsError = computed(() => {
  const parsed = validatedRequest.value;
  if (parsed.success) return '';
  const issue = parsed.error.issues.find(issue => issue.path[0] === 'instructions');
  return issue ? `Character instructions cannot be used: ${issue.message}` : '';
});
const characterName = computed(() => typeof props.characterContext?.displayName === 'string' && props.characterContext.displayName.trim()
  ? props.characterContext.displayName.trim() : 'this character');
const contextHelp = computed(() => `Uses entered fields for ${characterName.value}, including private notes. Other characters are not included.`);
const canGenerate = computed(() => !props.disabled && !pending.value && validatedRequest.value.success && !requestSizeError.value
  && (source.value !== 'premise' || premiseAvailable.value));
let generation = 0;
let previewGeneration = -1;
let disposed = false;
let target: { field: FieldGenerationField; modelValue: string; contextKey: string | number } | null = null;

function matchesTarget() {
  return !disposed && opened.value && !props.disabled && target?.field === props.field && target.modelValue === props.modelValue && target.contextKey === props.contextKey;
}
function invalidate() {
  generation++; previewGeneration = -1;
  pending.value = false; preview.value = null; error.value = '';
}
function close() {
  invalidate(); target = null; opened.value = false;
}
function open() {
  if (disposed || props.disabled || opened.value) return;
  close();
  target = { field: props.field, modelValue: props.modelValue, contextKey: props.contextKey };
  seed.value = props.modelValue; hint.value = ''; source.value = 'description'; opened.value = true;
}
async function requestDraft() {
  if (!canGenerate.value || !matchesTarget()) return;
  const parsed = validatedRequest.value;
  if (!parsed.success) return;
  // Parsing clones nested authored context before any later form edits.
  const request = { ...parsed.data, seed: usedSeed.value, ...(source.value === 'premise' ? { premise: props.premise } : {}) };
  const requestGeneration = ++generation;
  pending.value = true; preview.value = null; previewGeneration = -1; error.value = '';
  try {
    const result = await (props.generate ?? api.generateField)(request);
    if (requestGeneration !== generation || !matchesTarget()) return;
    preview.value = result.text; previewGeneration = requestGeneration;
  } catch (cause) {
    if (requestGeneration !== generation || !matchesTarget()) return;
    error.value = cause instanceof Error ? cause.message : 'Drafting is unavailable. Try again.';
  } finally {
    if (requestGeneration === generation && matchesTarget()) pending.value = false;
  }
}
function apply() {
  if (!matchesTarget() || pending.value || preview.value === null || previewGeneration !== generation) return;
  const value = preview.value;
  close();
  emit('update:modelValue', value);
}

watch([() => props.field, () => props.modelValue, () => props.contextKey, () => props.disabled], close, { flush: 'sync' });
watch([source, usedSeed, () => props.premise, () => props.premiseLabel, () => props.instructions, () => props.generate], invalidate, { flush: 'sync' });
watch(() => props.characterContext, invalidate, { deep: true, flush: 'sync' });
onBeforeUnmount(() => { disposed = true; close(); });
</script>

<template>
  <div class="field-generator">
    <button type="button" data-testid="field-generator-open" class="secondary generate-open" :aria-label="`AI Generate ${spec.label}`" :aria-expanded="opened" :disabled="disabled || opened" @click="open">AI Generate</button>
    <section v-if="opened" class="generator-panel" :class="{ 'source-panel': hasPremiseChoice || characterContext !== undefined || instructions }" :aria-label="`Draft ${spec.label}`" :aria-busy="pending">
      <template v-if="hasPremiseChoice">
        <label>Draft from
          <select v-model="source" data-testid="field-generator-source" :aria-label="`Source for ${spec.label}`" :aria-describedby="helpId('source')">
            <option value="description">My description</option>
            <option value="premise" :disabled="!premiseAvailable">Scenario premise</option>
          </select>
        </label>
        <p :id="helpId('source')" class="generator-help">Choose your own description, or use the displayed premise with optional direction.<span v-if="!premiseAvailable"> This option needs a scenario premise of 1–4,000 characters.</span></p>
      </template>
      <template v-if="source === 'premise'">
        <label>{{ premiseName }}
          <textarea data-testid="field-generator-premise" :value="premise" :aria-label="`Premise from ${premiseName}`" :aria-describedby="helpId('premise')" readonly rows="5" />
        </label>
        <p :id="helpId('premise')" class="generator-help">The exact scenario premise sent to the AI for this draft. This preview does not edit the scenario.</p>
        <label>Additional description (optional)
          <textarea v-model="hint" data-testid="field-generator-hint" :aria-label="`Optional description for ${spec.label}`" :aria-describedby="[helpId('hint'), ...(instructions ? [helpId('instructions')] : [])].join(' ')" maxlength="12000" rows="3" />
        </label>
        <p :id="helpId('hint')" class="generator-help">Add direction for this field, or leave it blank to use the premise. This scenario premise and optional description are sent.<span v-if="characterContext">{{ ' ' + contextHelp }}</span></p>
      </template>
      <template v-else>
        <label>Describe {{ spec.label.toLowerCase() }}
          <textarea v-model="seed" data-testid="field-generator-seed" :aria-label="`Description for ${spec.label}`" :aria-describedby="[helpId('seed'), ...(instructions ? [helpId('instructions')] : [])].join(' ')" maxlength="12000" rows="3" />
        </label>
        <p :id="helpId('seed')" class="generator-help">Give the AI a short brief to expand for this field.<span v-if="characterContext">{{ ' ' + contextHelp }}<template v-if="allowsPremise(field)"> You may leave the description blank when entered fields provide context.</template><template v-else> An explicit description is required for this field.</template></span><span v-else-if="!instructions"> Only this description is sent.</span></p>
      </template>
      <p v-if="instructions" :id="helpId('instructions')" class="generator-help">Director’s character instructions are also sent to the AI for this draft.<template v-if="allowsPremise(field)"> You may leave the description blank to use them.</template><template v-else> An explicit description is still required for this field.</template></p>
      <p class="generator-help">Review the result before applying it. Apply replaces the unsaved field; save or publish separately.</p>
      <p v-if="contextError || instructionsError || requestSizeError || error" class="notice error" role="alert">{{ contextError || instructionsError || requestSizeError || error }}</p>
      <div v-if="preview !== null" class="generator-result">
        <strong>Preview</strong>
        <div data-testid="field-generator-preview" class="generator-preview" :aria-label="`Generated preview for ${spec.label}`" role="status">{{ preview }}</div>
      </div>
      <div class="generator-actions">
        <button type="button" data-testid="field-generator-generate" class="secondary" :aria-label="`${error ? 'Retry' : 'Generate'} ${spec.label}`" :disabled="!canGenerate" @click="requestDraft">{{ pending ? 'Generating…' : error ? 'Retry' : 'Generate' }}</button>
        <button v-if="preview !== null" type="button" data-testid="field-generator-apply" :aria-label="`Apply generated ${spec.label}`" :disabled="disabled || pending" @click="apply">Apply</button>
        <button type="button" data-testid="field-generator-cancel" class="quiet" :aria-label="`Cancel generation for ${spec.label}`" @click="close">Cancel</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.field-generator { position: relative; }
.generate-open { min-height: 28px; padding: .2rem .55rem; font-size: .72rem; white-space: nowrap; }
.generator-panel { position: absolute; top: calc(100% + .4rem); right: 0; z-index: 20; width: min(26rem, calc(100vw - 3rem)); max-height: 70vh; overflow-y: auto; padding: 1rem; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 8px 28px #0008; }
.generator-panel.source-panel { position: fixed; top: 50%; left: 50%; right: auto; transform: translate(-50%, -50%); max-height: calc(100dvh - 2rem); }
.generator-panel label { display: grid; gap: .45rem; margin-bottom: .6rem; }
.generator-panel textarea { min-height: 90px; }
.generator-help { font-size: .75rem; color: var(--muted); margin: .6rem 0; }
.generator-result { margin: .8rem 0; }
.generator-result strong { font-size: .8rem; }
.generator-preview { white-space: pre-wrap; overflow-wrap: anywhere; padding: .7rem; margin-top: .4rem; border: 1px solid var(--line); border-radius: 5px; font-size: .88rem; }
.generator-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem; }
.generator-actions button { padding: .5rem .75rem; }
@media (max-width: 800px) {
  .generator-panel { position: fixed; top: 50%; left: 50%; right: auto; transform: translate(-50%, -50%); width: min(26rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); }
}
</style>
