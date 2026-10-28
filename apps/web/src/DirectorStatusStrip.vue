<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirectorSnapshot } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';

type AudioState = 'checking' | 'presenting' | 'none' | 'unknown';

const props = defineProps<{ snapshot: DirectorSnapshot; sessionId: string }>();
const emit = defineEmits<{ audio: [state: AudioState] }>();

const STUCK_AFTER_MS = 60000;

const audio = ref<AudioState>('checking');
const now = ref(Date.now());
const firstSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let alive = true;

function setAudio(next: AudioState) {
  if (audio.value === next && next !== 'checking') return;
  audio.value = next;
  emit('audio', next);
}

async function poll() {
  try {
    const playback = await api.playback(props.sessionId);
    if (!alive) return;
    setAudio(playback.presenter.available ? 'presenting' : 'none');
  } catch {
    if (alive) setAudio('unknown');
  }
}

const activeJobIds = computed(() => {
  const beatId = props.snapshot.activeBeat?.id;
  if (!beatId) return [] as string[];
  return props.snapshot.jobs.filter(job => job.beatId === beatId && ['queued', 'running'].includes(job.status)).map(job => job.id);
});

function stopClock() {
  if (clockTimer !== undefined) clearInterval(clockTimer);
  clockTimer = undefined;
}

watch(activeJobIds, ids => {
  const stamp = Date.now();
  for (const id of ids) if (!firstSeen.has(id)) firstSeen.set(id, stamp);
  for (const id of [...firstSeen.keys()]) if (!ids.includes(id)) firstSeen.delete(id);
  now.value = stamp;
  if (ids.length && clockTimer === undefined && alive) clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  else if (!ids.length) stopClock();
}, { immediate: true });

onMounted(() => {
  void poll();
  pollTimer = setInterval(() => { void poll(); }, 5000);
});
onBeforeUnmount(() => {
  alive = false;
  if (pollTimer !== undefined) clearInterval(pollTimer);
  stopClock();
});

const stuckSeconds = computed(() => {
  let longest = -1;
  for (const id of activeJobIds.value) {
    const seen = firstSeen.get(id);
    if (seen !== undefined) longest = Math.max(longest, now.value - seen);
  }
  return longest > STUCK_AFTER_MS ? Math.floor(longest / 1000) : null;
});
const hasWarning = computed(() => audio.value === 'none' || audio.value === 'unknown' || stuckSeconds.value !== null);
</script>

<template>
  <ul v-if="hasWarning" class="status-strip" aria-label="Show warnings">
    <li v-if="audio === 'none'" class="chip" data-testid="warning-no-audio">No show audio · <a :href="identityPath(`/sessions/${sessionId}/lobby#stage-links`)">Stream this show</a></li>
    <li v-if="audio === 'unknown'" class="chip" data-testid="warning-audio-unknown">Can't check the show audio</li>
    <li v-if="stuckSeconds !== null" class="chip" data-testid="warning-stuck" aria-live="polite">The AI is taking longer than usual ({{ stuckSeconds }} s)</li>
  </ul>
</template>

<style scoped>
.status-strip { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }
.chip { position: relative; min-width: 0; padding: 6px 12px; font-family: var(--font-label); font-size: 16px; line-height: 20px; font-weight: 400; color: var(--bone); overflow-wrap: anywhere; }
.chip::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void); clip-path: var(--cut-1); }
</style>
