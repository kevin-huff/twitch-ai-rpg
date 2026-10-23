<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { createPlaybackController } from './playback';

const props = defineProps<{ sessionId: string; beatId?: string; director: boolean; stage?: boolean }>();
const controller = createPlaybackController({ ...props });
const state = controller.state;
const ownershipPending = ref(false);
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

watch(() => [props.sessionId, props.beatId, props.director, props.stage], () => controller.setContext({ ...props }));
onUnmounted(() => controller.dispose());
</script>

<template>
  <section class="audio-panel" data-testid="audio-panel" aria-label="Reviewed narration playback">
    <div class="audio-heading">
      <strong>Reviewed narration</strong>
      <small data-testid="playback-status" aria-live="polite">{{ statusText }}</small>
    </div>
    <p v-if="state.error" class="notice error" role="alert">{{ state.error }} The published text remains available.</p>

    <template v-if="directorControls">
      <p class="audio-detail">{{ latestStatus }}</p>
      <p v-if="!presenterAvailable" class="audio-detail">Open stage and choose Present audio to appoint the broadcast presenter.</p>
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

    <div v-if="stage" class="audio-presenter">
      <p class="audio-detail">One browser is the broadcast presenter. {{ state.presenting ? 'This browser is presenting audio.' : presenterAvailable ? 'Another browser is presenting audio.' : 'Choose Present audio in this stage browser to present.' }}</p>
      <div class="actions">
        <button v-if="state.presenting" data-testid="release-audio" class="secondary" :disabled="ownershipPending || state.commandPending" @click="changePresenter(true)">Release audio</button>
        <button v-else data-testid="present-audio" class="secondary" :disabled="!state.snapshot || presenterAvailable || ownershipPending || state.commandPending" @click="changePresenter()">Present audio</button>
      </div>
    </div>

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
    <small v-if="stage">AI-generated voices. This stage is silent until you choose Present audio. Volume affects this browser.</small>
    <small v-else>AI-generated voices. Audio starts only after you choose Listen. Volume and mute affect this browser.</small>
  </section>
</template>

<style scoped>
.audio-panel { margin-top: 1.2rem; border-top: 1px solid var(--line); padding-top: 1rem; }
.audio-heading { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-bottom: .8rem; }
.audio-heading strong { font-size: .85rem; font-weight: 600; }
.audio-heading small, .audio-panel > small, .audio-detail, .audio-volume { font-size: .75rem; }
.audio-detail { margin: .65rem 0; color: var(--muted); }
.audio-transport, .audio-listening { margin-top: .65rem; }
.audio-presenter { margin-top: .9rem; }
.audio-volume { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; margin-top: .9rem; }
.audio-volume input { width: 8rem; max-width: 100%; padding: 0; accent-color: var(--gold); }
.audio-volume-value { min-width: 2.5rem; font-variant-numeric: tabular-nums; }
.audio-panel > small { display: block; margin-top: .7rem; }
.audio-caption { font-size: 1rem; margin-top: .8rem; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
