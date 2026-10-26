<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { DraftAudioResponseSchema, type DraftAudioManifest, type DraftAudioResponse, type PrepareDraftAudio } from '@rpg/contracts';
import { getIdentity, identityHeaders, identityPath } from './identity';

const props = withDefaults(defineProps<{
  sessionId: string; beatId: string; beatRevision: number; draftRevision: number; generation: number;
  dirty: boolean; busy: boolean; rendering: boolean; paused?: boolean; highlight?: boolean;
}>(), { paused: false, highlight: true });
const emit = defineEmits<{ publish: [preparationId: string]; 'recording-ready': [ready: boolean] }>();
const status = ref<DraftAudioResponse['status']>('missing');
const manifest = ref<DraftAudioManifest | null>(null);
const loading = ref(false);
const preparing = ref(false);
const publishing = ref(false);
const error = ref('');
const preview = ref<'idle' | 'playing' | 'complete'>('idle');
const activeIndex = ref(-1);
const identityInvalid = ref(false);
const endpoint = computed(() => `/api/sessions/${encodeURIComponent(props.sessionId)}/beats/${encodeURIComponent(props.beatId)}/draft-audio`);
const context = () => JSON.stringify([props.sessionId, props.beatId, props.draftRevision, props.generation, props.dirty, props.rendering]);
const blocked = computed(() => props.dirty || props.busy || props.rendering || identityInvalid.value || publishing.value);
const ready = computed(() => !blocked.value && !preparing.value && status.value === 'ready' && manifest.value !== null);
const activeSegment = computed(() => manifest.value?.segments[activeIndex.value]);
const statusText = computed(() => {
  if (identityInvalid.value) return 'Reload this page before reviewing its recording.';
  if (props.dirty) return 'Save your script edits before preparing or publishing audio.';
  if (props.rendering) return 'A new script is being generated. Review it before preparing audio.';
  if (preparing.value || status.value === 'preparing') return 'Preparing the saved script…';
  if (loading.value) return 'Checking the saved recording…';
  if (preview.value === 'playing') return 'Playing a private preview in this browser.';
  if (preview.value === 'complete') return 'Private preview finished. Review the recording before publication.';
  if (status.value === 'ready') return 'Recording ready for private review.';
  if (status.value === 'failed') return 'Speech preparation failed. Retry or publish text only.';
  if (status.value === 'unavailable') return 'Speech is not configured. You can publish text only.';
  return 'Prepare the saved script for a private listen.';
});
let selectedIdentity: string | undefined;
try { selectedIdentity = getIdentity(); } catch { identityInvalid.value = true; }
let currentAudio: HTMLAudioElement | null = null;
let playbackGeneration = 0;
let requestGeneration = 0;
let requestPending = false;
let requestController: AbortController | null = null;
let requestTimer: ReturnType<typeof setTimeout> | undefined;
let pendingCommand: PrepareDraftAudio | null = null;
let disposed = false;

function releaseAudio() {
  if (!currentAudio) return;
  currentAudio.onended = null; currentAudio.onerror = null;
  currentAudio.pause(); currentAudio.src = ''; currentAudio.load(); currentAudio = null;
}
function stopPreview() {
  playbackGeneration++; releaseAudio(); preview.value = 'idle'; activeIndex.value = -1;
}
function invalidate() {
  requestGeneration++; requestController?.abort(); requestController = null; requestPending = false;
  clearTimeout(requestTimer); requestTimer = undefined;
  loading.value = false; preparing.value = false; publishing.value = false; pendingCommand = null;
  stopPreview(); manifest.value = null; status.value = 'missing';
}
function identityCurrent() {
  if (identityInvalid.value) return false;
  try { if (getIdentity() === selectedIdentity) return true; } catch { /* Invalid selectors must stop private playback. */ }
  invalidate(); identityInvalid.value = true;
  error.value = 'This tab’s identity changed. Reload the page before reviewing a private recording.';
  return false;
}
function accept(data: DraftAudioResponse) {
  if (data.status === 'ready') {
    const value = data.manifest;
    if (value.beatId !== props.beatId || value.draftRevision !== props.draftRevision || value.generation !== props.generation
      || value.segments.some((segment, index) => segment.url !== `${endpoint.value}/${value.preparationId}/segments/${index}`)) {
      throw new Error('The recording does not match the current saved script. Reload and review it again.');
    }
    if (manifest.value?.preparationId !== value.preparationId) stopPreview();
    manifest.value = value;
  } else { stopPreview(); manifest.value = null; }
  status.value = data.status;
  if (data.status !== 'preparing') pendingCommand = null;
}
async function load(prepare = false) {
  if (disposed || props.dirty || props.rendering || !identityCurrent() || (prepare && blocked.value)) return;
  const generation = ++requestGeneration;
  const savedContext = context();
  requestController?.abort();
  const controller = new AbortController(); requestController = controller; requestPending = true;
  if (prepare) {
    preparing.value = true;
    pendingCommand ??= { commandId: crypto.randomUUID(), expectedBeatRevision: props.beatRevision, draftRevision: props.draftRevision, generation: props.generation };
  } else loading.value = true;
  error.value = '';
  let received = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelled = () => reject(new Error('The recording request was cancelled.'));
    controller.signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(prepare ? 'Preparation is taking longer than expected. Checking its saved result.' : 'Checking the saved recording timed out. Try again.'));
      controller.abort();
    }, prepare ? 60_000 : 10_000);
    requestTimer = timer;
  });
  const current = () => !disposed && generation === requestGeneration && savedContext === context() && identityCurrent();
  try {
    const { response, data } = await Promise.race([
      (async () => {
        const response = await fetch(endpoint.value, {
          credentials: 'same-origin', signal: controller.signal,
          headers: { ...identityHeaders(), ...(prepare ? { 'Content-Type': 'application/json' } : {}) },
          ...(prepare ? { method: 'POST', body: JSON.stringify(pendingCommand) } : {}),
        });
        return { response, data: await response.json() };
      })(),
      deadline,
    ]);
    received = true;
    if (!current()) return;
    if (!response.ok) throw new Error(data.message || 'The saved recording could not be loaded.');
    const parsed = DraftAudioResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error('The saved recording could not be loaded. Review the current script and try again.');
    accept(parsed.data);
  } catch (cause) {
    if (!current()) return;
    stopPreview(); manifest.value = null; status.value = prepare ? timedOut ? 'preparing' : 'failed' : 'missing';
    if (received) pendingCommand = null;
    error.value = cause instanceof Error ? cause.message : 'The saved recording could not be loaded.';
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled);
    if (!disposed && generation === requestGeneration) { preparing.value = false; loading.value = false; requestPending = false; requestController = null; requestTimer = undefined; }
  }
}
function previewCurrent(generation: number, choice: DraftAudioManifest) {
  return !disposed && generation === playbackGeneration && !blocked.value
    && manifest.value?.preparationId === choice.preparationId && identityCurrent();
}
function previewFailed(generation: number, choice: DraftAudioManifest) {
  if (!previewCurrent(generation, choice)) return;
  stopPreview(); error.value = 'The private preview could not play. Check browser audio permission and try Preview narration again.';
}
async function playSegment(index: number, generation: number, choice: DraftAudioManifest) {
  if (!previewCurrent(generation, choice)) return;
  releaseAudio();
  const segment = choice.segments[index];
  if (!segment) { preview.value = 'complete'; activeIndex.value = -1; return; }
  activeIndex.value = index; preview.value = 'playing';
  const audio = new Audio(identityPath(segment.url)); currentAudio = audio;
  audio.onended = () => { if (audio === currentAudio && previewCurrent(generation, choice)) void playSegment(index + 1, generation, choice); };
  audio.onerror = () => { if (audio === currentAudio) previewFailed(generation, choice); };
  try {
    await audio.play();
    if (audio !== currentAudio || !previewCurrent(generation, choice)) audio.pause();
  } catch { if (audio === currentAudio) previewFailed(generation, choice); }
}
function startPreview() {
  if (!ready.value || !identityCurrent() || !manifest.value) return;
  stopPreview(); error.value = '';
  void playSegment(0, playbackGeneration, manifest.value);
}
function publish() {
  if (props.paused || !ready.value || !identityCurrent() || !manifest.value) return;
  const preparationId = manifest.value.preparationId;
  stopPreview(); publishing.value = true; emit('publish', preparationId);
}

watch(ready, value => emit('recording-ready', value), { immediate: true });
watch(context, () => {
  invalidate(); error.value = '';
  if (!props.dirty && !props.rendering) void load();
}, { immediate: true });
watch(() => props.busy, busy => { if (busy) stopPreview(); else publishing.value = false; });
const interval = setInterval(() => {
  if (!identityCurrent()) return;
  if (status.value === 'preparing' && !requestPending && !props.dirty && !props.rendering) void load();
}, 1500);
const checkIdentity = () => { identityCurrent(); };
window.addEventListener('popstate', checkIdentity);
onUnmounted(() => { disposed = true; clearInterval(interval); window.removeEventListener('popstate', checkIdentity); invalidate(); });
</script>

<template>
  <section class="draft-audio-panel" data-testid="draft-audio-panel" aria-label="Private recording review">
    <strong>Review narration privately</strong>
    <p class="draft-audio-detail" data-testid="draft-audio-status" aria-live="polite">{{ statusText }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }} Text-only publication remains available.</p>
    <div class="actions">
      <button v-if="status !== 'ready'" class="secondary" data-testid="prepare-draft-audio" :disabled="blocked || loading || preparing || status === 'preparing' || status === 'unavailable'" @click="load(true)">{{ preparing || status === 'preparing' ? 'Preparing narration…' : 'Prepare draft narration' }}</button>
      <button class="secondary" data-testid="preview-draft-audio" :disabled="!ready || preview === 'playing'" @click="startPreview">Preview narration</button>
      <button v-if="preview === 'playing'" class="secondary" data-testid="stop-draft-preview" @click="stopPreview">Stop preview</button>
      <button data-testid="publish-draft-audio" :class="{ secondary: !ready || !highlight }" :disabled="!ready || paused" @click="publish">Publish with narration</button>
    </div>
    <p v-if="paused" class="draft-audio-paused draft-audio-detail">The table is paused. Resume it to publish.</p>
    <p v-if="activeSegment" class="draft-audio-caption"><strong>{{ activeSegment.speaker }}</strong> · {{ activeSegment.text }}</p>
    <small>AI-generated voices. Preview stays in this director browser. Publication shares this reviewed recording; broadcast playback starts separately.</small>
  </section>
</template>

<style scoped>
.draft-audio-panel { margin: 1rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: .6rem; }
.draft-audio-detail { margin: .6rem 0; color: var(--muted); font-size: .85rem; }
.draft-audio-caption { white-space: pre-wrap; overflow-wrap: anywhere; }
.draft-audio-panel > small { display: block; margin-top: .75rem; font-size: .75rem; }
</style>
