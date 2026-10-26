<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
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
import type { PictureSettings } from '@rpg/contracts';
import ScenePicturePanel from './ScenePicturePanel.vue';
import NpcPortraitControls from './NpcPortraitControls.vue';
import PictureAvatar from './PictureAvatar.vue';
import { api } from './api';
import { pictureUrl } from './pictures';


const { sessionId, stage, snapshot, busy, director, setup, latestHistory, work, send, refresh, onSnapshot, setStatus, nameOf } = useTable();

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
const hidePicture = () => work(async () => { await api.hideScenePicture(sessionId); await refresh(); });
const showPicture = () => work(async () => { await api.showScenePicture(sessionId); await refresh(); });
const createPortrait = (npcId: string) => work(async () => { await api.createNpcPortrait(sessionId, npcId); await refresh(); });
const removePortrait = (npcId: string) => work(async () => { await api.removeNpcPortrait(sessionId, npcId); await refresh(); });
const beatActive = computed(() => Boolean(beat.value && !['published', 'aborted'].includes(beat.value.phase)));
const beatLine = computed(() => {
  const count = snapshot.value?.session.beatNumber ?? 0;
  return beatActive.value ? `Beat ${count + 1} in progress` : `${count} ${count === 1 ? 'beat' : 'beats'} published`;
});
const pauseRequests = computed(() => pending.value.filter(item => item.kind === 'ooc' && item.status === 'queued' && item.text === PAUSE_REQUEST_TEXT && !dismissed.value.includes(item.id)));

const beatPanel = useTemplateRef<InstanceType<typeof BeatPanel>>('beatPanel');
const stepName = ref('');
const showBar = useTemplateRef<HTMLElement>('showBar');
const showBarHeight = ref(0);
let showBarObserver: ResizeObserver | undefined;

function measureShowBar() {
  if (showBar.value) showBarHeight.value = Math.ceil(showBar.value.getBoundingClientRect().height);
}

async function goToBeat() {
  measureShowBar();
  await nextTick();
  beatPanel.value?.focusPrimary();
}

onMounted(() => {
  measureShowBar();
  if (typeof ResizeObserver !== 'undefined' && showBar.value) {
    showBarObserver = new ResizeObserver(measureShowBar);
    showBarObserver.observe(showBar.value);
  }
});
onUnmounted(() => showBarObserver?.disconnect());

const stopListening = onSnapshot(next => {
  if (next.role === 'director' && !stage) {
    selected.value = selected.value.filter(id => next.submissions.some(item => item.id === id && ['queued', 'selected'].includes(item.status)));
  }
});
onUnmounted(stopListening);
</script>

<template>
  <template v-if="snapshot && director">
    <section ref="showBar" class="show-bar" aria-label="Show bar">
      <div class="show-bar-main">
        <p class="eyebrow">{{ snapshot.session.title }}</p>
        <h1>{{ snapshot.session.scene.title }}</h1>
        <p class="beat-line">{{ beatLine }}</p>
        <details v-if="snapshot.session.scene.description" class="scene-description"><summary>Scene description</summary><p>{{ snapshot.session.scene.description }}</p></details>
      </div>
      <DirectorStatusStrip :snapshot="director" :session-id="sessionId" />
      <div class="actions">
        <p v-if="stepName" class="show-step">Step: {{ stepName }}</p>
        <button class="secondary" @click="goToBeat">Go to beat</button>
        <a :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a>
        <button :class="{ secondary: !paused }" :disabled="busy || Boolean(setup && !setup.started)" @click="setStatus(paused ? 'live' : 'paused')">{{ paused ? 'Resume table' : 'Pause table' }}</button>
      </div>
    </section>
    <div v-for="item in pauseRequests" :key="item.id" class="pause-notice" aria-live="polite">
      <span>{{ nameOf(item.characterId) }} asked for a pause.</span>
      <span class="actions"><button v-if="!paused" class="secondary" :disabled="busy" @click="setStatus('paused')">Pause now</button><button class="quiet" @click="dismissed.push(item.id)">Dismiss</button></span>
    </div>
    <div class="workspace" data-testid="director-controls">
          <aside class="stack"><DirectorQueue v-model="selected" :snapshot="director" /><section v-if="snapshot.tracks.length" class="panel"><p class="eyebrow">Live state</p><div v-for="track in snapshot.tracks" :key="track.id" class="track" :class="track.kind"><div class="track-label"><span>{{ track.label }}</span><span>{{ track.current }}/{{ track.max }}{{ !track.enabled ? ' · inactive' : '' }}</span></div><div class="track-pips"><span v-for="pip in track.max" :key="pip" :class="{ filled: pip <= track.current }"></span></div></div></section></aside>
          <section class="stack">
            <BeatPanel ref="beatPanel" :style="{ scrollMarginTop: `${showBarHeight + 12}px` }" :selected="selected" @step="name => (stepName = name)" />
            <section class="panel"><div class="panel-heading"><h2>On the stage</h2><small>Published only</small></div><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /><AudioPanel :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="true" /></section>
            <h2 class="tools-heading">Show tools</h2>
            <LiveControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
            <CorrectionControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
            <BeatSteering :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" />
            <OperationsPanel :session-id="sessionId" />
          </section>
          <aside class="stack"><ScenePicturePanel :snapshot="director" :busy="busy" @new-picture="newPicture" @draw-beat="drawBeat" @save-settings="savePictureSettings" @hide="hidePicture" @show="showPicture" /><section v-if="snapshot.facts.length" class="panel" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section><section class="panel"><p class="eyebrow">In the room</p><div v-for="npc in director.npcDetails" :key="npc.id" class="queue-item"><h3>{{ npc.displayName }}</h3><p class="muted">{{ npc.role }} · {{ npc.status }}</p><NpcPortraitControls :name="npc.displayName" :image-url="portraitSrc(npc.portraitId)" :state="portraitJob(npc.id)?.state ?? null" :message="portraitJob(npc.id)?.message ?? null" :enabled="picturesOn" :disabled="busy || ended" :can-create="Boolean(npc.appearance?.trim() || npc.role?.trim())" @create="createPortrait(npc.id)" @remove="removePortrait(npc.id)" /><details><summary>Director notes & memory</summary><p class="private-note">{{ npc.goal }}</p><p v-for="secret in npc.secrets" :key="secret" class="private-note">Secret: {{ secret }}</p><p v-for="memory in npc.knowledge" :key="memory.id" class="private-note">{{ memory.category }} · {{ memory.statement }}</p></details></div></section><section class="panel"><p class="eyebrow">Scenario notes (read-only)</p><p class="private-note">{{ director.directorNotes }}</p></section><section class="panel"><p class="eyebrow">The cast</p><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><PictureAvatar :name="character.displayName" :src="portraitOf(character.id)" /><div><strong>{{ character.displayName }}</strong><small>Strain {{ character.strain }}/4</small></div></div></section></aside>
    </div>
  </template>
</template>

<style scoped>
:global(.shell[data-view="director"]) { max-width: 1840px; }
.show-bar { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem 1.2rem; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .8rem 1rem; margin-bottom: 1rem; min-width: 0; }
.show-bar-main { min-width: 0; flex: 1 1 260px; }
.show-bar .eyebrow { margin-bottom: .2rem; }
.show-bar h1 { font-size: 1.6rem; margin: 0; overflow-wrap: anywhere; }
.beat-line { color: var(--muted); font-size: .85rem; margin: .2rem 0 0; }
.scene-description { margin-top: .4rem; font-size: .88rem; }
.scene-description summary { cursor: pointer; color: var(--muted); }
.scene-description p { color: var(--muted); max-width: 720px; white-space: pre-wrap; overflow-wrap: anywhere; margin: .4rem 0 0; }
.show-bar .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem; min-width: 0; }
.show-step { margin: 0; color: var(--muted); font-size: .9rem; overflow-wrap: anywhere; }
.show-bar > .status-strip { flex: 1 1 100%; order: 3; }
.pause-notice { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem; border: 1px solid #b9923a; background: #2b2412; color: #f0d98f; border-radius: 6px; padding: .7rem 1rem; margin-bottom: 1rem; font-size: .9rem; }
.tools-heading { margin: .6rem 0 0; font-size: 1.1rem; }
@media (min-width: 1151px) { .workspace { grid-template-columns: minmax(240px, .75fr) minmax(520px, 1.9fr) minmax(240px, .75fr); } }
</style>
