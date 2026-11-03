<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { StreamAudio } from '@rpg/contracts';
import { createPlaybackController } from './playback';

const props = defineProps<{ sessionId: string; beatId?: string; mode: StreamAudio }>();
const emit = defineEmits<{
  status: [value: { presenting: boolean; listening: boolean; error: string }];
  segment: [id: string | null];
}>();

type Controller = ReturnType<typeof createPlaybackController>;
const controller = shallowRef<Controller | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
let soundOnTimer: ReturnType<typeof setTimeout> | undefined;

function startTimer() {
  clearInterval(timer);
  timer = undefined;
  const current = controller.value;
  if (!current) return;
  if (props.mode === 'present') {
    timer = setInterval(() => {
      const { snapshot, presenting } = current.state;
      if (snapshot && !presenting && !snapshot.presenter.available) void current.claim();
    }, 3000);
  } else if (props.mode === 'listen') {
    timer = setInterval(() => {
      if (current.state.snapshot && !current.state.listening) current.listen();
    }, 5000);
  }
}

function build() {
  stop();
  if (props.mode === 'off') { emit('status', { presenting: false, listening: false, error: '' }); emit('segment', null); return; }
  controller.value = props.mode === 'follow'
    ? createPlaybackController({ sessionId: props.sessionId, beatId: undefined, director: false, stage: false })
    : createPlaybackController({ sessionId: props.sessionId, beatId: props.beatId, director: false, stage: props.mode === 'present' });
  startTimer();
}

function stop() {
  clearInterval(timer);
  clearTimeout(soundOnTimer);
  timer = undefined;
  controller.value?.dispose();
  controller.value = null;
}

const state = computed(() => {
  const current = controller.value?.state;
  if (!current) return 'off';
  if (props.mode === 'follow') return current.error ? 'error' : 'following';
  if (current.presenting) return 'presenting';
  if (current.listening) return 'listening';
  return current.error ? 'error' : 'waiting';
});

const inObs = typeof window !== 'undefined' && 'obsstudio' in window;
const soundState = computed(() => controller.value?.state.sound ?? 'idle');
// Once sound is on the panel steps aside after a moment, because the hosting streamer may be sharing this very window.
const soundOnSettled = ref(false);
watch(soundState, value => {
  clearTimeout(soundOnTimer);
  soundOnSettled.value = false;
  if (value === 'ready') soundOnTimer = setTimeout(() => { soundOnSettled.value = true; }, 4000);
});
const showStartSound = computed(() => !inObs && props.mode === 'listen' && soundState.value !== 'played' && !soundOnSettled.value);
const soundStatus = computed(() => {
  if (soundState.value === 'blocked') return 'This browser blocked the sound. Press Start sound.';
  if (soundState.value === 'ready') return 'Sound is on. The narration plays here when it starts.';
  return 'Press Start sound to hear the show on this page.';
});

function startSound() {
  const current = controller.value;
  if (!current) return;
  void current.unlock().then(ok => { if (ok && controller.value === current) current.listen(); });
}

onMounted(build);
onBeforeUnmount(stop);

watch(() => [props.sessionId, props.mode], build);
watch(() => props.beatId, () => {
  if (props.mode === 'follow') return;
  controller.value?.setContext({ sessionId: props.sessionId, beatId: props.beatId, director: false, stage: props.mode === 'present' });
});

watch(() => {
  const current = controller.value?.state;
  return { presenting: Boolean(current?.presenting), listening: Boolean(current?.listening), error: current?.error ?? '' };
}, value => emit('status', value), { deep: true });

watch(() => {
  const snapshot = controller.value?.state.snapshot;
  if (!snapshot || snapshot.status !== 'playing' || snapshot.segmentIndex === null) return null;
  return snapshot.manifest?.segments[snapshot.segmentIndex]?.id ?? null;
}, id => emit('segment', id));
</script>

<template>
  <div hidden data-testid="broadcast-audio" :data-state="state"></div>
  <div v-if="showStartSound" class="start-sound" data-testid="start-sound-panel" role="status">
    <span class="start-sound-status" data-testid="start-sound-status">{{ soundStatus }}</span>
    <button v-if="soundState !== 'ready'" type="button" data-testid="start-sound" @click="startSound">Start sound</button>
  </div>
</template>

<style scoped>
.start-sound { position: fixed; left: 16px; bottom: 16px; z-index: 50; isolation: isolate; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; max-width: calc(100vw - 32px); padding: 10px 16px; color: var(--bone); }
.start-sound::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.start-sound-status { font-size: 20px; line-height: 24px; }
</style>
