<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { createPlaybackController } from './playback';

const props = defineProps<{ sessionId: string; beatId?: string; director: boolean; stage?: boolean; compact?: boolean; autoPlayBeatId?: string | null }>();
const emit = defineEmits<{ 'playback-failed': [message: string] }>();
const controller = createPlaybackController({ ...props });
const state = controller.state;
const ownershipPending = ref(false);
// The compact seat control only reports errors once the player has asked for sound.
const asked = ref(false);
const confirming = ref(false);
const directorControls = computed(() => props.director && !props.stage);
const activeSegment = computed(() => {
  const current = state.snapshot;
  return current?.segmentIndex === null || !current?.manifest ? undefined : current.manifest.segments[current.segmentIndex];
});
const active = computed(() => state.snapshot?.status === 'playing' || state.snapshot?.status === 'paused');
const presenterAvailable = computed(() => Boolean(state.snapshot?.presenter.available));
const latestReady = computed(() => state.audioStatus === 'ready' && state.manifest?.beatId === props.beatId);
const currentIsLatest = computed(() => Boolean(state.snapshot?.playbackId && state.snapshot.manifest?.beatId === props.beatId));
const canStart = computed(() => latestReady.value && presenterAvailable.value && !state.commandPending);
const canReplay = computed(() => Boolean(state.snapshot?.manifest?.segments.length && presenterAvailable.value && !state.commandPending));
const statusText = computed(() => ({
  idle: 'Shared narration has not started', playing: 'Playing shared narration', paused: 'Shared narration paused',
  stopped: 'Shared narration stopped', complete: 'Shared narration complete',
})[state.snapshot?.status ?? 'idle']);
const latestStatus = computed(() => {
  if (!props.beatId) return 'Publish a beat before preparing narration.';
  if (state.preparing || state.audioStatus === 'preparing') return 'Preparing the latest published beat…';
  if (latestReady.value) return 'The latest published beat is ready to play.';
  if (state.audioStatus === 'unavailable') return 'Speech is not configured. Continue with the published text.';
  return 'Narration for the latest published beat is not prepared.';
});

async function changePresenter(release = false) {
  if (ownershipPending.value) return;
  ownershipPending.value = true;
  try { if (release) await controller.release(); else await controller.claim(); }
  finally { ownershipPending.value = false; }
}

async function confirmPresent() {
  confirming.value = false;
  await changePresenter();
}

// A failed shared command reports itself in state.error rather than throwing.
async function startAndReport(beatId?: string) {
  await controller.command('start', beatId);
  if (state.error) emit('playback-failed', `The narration did not start. ${state.error}`);
}
async function startLatest() { await startAndReport(); }
defineExpose({ startLatest });

// Starts the narration of a just-published beat once, when the shared player is free and a presenter is connected.
let autoPlayHandled: string | null = null;
function autoPlay() {
  const id = props.autoPlayBeatId;
  if (!id || id === autoPlayHandled || id !== props.beatId || !directorControls.value || props.compact) return;
  const snapshot = state.snapshot;
  if (!snapshot || !latestReady.value || state.manifest?.beatId !== id) return;
  if (!snapshot.presenter.available) { autoPlayHandled = id; return; }
  if (snapshot.playbackId && snapshot.manifest?.beatId === id) { autoPlayHandled = id; return; }
  if (snapshot.status === 'playing' || state.commandPending) return;
  autoPlayHandled = id;
  void startAndReport(id);
}
watch(() => [props.autoPlayBeatId, props.beatId, directorControls.value, state.snapshot?.status, state.snapshot?.playbackId, state.snapshot?.presenter.available,
  state.audioStatus, state.manifest?.beatId, state.commandPending], autoPlay, { immediate: true });

watch(presenterAvailable, available => { if (available && !state.presenting) confirming.value = false; });

watch(() => [props.sessionId, props.beatId, props.director, props.stage], () => controller.setContext({ ...props }));
onUnmounted(() => controller.dispose());
</script>

<template>
  <section v-if="compact" class="audio-panel compact" data-testid="audio-panel" aria-label="Narration">
    <p v-if="state.error && asked" class="notice error" role="alert">The sound could not play in this browser. Press Hear the story here to try again. The story still plays on the stream.</p>
    <div v-if="!state.presenting" class="actions audio-listening">
      <button v-if="!state.listening || state.muted" data-testid="listen-audio" class="secondary" :disabled="!state.snapshot || state.commandPending" @click="asked = true; controller.listen()">Hear the story here</button>
      <button v-else data-testid="mute-audio" class="secondary" @click="controller.mute()">Mute</button>
    </div>
    <label class="audio-volume">
      <span>Volume</span>
      <input data-testid="audio-volume" type="range" min="0" max="1" step="0.05" :value="state.volume" :aria-valuetext="`${Math.round(state.volume * 100)}%`" @input="controller.setVolume(Number(($event.target as HTMLInputElement).value))">
      <span class="audio-volume-value" aria-hidden="true">{{ Math.round(state.volume * 100) }}%</span>
    </label>
    <small>AI-generated voices. Plays the narration in this browser, in step with the show.</small>
  </section>
  <section v-else class="audio-panel" data-testid="audio-panel" aria-label="Reviewed narration playback">
    <div class="audio-heading">
      <strong>Reviewed narration</strong>
      <small data-testid="playback-status" aria-live="polite">{{ statusText }}</small>
    </div>
    <p v-if="state.error" class="notice error" role="alert">{{ state.error }} The published text remains available.</p>

    <template v-if="directorControls">
      <p class="audio-detail">{{ latestStatus }}</p>
      <p v-if="!presenterAvailable" class="audio-detail">No browser is playing broadcast audio yet. Load the main show link in OBS. You will find it in Cast & lobby, under Stream this show.</p>
      <div class="actions">
        <button v-if="beatId && !latestReady" data-testid="prepare-audio" class="secondary" :disabled="state.preparing || state.audioStatus === 'preparing'" @click="controller.prepare()">{{ state.preparing ? 'Preparing…' : 'Prepare narration' }}</button>
        <button v-if="beatId && !currentIsLatest" data-testid="start-audio" class="secondary" :disabled="!canStart" @click="controller.command('start')">Play latest reviewed beat</button>
        <button v-if="state.snapshot?.playbackId && state.snapshot.manifest" data-testid="replay-audio" class="secondary" :disabled="!canReplay" @click="controller.replay()">Replay current narration</button>
      </div>
      <div v-if="state.snapshot?.playbackId" class="actions audio-transport">
        <button v-if="state.snapshot.status === 'playing'" data-testid="pause-audio" class="secondary" :disabled="state.commandPending" @click="controller.command('pause')">Pause shared audio</button>
        <button v-if="state.snapshot.status === 'paused'" data-testid="resume-audio" class="secondary" :disabled="state.commandPending || !presenterAvailable" @click="controller.command('resume')">Resume shared audio</button>
        <button v-if="active" data-testid="skip-audio" class="secondary" :disabled="state.commandPending" @click="controller.command('skip')">Skip segment</button>
        <button v-if="active || state.snapshot.status === 'complete'" data-testid="stop-audio" class="secondary" :disabled="state.commandPending" @click="controller.command('stop')">Stop shared audio</button>
      </div>
    </template>

    <details v-if="stage" class="audio-presenter" data-testid="audio-options">
      <summary>Audio options</summary>
      <p class="audio-detail">One browser is the broadcast presenter. {{ state.presenting ? 'This browser is presenting audio.' : presenterAvailable ? 'Another browser is presenting audio.' : 'The main show link in OBS supplies broadcast audio. Present audio here takes it over.' }}</p>
      <div class="actions">
        <button v-if="state.presenting" data-testid="release-audio" class="secondary" :disabled="ownershipPending || state.commandPending" @click="changePresenter(true)">Release audio</button>
        <button v-else data-testid="present-audio" class="secondary" :disabled="!state.snapshot || presenterAvailable || ownershipPending || state.commandPending" @click="confirming = true">Present audio</button>
      </div>
      <div v-if="confirming && !state.presenting" class="audio-confirm" role="group" aria-label="Confirm taking the broadcast audio">
        <p>Take the broadcast audio from OBS? Viewers will hear this browser instead.</p>
        <div class="actions">
          <button data-testid="confirm-present-audio" class="secondary" :disabled="ownershipPending || state.commandPending" @click="confirmPresent()">Present here</button>
          <button class="quiet" @click="confirming = false">Cancel</button>
        </div>
      </div>
    </details>

    <div v-if="!stage && !state.presenting" class="actions audio-listening">
      <button v-if="!state.listening || state.muted" data-testid="listen-audio" class="secondary" :disabled="!state.snapshot || state.commandPending" @click="controller.listen()">Listen in this browser</button>
      <button v-else data-testid="mute-audio" class="secondary" @click="controller.mute()">Mute this browser</button>
    </div>
    <label class="audio-volume">
      <span>Volume in this browser</span>
      <input data-testid="audio-volume" type="range" min="0" max="1" step="0.05" :value="state.volume" :aria-valuetext="`${Math.round(state.volume * 100)}%`" @input="controller.setVolume(Number(($event.target as HTMLInputElement).value))">
      <span class="audio-volume-value" aria-hidden="true">{{ Math.round(state.volume * 100) }}%</span>
    </label>
    <p v-if="activeSegment" class="audio-caption" aria-live="polite"><strong>{{ activeSegment.speaker }}</strong> · {{ activeSegment.text }}</p>
    <small v-if="stage">AI-generated voices. The main show link in OBS plays the broadcast audio. Volume affects this browser.</small>
    <small v-else>AI-generated voices. Audio starts only after you choose Listen in this browser. Volume and mute affect this browser.</small>
  </section>
</template>

<style scoped>
.audio-panel { margin-top: 24px; border-top: 2px solid var(--night-raised); padding-top: 20px; }
.audio-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
.audio-heading strong { font-family: var(--font-label); font-size: 16px; line-height: 20px; font-weight: 400; }
.audio-heading small, .audio-panel > small, .audio-detail, .audio-volume { font-size: 20px; line-height: 24px; }
.audio-confirm { position: relative; margin-top: 12px; padding: 16px 20px; }
.audio-confirm::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void); clip-path: var(--cut-1); }
.audio-confirm p { margin: 0 0 12px; font-size: 20px; line-height: 24px; }
.audio-detail { margin: 12px 0; color: var(--dust); }
.audio-transport, .audio-listening { margin-top: 12px; }
.audio-presenter { margin-top: 16px; }
.audio-presenter summary { cursor: pointer; font-size: 20px; line-height: 24px; }
.audio-volume { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.audio-volume input { width: 160px; max-width: 100%; padding: 0; accent-color: var(--candle); }
.audio-volume-value { min-width: 48px; }
.audio-panel > small { display: block; margin-top: 12px; }
.audio-panel.compact { margin-top: 0; }
.audio-caption { font-size: 20px; line-height: 24px; margin-top: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
