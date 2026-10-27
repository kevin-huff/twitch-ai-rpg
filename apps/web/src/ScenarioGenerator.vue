<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { ScenarioDefinition, ScenarioDraftJob, ScenarioGenerationRequest, ScenarioSize } from '@rpg/contracts';

type Succeeded = Extract<ScenarioDraftJob, { status: 'succeeded' }>;
type Applied = { definition: ScenarioDefinition; adjustments: string[]; warnings: string[]; suggestedBoundaries: string[] };

const props = withDefaults(defineProps<{
  boundaries: string[];
  premise: string;
  disabled?: boolean;
  applyError?: string;
  replacesUnsaved: boolean;
  variant?: 'library' | 'make';
  start: (input: ScenarioGenerationRequest) => Promise<ScenarioDraftJob>;
  poll: (jobId: string) => Promise<ScenarioDraftJob>;
}>(), { variant: 'library' });
const emit = defineEmits<{ apply: [result: Applied]; discard: [] }>();

const POLL_MS = 2000;
const GIVE_UP_EXTRA_MS = 30_000;
const FALLBACK_GIVE_UP_MS = 390_000;
const TIMEOUT_MESSAGE = 'The AI took too long. Try again, or fill in the form yourself.';
const EXPIRED_MESSAGE = 'This draft is no longer on the server. Press Generate to try again.';
const RESUME_MESSAGE = 'Your earlier draft is still being written. It will appear here when it is ready.';
const VALIDATION_MESSAGE = 'One of your content boundaries is too long, or there are more than 30. Shorten or remove some, then try again.';
const STORAGE_KEY = 'rpg-scenario-draft-job';
const FALLBACK_ERROR = 'AI drafting is not available right now. You can still fill in the form yourself.';

const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;

const make = computed(() => props.variant === 'make');
const opened = ref(props.variant === 'make');
const prompt = ref('');
const size = ref<ScenarioSize>(props.variant === 'make' ? 'small' : 'medium');
const starting = ref(false);
const running = ref<Extract<ScenarioDraftJob, { status: 'running' }> | null>(null);
const result = ref<Succeeded | null>(null);
const error = ref('');
const expired = ref(false);
const resuming = ref(false);

let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
let giveUpExact = false;
let disposed = false;

const busy = computed(() => starting.value || resuming.value || running.value !== null);
const requestBoundaries = computed(() => props.boundaries.map(item => item.trim()).filter(Boolean));
const canGenerate = computed(() => !props.disabled && !busy.value && prompt.value.trim().length > 0);
const minutes = computed(() => {
  const job = running.value;
  if (!job) return 0;
  return Math.max(1, Math.ceil((Date.parse(job.deadlineAt) - Date.parse(job.startedAt)) / 60_000));
});
const applyLabel = computed(() => make.value ? 'Use this story' : props.replacesUnsaved ? 'Replace the editor with this draft' : 'Load into the editor');

const summary = computed(() => {
  const definition = result.value?.definition;
  if (!definition) return null;
  const names = (items: string[]) => items.filter(Boolean).join(', ');
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const privateFacts = definition.facts.filter(fact => fact.visibility !== 'public').length;
  return {
    title: definition.title,
    premise: definition.premise,
    places: `${count(definition.locations.length, 'place', 'places')}: ${names(definition.locations.map(item => item.title))}`,
    characters: definition.npcs.length ? `${count(definition.npcs.length, 'character', 'characters')}: ${names(definition.npcs.map(item => item.displayName))}` : 'No characters',
    tracks: definition.tracks.length ? `${count(definition.tracks.length, 'track', 'tracks')}: ${names(definition.tracks.map(item => item.label))}` : 'No tracks',
    facts: definition.facts.length
      ? `${count(definition.facts.length, 'fact', 'facts')}${privateFacts ? `, ${privateFacts} only the director sees` : ''}`
      : 'No facts',
  };
});

function rememberedId(): string {
  try { return window.sessionStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}
function rememberId(jobId: string) {
  try { window.sessionStorage.setItem(STORAGE_KEY, jobId); } catch { /* storage unavailable */ }
}
function forgetId() {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
function statusOf(cause: unknown) {
  return (cause as { status?: number } | null)?.status;
}
function isValidationError(cause: unknown) {
  return typeof cause === 'object' && cause !== null && Array.isArray((cause as { issues?: unknown }).issues);
}

function stopTimers() {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
  pollTimer = undefined; giveUpTimer = undefined; giveUpExact = false;
}
function reset() {
  generation++; stopTimers();
  starting.value = false; resuming.value = false; running.value = null; result.value = null; error.value = ''; expired.value = false;
}
function close() { if (result.value) forgetId(); reset(); if (!make.value) opened.value = false; emit('discard'); }
function open() {
  if (disposed || props.disabled || opened.value) return;
  reset();
  prompt.value = props.premise.trim().slice(0, 4000);
  size.value = 'medium';
  opened.value = true;
  const jobId = rememberedId();
  if (jobId) resume(generation, jobId);
}
function resume(token: number, jobId: string) {
  stopTimers();
  resuming.value = true;
  armGiveUpAfter(token, FALLBACK_GIVE_UP_MS);
  void pollOnce(token, jobId);
}
function armGiveUpAfter(token: number, ms: number) {
  if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
  giveUpTimer = setTimeout(() => {
    if (token !== generation || disposed) return;
    generation++; stopTimers(); forgetId();
    resuming.value = false; running.value = null; error.value = TIMEOUT_MESSAGE;
  }, ms);
}
function armGiveUp(token: number, job: Extract<ScenarioDraftJob, { status: 'running' }>) {
  const budget = Math.max(0, Date.parse(job.deadlineAt) - Date.parse(job.startedAt)) + GIVE_UP_EXTRA_MS;
  armGiveUpAfter(token, budget);
  giveUpExact = true;
}
function settle(job: ScenarioDraftJob) {
  stopTimers();
  resuming.value = false;
  running.value = null;
  if (job.status === 'succeeded') result.value = job;
  else if (job.status === 'failed') { forgetId(); error.value = job.message || FALLBACK_ERROR; }
}
function schedulePoll(token: number, jobId: string) {
  pollTimer = setTimeout(() => { void pollOnce(token, jobId); }, POLL_MS);
}
async function pollOnce(token: number, jobId: string) {
  pollTimer = undefined;
  try {
    const job = await props.poll(jobId);
    if (token !== generation || disposed) return;
    if (job.status === 'running') {
      running.value = job;
      if (!giveUpExact) armGiveUp(token, job);
      schedulePoll(token, jobId);
      return;
    }
    settle(job);
  } catch (cause) {
    if (token !== generation || disposed) return;
    if (statusOf(cause) === 404) {
      stopTimers(); forgetId(); resuming.value = false; running.value = null; expired.value = true;
      return;
    }
    schedulePoll(token, jobId);
  }
}
async function requestScenario() {
  if (!canGenerate.value) return;
  const token = ++generation;
  stopTimers();
  starting.value = true; result.value = null; error.value = ''; expired.value = false;
  try {
    const job = await props.start({ prompt: prompt.value.trim(), size: size.value, boundaries: requestBoundaries.value });
    if (token !== generation || disposed) {
      if (job.status !== 'failed') rememberId(job.jobId);
      return;
    }
    starting.value = false;
    if (job.status !== 'running') { settle(job); return; }
    running.value = job;
    rememberId(job.jobId);
    armGiveUp(token, job);
    schedulePoll(token, job.jobId);
  } catch (cause) {
    if (token !== generation || disposed) return;
    starting.value = false;
    const jobId = statusOf(cause) === 409 ? rememberedId() : '';
    if (jobId) { resume(token, jobId); return; }
    if (isValidationError(cause)) error.value = VALIDATION_MESSAGE;
    else error.value = cause instanceof Error && cause.message ? cause.message : FALLBACK_ERROR;
  }
}
function useDraft() {
  const job = result.value;
  if (!job || props.disabled) return;
  const payload: Applied = {
    definition: job.definition, adjustments: job.adjustments, warnings: job.warnings, suggestedBoundaries: job.suggestedBoundaries,
  };
  if (!make.value) close();
  emit('apply', payload);
}
defineExpose({ clearDraft: close });

onMounted(() => {
  if (!make.value) return;
  const jobId = rememberedId();
  if (jobId) resume(generation, jobId);
});
onBeforeUnmount(() => { disposed = true; reset(); });
</script>

<template>
  <div class="scenario-generator" :class="{ 'scenario-generator-make': make }">
    <button v-if="!make" type="button" data-testid="scenario-generator-open" class="secondary" :aria-expanded="opened" :disabled="disabled || opened" @click="open">Create the whole scenario with AI</button>
    <section v-if="opened" class="scenario-generator-panel" aria-label="Create the whole scenario" :aria-busy="busy">
      <label>{{ make ? "What's the story?" : 'Describe your story' }}
        <textarea v-model="prompt" data-testid="scenario-generator-prompt" :aria-describedby="helpId('prompt')" :disabled="busy" maxlength="4000" rows="5" />
      </label>
      <p :id="helpId('prompt')" class="field-help">Describe the story in a few sentences: where it happens, who is in it and what goes wrong.<template v-if="!make"> Your content boundaries are sent too, so the AI avoids what they rule out.</template></p>
      <component :is="make ? 'details' : 'div'" :class="{ 'scenario-generator-options': make }">
        <summary v-if="make">More options</summary>
        <label>Size
          <select v-model="size" data-testid="scenario-generator-size" :aria-describedby="helpId('size')" :disabled="busy">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <p :id="helpId('size')" class="field-help">Bigger stories take longer to write and fail more often. You can add more by hand later.</p>
      </component>
      <p v-if="resuming" data-testid="scenario-generator-resume" class="scenario-generator-status" role="status">{{ RESUME_MESSAGE }}</p>
      <p v-if="running" data-testid="scenario-generator-status" class="scenario-generator-status" role="status">The AI is writing your story. This can take up to {{ minutes }} minutes.</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <p v-if="expired" class="notice error" role="alert">{{ EXPIRED_MESSAGE }}</p>
      <div v-if="summary" data-testid="scenario-generator-preview" class="scenario-generator-preview" role="status">
        <strong class="scenario-generator-title">{{ summary.title }}</strong>
        <p v-if="summary.premise" class="scenario-generator-premise">{{ summary.premise }}</p>
        <h4>Places</h4>
        <p>{{ summary.places }}</p>
        <h4>Characters</h4>
        <p>{{ summary.characters }}</p>
        <template v-if="!make">
          <h4>Tracks</h4>
          <p>{{ summary.tracks }}</p>
          <h4>Facts</h4>
          <p>{{ summary.facts }}</p>
        </template>
        <template v-if="result && result.suggestedBoundaries.length">
          <h4>Suggested boundaries</h4>
          <ul><li v-for="(item, index) in result.suggestedBoundaries" :key="index">{{ item }}</li></ul>
        </template>
        <template v-if="!make && result && result.adjustments.length">
          <h4>What the app changed</h4>
          <ul><li v-for="(item, index) in result.adjustments" :key="index">{{ item }}</li></ul>
        </template>
        <template v-if="!make && result && result.warnings.length">
          <h4>Check before you save</h4>
          <ul><li v-for="(item, index) in result.warnings" :key="index">{{ item }}</li></ul>
        </template>
      </div>
      <p v-if="!make && result && replacesUnsaved" :id="helpId('replace')" class="notice error">This replaces your unsaved changes in the editor.</p>
      <div class="scenario-generator-actions">
        <button type="button" data-testid="scenario-generator-generate" class="secondary" :disabled="!canGenerate" @click="requestScenario">{{ error ? 'Try again' : make ? 'Write my story' : 'Generate' }}</button>
        <button v-if="result" type="button" data-testid="scenario-generator-apply" :aria-describedby="replacesUnsaved ? helpId('replace') : undefined" :disabled="disabled" @click="useDraft">{{ applyLabel }}</button>
        <p v-if="applyError" role="alert" class="notice error" data-testid="scenario-generator-apply-error">{{ applyError }}</p>
        <button type="button" data-testid="scenario-generator-cancel" class="quiet" @click="close">Cancel</button>
      </div>
      <p v-if="!make" class="scenario-generator-footer">Nothing is saved until you press Save scenario version.</p>
    </section>
  </div>
</template>

<style scoped>
.scenario-generator { margin-bottom: 1rem; }
.scenario-generator-panel { margin-top: .6rem; padding: 1rem; border: 1px solid var(--line); border-left: 3px solid var(--teal); border-radius: 8px; background: var(--panel); max-width: 100%; box-sizing: border-box; }
.scenario-generator-panel label { display: grid; gap: .45rem; }
.scenario-generator-panel textarea { min-height: 110px; width: 100%; box-sizing: border-box; }
.scenario-generator-panel select { width: 100%; box-sizing: border-box; }
.scenario-generator-status { color: var(--teal); font-size: .9rem; margin: .6rem 0; }
.scenario-generator-preview { margin-top: .8rem; padding: .8rem; border: 1px solid var(--line); border-radius: 5px; font-size: .88rem; overflow-wrap: anywhere; }
.scenario-generator-title { color: var(--gold); }
.scenario-generator-preview h4 { margin: .8rem 0 .2rem; font-size: .8rem; color: var(--teal); }
.scenario-generator-preview p { margin: 0 0 .3rem; }
.scenario-generator-preview ul { margin: 0; padding-left: 1.2rem; display: grid; gap: .25rem; }
.scenario-generator-premise { color: var(--muted); }
.scenario-generator-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem; }
.scenario-generator-options summary { cursor: pointer; color: var(--muted); font-size: .85rem; margin: .6rem 0 .3rem; }
.scenario-generator-footer { color: var(--muted); font-size: .75rem; margin: .8rem 0 0; }
</style>
