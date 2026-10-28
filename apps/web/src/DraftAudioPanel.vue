<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { DraftAudioResponseSchema, type DraftAudioManifest, type DraftAudioResponse, type PrepareDraftAudio } from '@rpg/contracts';
import { getIdentity, identityHeaders, identityPath } from './identity';
import type { VoiceState } from './voice-state';

const props = withDefaults(defineProps<{
  sessionId: string; beatId: string; beatRevision: number; draftRevision: number; generation: number;
  dirty: boolean; busy: boolean; rendering: boolean; paused?: boolean;
}>(), { paused: false });
const emit = defineEmits<{ voice: [state: VoiceState] }>();
const FAILED_TEXT = 'The voice could not be prepared. Prepare voice again, or publish without voice.';
const status = ref<DraftAudioResponse['status']>('missing');
const manifest = ref<DraftAudioManifest | null>(null);
const loading = ref(false);
const preparing = ref(false);
const missingChecked = ref(false);
const attempted = reactive(new Set<string>());
const unconfirmed = reactive(new Set<string>());
const error = ref('');
const preview = ref<'idle' | 'playing' | 'complete'>('idle');
const activeIndex = ref(-1);
const identityInvalid = ref(false);
const retrying = ref<'' | 'checking' | 'preparing'>('');
const endpoint = computed(() => `/api/sessions/${encodeURIComponent(props.sessionId)}/beats/${encodeURIComponent(props.beatId)}/draft-audio`);
const context = () => JSON.stringify([props.sessionId, props.beatId, props.draftRevision, props.generation, props.dirty, props.rendering]);
const key = computed(() => `${props.beatId}:${props.draftRevision}:${props.generation}`);
const blocked = computed(() => props.dirty || props.busy || props.rendering || identityInvalid.value);
const ready = computed(() => !blocked.value && !preparing.value && status.value === 'ready' && manifest.value !== null);
const activeSegment = computed(() => manifest.value?.segments[activeIndex.value]);
const voice = computed<VoiceState>(() => {
  if (identityInvalid.value || props.dirty || props.rendering) return { status: 'checking' };
  if (retrying.value) return { status: attempted.has(key.value) ? 'preparing' : retrying.value };
  if (loading.value) return { status: 'checking' };
  if (preparing.value || status.value === 'preparing') return { status: 'preparing' };
  if (status.value === 'ready' && manifest.value) return { status: 'ready', preparationId: manifest.value.preparationId };
  if (status.value === 'unavailable') return { status: 'unavailable' };
  if (status.value === 'failed' || (attempted.has(key.value) && !unconfirmed.has(key.value))) return { status: 'failed', message: error.value || FAILED_TEXT };
  if (!missingChecked.value) return { status: 'checking' };
  return { status: 'preparing' };
});
const statusText = computed(() => {
  if (identityInvalid.value) return 'Reload this page before using its narration.';
  if (props.dirty) return 'Save your script edits to prepare the voice.';
  if (props.rendering) return 'A new script is being written. Its voice is prepared once it is ready.';
  if (loading.value) return 'Checking for a saved voice…';
  if (preview.value === 'playing') return 'Playing a preview in this browser only.';
  switch (voice.value.status) {
    case 'preparing': return 'Preparing voice…';
    case 'ready': return 'Voice ready. Preview it here if you like.';
    case 'failed': return FAILED_TEXT;
    case 'unavailable': return 'Speech is not set up. Publish without voice.';
    default: return 'Checking for a saved voice…';
  }
});
let selectedIdentity: string | undefined;
try { selectedIdentity = getIdentity(); } catch { identityInvalid.value = true; }
let currentAudio: HTMLAudioElement | null = null;
let playbackGeneration = 0;
let requestGeneration = 0;
let requestPending = false;
let requestController: AbortController | null = null;
let requestTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryCount = 0;
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
  clearRetry(); retryCount = 0;
  loading.value = false; preparing.value = false; pendingCommand = null; missingChecked.value = false;
  stopPreview(); manifest.value = null; status.value = 'missing';
}
function clearRetry() {
  clearTimeout(retryTimer); retryTimer = undefined; retrying.value = '';
}
function scheduleRetry(state: 'checking' | 'preparing') {
  clearTimeout(retryTimer);
  retrying.value = state;
  const delay = Math.min(1000 * 2 ** retryCount, 10_000);
  retryCount++;
  retryTimer = setTimeout(() => { retryTimer = undefined; void load(); }, delay);
}
function identityCurrent() {
  if (identityInvalid.value) return false;
  try { if (getIdentity() === selectedIdentity) return true; } catch { /* Invalid selectors must stop private playback. */ }
  invalidate(); identityInvalid.value = true;
  error.value = 'This tab\'s identity changed. Reload the page before using its narration.';
  return false;
}
function accept(data: DraftAudioResponse, checked: boolean, keepCommand = false) {
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
  if (checked && data.status === 'missing') missingChecked.value = true;
  if (data.status !== 'preparing' && !keepCommand) pendingCommand = null;
}
async function load(prepare = false) {
  if (disposed || props.dirty || props.rendering || !identityCurrent() || (prepare && blocked.value)) return;
  const generation = ++requestGeneration;
  const requestKey = key.value;
  clearTimeout(retryTimer); retryTimer = undefined;
  const savedContext = context();
  requestController?.abort();
  const controller = new AbortController(); requestController = controller; requestPending = true;
  if (prepare) {
    preparing.value = true; unconfirmed.add(requestKey);
    pendingCommand ??= { commandId: crypto.randomUUID(), expectedBeatRevision: props.beatRevision, draftRevision: props.draftRevision, generation: props.generation };
  } else loading.value = true;
  error.value = '';
  let replyStatus = 0;
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
        replyStatus = response.status;
        return { response, data: await response.json() };
      })(),
      deadline,
    ]);
    if (!current()) return;
    if (!response.ok) throw new Error(data.message || 'The saved recording could not be loaded.');
    const parsed = DraftAudioResponseSchema.safeParse(data);
    if (!parsed.success) throw new Error('The saved recording could not be loaded. Review the current script and try again.');
    const resend = !prepare && parsed.data.status === 'missing' && unconfirmed.has(requestKey);
    accept(parsed.data, !prepare, resend);
    clearRetry();
    if (!resend) { unconfirmed.delete(requestKey); retryCount = 0; }
  } catch (cause) {
    if (!current()) return;
    const wasPreparing = prepare || status.value === 'preparing';
    stopPreview(); manifest.value = null;
    error.value = cause instanceof Error ? cause.message : 'The saved recording could not be loaded.';
    if (prepare && !timedOut && replyStatus >= 400 && replyStatus < 500) {
      pendingCommand = null; unconfirmed.delete(requestKey);
      status.value = 'failed'; clearRetry(); retryCount = 0;
    } else {
      status.value = 'missing';
      scheduleRetry(wasPreparing ? 'preparing' : 'checking');
    }
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
function prepareAgain() {
  attempted.add(key.value);
  void load(true);
}

const autoPrepare = computed(() => missingChecked.value && status.value === 'missing' && !loading.value && !preparing.value
  && !blocked.value && !retrying.value && (!attempted.has(key.value) || unconfirmed.has(key.value)));
watch(voice, (value, previous) => {
  if (JSON.stringify(value) !== JSON.stringify(previous)) emit('voice', value);
}, { immediate: true });
watch(context, () => {
  invalidate(); error.value = '';
  if (!props.dirty && !props.rendering) void load();
}, { immediate: true });
watch(autoPrepare, go => { if (go) prepareAgain(); }, { immediate: true });
watch(() => props.busy, busy => { if (busy) stopPreview(); });
const interval = setInterval(() => {
  if (!identityCurrent()) return;
  if (status.value === 'preparing' && !requestPending && !props.dirty && !props.rendering) void load();
}, 1500);
const checkIdentity = () => { identityCurrent(); };
window.addEventListener('popstate', checkIdentity);
onUnmounted(() => { disposed = true; clearInterval(interval); window.removeEventListener('popstate', checkIdentity); invalidate(); });
</script>

<template>
  <section class="draft-audio-panel" data-testid="draft-audio-panel" aria-label="Narration preview">
    <strong>Narration preview</strong>
    <p class="draft-audio-detail" data-testid="draft-audio-status" aria-live="polite">{{ statusText }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div class="actions">
      <button v-if="voice.status === 'failed'" class="secondary" data-testid="prepare-draft-audio" :disabled="blocked || loading || preparing" @click="prepareAgain">Prepare voice again</button>
      <button class="secondary" data-testid="preview-draft-audio" :disabled="!ready || preview === 'playing'" @click="startPreview">Preview narration</button>
      <button v-if="preview === 'playing'" class="secondary" data-testid="stop-draft-preview" @click="stopPreview">Stop preview</button>
    </div>
    <p v-if="paused" class="draft-audio-paused draft-audio-detail">The show is paused. Resume it to publish.</p>
    <p v-if="activeSegment" class="draft-audio-caption"><strong>{{ activeSegment.speaker }}</strong> · {{ activeSegment.text }}</p>
    <small>AI-generated voices. The preview plays only in this browser.</small>
  </section>
</template>

<style scoped>
.draft-audio-panel { position: relative; margin: 20px 0; padding: 20px; }
.draft-audio-panel::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.draft-audio-detail { margin: 12px 0; color: var(--dust); font-size: 20px; line-height: 24px; }
.draft-audio-panel button { scroll-margin: 240px 0 480px; }
.draft-audio-caption { white-space: pre-wrap; overflow-wrap: anywhere; }
.draft-audio-panel > small { display: block; margin-top: 16px; font-size: 20px; line-height: 24px; }
</style>
