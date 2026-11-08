<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirectorSnapshot, ShowAudioHolder } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';

type AudioState = 'checking' | 'presenting' | 'none' | 'unknown';

const props = defineProps<{ snapshot: DirectorSnapshot; sessionId: string }>();
const emit = defineEmits<{ audio: [state: AudioState] }>();

const STUCK_AFTER_MS = 60000;

const audio = ref<AudioState>('checking');
const now = ref(Date.now());
const releasing = ref(false);
const releaseError = ref('');
const holder = ref<ShowAudioHolder | null>(null);
const dismissedResume = ref('');
const firstSeen = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let alive = true;

function setAudio(next: AudioState) {
  if (audio.value === next && next !== 'checking') return;
  audio.value = next;
  emit('audio', next);
}

async function pollHolder() {
  try {
    const answer = await api.showAudioHolder(props.sessionId);
    if (alive) holder.value = answer.holder;
  } catch {
    // keep the last good answer
  }
}

async function poll() {
  void pollHolder();
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
const pinned = computed(() => props.snapshot.pinnedPicture ?? null);

async function release() {
  if (releasing.value) return;
  releasing.value = true;
  releaseError.value = '';
  try {
    await api.releasePicture(props.sessionId);
  } catch (cause) {
    if (alive) releaseError.value = cause instanceof Error && cause.message ? cause.message : 'The picture could not be released.';
  } finally {
    releasing.value = false;
  }
}
const resumeNote = computed(() => {
  const current = holder.value;
  if (!current?.resumedAt || current.resumedAt === dismissedResume.value) return null;
  const where = current.browser === 'obs' ? 'OBS' : current.browser === 'browser' ? 'a browser' : 'a page';
  const time = new Date(current.resumedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return { stamp: current.resumedAt, text: `Narration resumed by itself on ${current.label} (${where}) at ${time}.` };
});
const downChips = computed(() => {
  const beat = props.snapshot.activeBeat;
  const resolution = beat?.resolution ?? null;
  const rolled = beat?.phase === 'locked' || beat?.phase === 'draft_review';
  const chips: { id: string; text: string }[] = [];
  for (const character of props.snapshot.characters ?? []) {
    if (character.condition !== 'down') continue;
    const name = character.displayName;
    let text: string;
    if (beat && (beat.phase === 'collecting' || beat.phase === 'stakes_review')) {
      text = `${name} is down. Someone can save ${name} in this round. If nobody does, ${name} gets a last-chance roll when this round's dice are rolled.`;
    } else if (rolled) {
      const roll = resolution?.rolls.find(entry => entry.lastChance && entry.actorCharacterId === character.id);
      const effects = [...(resolution?.effects ?? []), ...(resolution?.effectGroups ?? []).flat()];
      if (roll) {
        text = roll.band === 'clean' || roll.band === 'costly'
          ? `${name}'s last chance rolled ${roll.total}: ${name} pulls through at 7 of 8 when you publish.`
          : `${name}'s last chance rolled ${roll.total}: ${name} dies when you publish.`;
      } else if (effects.some(effect => effect.kind === 'character_rescue' && effect.characterId === character.id)) {
        text = `${name} is saved when you publish and comes back up at 6 of 8.`;
      } else {
        text = `${name} is down. This beat has no dice, so someone can still save ${name} in the next round.`;
      }
    } else {
      text = `${name} is down. Someone can save ${name} in the next round. If nobody does, ${name} gets a last-chance roll when that round's dice are rolled.`;
    }
    chips.push({ id: character.id, text });
  }
  return chips;
});
const hasWarning = computed(() => audio.value === 'none' || audio.value === 'unknown' || stuckSeconds.value !== null || resumeNote.value !== null || downChips.value.length > 0);
</script>

<template>
  <ul v-if="hasWarning || pinned" class="status-strip" aria-label="Show status">
    <li v-if="audio === 'none'" class="chip" data-testid="warning-no-audio">No show audio · <a :href="identityPath(`/sessions/${sessionId}/lobby#stage-links`)">Stream this show</a></li>
    <li v-if="audio === 'unknown'" class="chip" data-testid="warning-audio-unknown">Can't check the show audio</li>
    <li v-if="stuckSeconds !== null" class="chip" data-testid="warning-stuck" aria-live="polite">The AI is taking longer than usual ({{ stuckSeconds }} s)</li>
    <li v-if="resumeNote" class="chip" data-testid="auto-resumed">
      {{ resumeNote.text }}
      <button type="button" class="quiet" data-testid="auto-resumed-dismiss" @click="dismissedResume = resumeNote.stamp">Dismiss</button>
    </li>
    <li v-for="chip in downChips" :key="chip.id" class="chip" :data-testid="`condition-${chip.id}`">{{ chip.text }}</li>
    <li v-if="pinned" class="chip" data-testid="pinned-line">
      Pinned: {{ pinned.label }}
      <button type="button" class="secondary" data-testid="release-pinned" :disabled="releasing" @click="release">Release</button>
      <span v-if="releaseError" class="notice error" role="alert" data-testid="release-error">{{ releaseError }}</span>
    </li>
  </ul>
</template>

<style scoped>
.status-strip { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }
.chip { position: relative; min-width: 0; padding: 6px 12px; font-family: var(--font-label); font-size: 16px; line-height: 20px; font-weight: 400; color: var(--bone); overflow-wrap: anywhere; }
.chip::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void); clip-path: var(--cut-1); }
</style>
