<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DirectorSnapshot } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';

const props = defineProps<{ snapshot: DirectorSnapshot; sessionId: string }>();

const audio = ref<'checking' | 'presenting' | 'none' | 'unknown'>('checking');
const presenterSource = ref<'show_link' | 'preview' | null>(null);
const now = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let alive = true;

async function poll() {
  try {
    const playback = await api.playback(props.sessionId);
    if (!alive) return;
    audio.value = playback.presenter.available ? 'presenting' : 'none';
    presenterSource.value = playback.presenter.available ? (playback.presenter.source ?? null) : null;
  } catch {
    if (alive) audio.value = 'unknown';
  }
}

onMounted(() => {
  void poll();
  pollTimer = setInterval(() => { void poll(); }, 5000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 30000);
});
onBeforeUnmount(() => {
  alive = false;
  if (pollTimer !== undefined) clearInterval(pollTimer);
  if (clockTimer !== undefined) clearInterval(clockTimer);
});

const statusText = computed(() => ({ live: 'Live', paused: 'Paused', lobby: 'Lobby', ended: 'Ended' })[props.snapshot.session.status]);
const queued = computed(() => props.snapshot.submissions.filter(item => ['queued', 'selected'].includes(item.status)));
const questions = computed(() => queued.value.filter(item => item.kind === 'ooc').length);
const lines = computed(() => queued.value.length - questions.value);
const queueText = computed(() => `Queue: ${lines.value} ${lines.value === 1 ? 'line' : 'lines'} · ${questions.value} ${questions.value === 1 ? 'question' : 'questions'}`);
const presentingText = computed(() => {
  if (presenterSource.value === 'show_link') return 'Stage audio: OBS show link';
  if (presenterSource.value === 'preview') return 'Stage audio: a stage preview tab';
  return 'Stage audio: presenting';
});
const audioText = computed(() => ({ checking: 'Stage audio: checking…', presenting: presentingText.value, none: 'Stage audio: no presenter', unknown: 'Stage audio: unknown' })[audio.value]);
const lastPublish = computed(() => {
  const last = props.snapshot.history.at(-1);
  if (!last) return 'Nothing published yet';
  const minutes = Math.max(0, Math.floor((now.value - Date.parse(last.publishedAt)) / 60000));
  if (Number.isNaN(minutes)) return 'Last publish: unknown';
  if (minutes < 1) return 'Last publish: just now';
  if (minutes < 60) return `Last publish: ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `Last publish: ${hours} h ago` : `Last publish: ${Math.floor(hours / 24)} days ago`;
});
const aiText = computed(() => {
  const beatId = props.snapshot.activeBeat?.id;
  if (!beatId) return '';
  const jobs = props.snapshot.jobs.filter(job => job.beatId === beatId && ['queued', 'running'].includes(job.status));
  if (!jobs.length) return '';
  return jobs.some(job => job.task === 'render') ? 'AI: drafting…' : 'AI: planning…';
});
</script>

<template>
  <ul class="status-strip" aria-label="Show status">
    <li class="chip" :data-state="snapshot.session.status">{{ statusText }}</li>
    <li class="chip">{{ queueText }}</li>
    <li class="chip">{{ audioText }}<template v-if="audio === 'none'"> · <a :href="identityPath(`/sessions/${sessionId}/lobby#stage-links`)">Set up stage audio</a></template></li>
    <li class="chip">{{ lastPublish }}</li>
    <li v-if="aiText" class="chip" aria-live="polite">{{ aiText }}</li>
  </ul>
</template>

<style scoped>
.status-strip { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; margin: 0; padding: 0; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: .2rem .65rem; font-size: .78rem; color: var(--muted); line-height: 1.4; }
.chip[data-state="live"] { border-color: var(--teal); color: var(--teal); }
.chip[data-state="paused"] { border-color: #b9923a; color: #e3bd62; }
</style>
