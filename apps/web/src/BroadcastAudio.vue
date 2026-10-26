<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
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
  controller.value = createPlaybackController({ sessionId: props.sessionId, beatId: props.beatId, director: false, stage: props.mode === 'present' });
  startTimer();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  controller.value?.dispose();
  controller.value = null;
}

const state = computed(() => {
  const current = controller.value?.state;
  if (!current) return 'off';
  if (current.presenting) return 'presenting';
  if (current.listening) return 'listening';
  return current.error ? 'error' : 'waiting';
});

onMounted(build);
onBeforeUnmount(stop);

watch(() => [props.sessionId, props.mode], build);
watch(() => props.beatId, () => {
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
</template>
