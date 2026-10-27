<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { identityPath } from './identity';
import { PAUSE_REQUEST_TEXT, useTable } from './table';
import Story from './Story.vue';
import AudioPanel from './AudioPanel.vue';
import OperationsPanel from './OperationsPanel.vue';
import LiveControls from './LiveControls.vue';
import CorrectionControls from './CorrectionControls.vue';
import BeatSteering from './BeatSteering.vue';
import BeatPanel from './BeatPanel.vue';
import DirectorQueue from './DirectorQueue.vue';
import DirectorStatusStrip from './DirectorStatusStrip.vue';
import type { GalleryAction, PictureSettings } from '@rpg/contracts';
import ScenePicturePanel from './ScenePicturePanel.vue';
import GalleryPanel from './GalleryPanel.vue';
import NpcPortraitControls from './NpcPortraitControls.vue';
import PictureAvatar from './PictureAvatar.vue';
import { api } from './api';
import { pictureUrl } from './pictures';


const { sessionId, stage, snapshot, busy, error, director, setup, latestHistory, work, send, refresh, onSnapshot, setStatus, nameOf } = useTable();

const beat = computed(() => director.value?.activeBeat ?? null);
const pending = computed(() => director.value?.submissions.filter(item => ['queued', 'selected'].includes(item.status)) ?? []);
const selected = ref<string[]>([]);
const dismissed = ref<string[]>([]);
const paused = computed(() => snapshot.value?.session.status === 'paused');
const picturesOn = computed(() => snapshot.value?.picturesEnabled === true);
const ended = computed(() => snapshot.value?.session.status === 'ended');
const portraitJob = (npcId: string) => director.value?.portraitJobs?.find(job => job.npcId === npcId) ?? null;
const portraitSrc = (portraitId: string | null | undefined) => (picturesOn.value && portraitId ? pictureUrl({ kind: 'session', sessionId }, portraitId) : null);
const portraitOf = (entityId: string) => {
  const character = snapshot.value?.characters.find(item => item.id === entityId);
  return portraitSrc(character ? character.portraitId : snapshot.value?.npcs.find(item => item.id === entityId)?.portraitId);
};
const newPicture = () => work(async () => { await api.newScenePicture(sessionId); await refresh(); });
const drawBeat = () => work(async () => { await api.drawBeatPicture(sessionId); await refresh(); });
const savePictureSettings = (settings: PictureSettings) => work(async () => { await api.savePictureSettings(sessionId, settings); await refresh(); });
const galleryAction = (action: GalleryAction['action']) => work(async () => { await api.galleryAction(sessionId, action); await refresh(); });
const pictureToggling = ref(false);
const togglePicture = async (change: (id: string) => Promise<unknown>) => {
  if (pictureToggling.value) return;
  pictureToggling.value = true;
  try { await change(sessionId); await refresh(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
  finally { pictureToggling.value = false; }
};
const hidePicture = () => togglePicture(id => api.hideScenePicture(id));
const showPicture = () => togglePicture(id => api.showScenePicture(id));
const createPortrait = (npcId: string) => work(async () => { await api.createNpcPortrait(sessionId, npcId); await refresh(); });
const removePortrait = (npcId: string) => work(async () => { await api.removeNpcPortrait(sessionId, npcId); await refresh(); });
const pauseRequests = computed(() => pending.value.filter(item => item.kind === 'ooc' && item.status === 'queued' && item.text === PAUSE_REQUEST_TEXT && !dismissed.value.includes(item.id)));

const linesWaiting = computed(() => pending.value.filter(item => item.kind !== 'ooc').length);
const linesWaitingText = computed(() => (linesWaiting.value === 0 ? 'No lines waiting' : linesWaiting.value === 1 ? '1 line waiting' : `${linesWaiting.value} lines waiting`));
const firstLine = computed(() => {
  const segment = latestHistory.value[0]?.segments[0];
  if (!segment) return 'Nothing published yet.';
  return `${segment.speaker?.displayName ?? (segment.kind === 'system' ? 'The show' : 'Narrator')}: ${segment.text}`;
});
const showStateText = computed(() => (ended.value ? 'Ended' : paused.value ? 'Paused' : 'Live'));

type ShowAudio = 'checking' | 'presenting' | 'none' | 'unknown';
const showAudio = ref<ShowAudio>('checking');
const autoPlayBeatId = ref<string | null>(null);
const playbackError = ref('');
const audioPanel = ref<InstanceType<typeof AudioPanel> | null>(null);
const onPublished = (beatId: string, voiced: boolean) => { playbackError.value = ''; if (voiced) autoPlayBeatId.value = beatId; };
const startPlayback = async () => { playbackError.value = ''; await audioPanel.value?.startLatest(); };

const confirmingEnd = ref(false);
const endError = ref('');
const askToEnd = () => { endError.value = ''; confirmingEnd.value = true; };
const keepGoing = () => { confirmingEnd.value = false; endError.value = ''; };
const endShow = () => work(async () => {
  endError.value = '';
  try {
    await send({ type: 'set_status', commandId: crypto.randomUUID(), status: 'ended', expectedStateRevision: snapshot.value!.session.stateRevision });
    confirmingEnd.value = false;
  } catch (cause) {
    endError.value = cause instanceof Error ? cause.message : 'The show could not be ended.';
  }
});

const seen = new Set<string>();
const untickedKey = `story-table-unticked:${sessionId}`;
let storedUnticked: Set<string> | null = null;
const readUnticked = () => {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(untickedKey) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set<string>(); }
};
const writeUnticked = (waitingIds: string[]) => {
  try { sessionStorage.setItem(untickedKey, JSON.stringify(waitingIds.filter(id => !selected.value.includes(id)))); } catch { /* storage unavailable */ }
};
const ingest = (next: { role: string; submissions: Array<{ id: string; kind: string; status: string }> }) => {
  if (next.role !== 'director' || stage) return;
  const waiting = next.submissions.filter(item => ['queued', 'selected'].includes(item.status));
  const kept = new Set(selected.value);
  const fresh = new Set<string>();
  storedUnticked ??= readUnticked();
  for (const item of waiting) {
    if (item.kind === 'ooc' || seen.has(item.id)) continue;
    seen.add(item.id);
    if (!storedUnticked.has(item.id)) fresh.add(item.id);
  }
  selected.value = waiting.filter(item => kept.has(item.id) || fresh.has(item.id)).map(item => item.id);
  writeUnticked(waiting.filter(item => item.kind !== 'ooc').map(item => item.id));
};
watch(selected, () => { if (!stage) writeUnticked(pending.value.filter(item => item.kind !== 'ooc').map(item => item.id)); });
if (snapshot.value) ingest(snapshot.value as never);
const stopListening = onSnapshot(next => ingest(next as never));
onUnmounted(stopListening);
</script>

<template>
  <template v-if="snapshot && director">
    <section class="show-bar" aria-label="Show bar">
      <div class="show-bar-row">
        <h1 data-testid="show-title">{{ snapshot.session.title }}</h1>
        <span class="show-state" :class="{ paused, ended }" data-testid="show-state">{{ showStateText }}</span>
        <span class="lines-waiting" data-testid="lines-waiting">{{ linesWaitingText }}</span>
        <span class="show-bar-spacer"></span>
        <template v-if="!ended">
          <button :class="{ secondary: !paused }" data-testid="top-pause" :disabled="busy || Boolean(setup && !setup.started)" @click="setStatus(paused ? 'live' : 'paused')">{{ paused ? 'Resume show' : 'Pause show' }}</button>
          <button class="secondary" data-testid="end-show" :disabled="busy || confirmingEnd" @click="askToEnd">End show</button>
        </template>
        <a class="quiet" :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a>
        <DirectorStatusStrip v-if="!ended" :snapshot="director" :session-id="sessionId" @audio="state => (showAudio = state)" />
      </div>
      <div v-if="confirmingEnd && !ended" class="end-confirm" data-testid="end-show-confirm-row">
        <span>End the show? Players will see that it's over, and it can't be restarted.</span>
        <span class="actions"><button data-testid="end-show-confirm" :disabled="busy" @click="endShow">End show</button><button class="quiet" data-testid="end-show-keep" @click="keepGoing">Keep going</button></span>
      </div>
      <p v-if="endError" class="end-error" role="alert" data-testid="end-show-error">{{ endError }}</p>
    </section>
    <div v-if="ended" class="ended-gallery" data-testid="ended-gallery"><GalleryPanel :status="director.gallery ?? null" :busy="busy" @action="galleryAction" /></div>
    <template v-if="!ended">
      <div v-for="item in pauseRequests" :key="item.id" class="pause-notice" aria-live="polite">
        <span>{{ nameOf(item.characterId) }} asked for a pause.</span>
        <span class="actions"><button v-if="!paused" class="secondary" :disabled="busy" @click="setStatus('paused')">Pause now</button><button class="quiet" @click="dismissed.push(item.id)">Dismiss</button></span>
      </div>
    </template>
    <div class="workspace" data-testid="director-controls">
          <aside class="stack"><DirectorQueue v-if="!ended" v-model="selected" :snapshot="director" /></aside>
          <section class="stack">
            <div class="scene-heading"><h2 data-testid="scene-title">{{ snapshot.session.scene.title }}</h2><details v-if="snapshot.session.scene.description" class="scene-description"><summary>Scene description</summary><p>{{ snapshot.session.scene.description }}</p></details></div>
            <BeatPanel v-if="!ended" :selected="selected" :show-audio="showAudio" :playback-error="playbackError" @published="onPublished" @start-playback="startPlayback" />
            <section class="panel"><div class="panel-heading"><h2>On the stage</h2><small>Published only</small></div><p class="stage-first-line" data-testid="stage-first-line">{{ firstLine }}</p><details class="stage-show-all" data-testid="stage-show-all"><summary>Show all</summary><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /><AudioPanel ref="audioPanel" :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="true" :auto-play-beat-id="autoPlayBeatId" @playback-failed="message => playbackError = message" /></details></section>
            <details class="show-tools" data-testid="show-tools">
              <summary>Show tools</summary>
              <div class="stack">
                <LiveControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
                <CorrectionControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
                <BeatSteering :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
                <OperationsPanel :session-id="sessionId" />
                <section class="panel"><p class="eyebrow">In the room</p><div v-for="npc in director.npcDetails" :key="npc.id" class="queue-item"><h3>{{ npc.displayName }}</h3><p class="muted">{{ npc.role }} · {{ npc.status }}</p><NpcPortraitControls :name="npc.displayName" :image-url="portraitSrc(npc.portraitId)" :state="portraitJob(npc.id)?.state ?? null" :message="portraitJob(npc.id)?.message ?? null" :enabled="picturesOn" :disabled="busy || ended" :can-create="Boolean(npc.appearance?.trim() || npc.role?.trim())" @create="createPortrait(npc.id)" @remove="removePortrait(npc.id)" /><details><summary>Director notes & memory</summary><p class="private-note">{{ npc.goal }}</p><p v-for="secret in npc.secrets" :key="secret" class="private-note">Secret: {{ secret }}</p><p v-for="memory in npc.knowledge" :key="memory.id" class="private-note">{{ memory.category }} · {{ memory.statement }}</p></details></div></section>
                <section class="panel"><p class="eyebrow">Scenario notes (read-only)</p><p class="private-note">{{ director.directorNotes }}</p></section>
                <section v-if="snapshot.facts.length" class="panel" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section>
                <section v-if="snapshot.tracks.length" class="panel"><p class="eyebrow">Live state</p><div v-for="track in snapshot.tracks" :key="track.id" class="track" :class="track.kind"><div class="track-label"><span>{{ track.label }}</span><span>{{ track.current }}/{{ track.max }}{{ !track.enabled ? ' · inactive' : '' }}</span></div><div class="track-pips"><span v-for="pip in track.max" :key="pip" :class="{ filled: pip <= track.current }"></span></div></div></section>
                <section class="panel"><p class="eyebrow">The cast</p><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><PictureAvatar :name="character.displayName" :src="portraitOf(character.id)" /><div><strong>{{ character.displayName }}</strong><small>Strain {{ character.strain }}/4</small></div></div></section>
              </div>
            </details>
          </section>
          <aside class="stack"><ScenePicturePanel :snapshot="director" :busy="busy" :toggling="pictureToggling" @new-picture="newPicture" @draw-beat="drawBeat" @save-settings="savePictureSettings" @hide="hidePicture" @show="showPicture" /></aside>
    </div>
  </template>
</template>

<style scoped>
:global(.shell[data-view="director"]) { max-width: 1840px; }
.show-bar { position: sticky; top: 0; z-index: 20; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .6rem 1rem; margin-bottom: 1rem; min-width: 0; }
.show-bar-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem; min-width: 0; }
.show-bar h1 { font-size: 1.3rem; margin: 0; overflow-wrap: anywhere; min-width: 0; }
.show-bar-spacer { flex: 1 1 0; }
.show-state { border: 1px solid var(--line); border-radius: 999px; padding: .15rem .6rem; font-size: .8rem; }
.show-state.paused { border-color: #b9923a; color: #e3bd62; }
.show-state.ended { color: var(--muted); }
.lines-waiting { color: var(--muted); font-size: .9rem; }
.end-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem; margin-top: .6rem; padding-top: .6rem; border-top: 1px solid var(--line); font-size: .9rem; }
.end-confirm .actions { display: flex; gap: .5rem; }
.end-error { margin: .5rem 0 0; color: #f0a0a0; font-size: .9rem; overflow-wrap: anywhere; }
.ended-gallery { margin-bottom: 1rem; }
.scene-heading h2 { margin: 0; font-size: 1.15rem; overflow-wrap: anywhere; }
.scene-description { margin-top: .3rem; font-size: .88rem; }
.scene-description summary { cursor: pointer; color: var(--muted); }
.scene-description p { color: var(--muted); max-width: 720px; white-space: pre-wrap; overflow-wrap: anywhere; margin: .4rem 0 0; }
.pause-notice { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem; border: 1px solid #b9923a; background: #2b2412; color: #f0d98f; border-radius: 6px; padding: .7rem 1rem; margin-bottom: 1rem; font-size: .9rem; }
.stage-first-line { margin: 0 0 .5rem; overflow-wrap: anywhere; white-space: pre-wrap; }
.stage-show-all > summary, .show-tools > summary { cursor: pointer; }
.show-tools > summary { font-size: 1.1rem; font-weight: 600; margin: .6rem 0; }
.show-tools .stack { margin-top: .6rem; }
@media (min-width: 1151px) { .workspace { grid-template-columns: minmax(240px, .75fr) minmax(520px, 1.9fr) minmax(240px, .75fr); } }
</style>
