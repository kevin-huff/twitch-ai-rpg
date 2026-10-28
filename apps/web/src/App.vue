<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { identityPath } from './identity';
import { createTable, provideTable } from './table';
import Story from './Story.vue';
import StageView from './StageView.vue';
import HostHome from './HostHome.vue';
import MakeShow from './MakeShow.vue';
import PreShow from './PreShow.vue';
import PlayerSeat from './PlayerSeat.vue';
import DirectorWorkspace from './DirectorWorkspace.vue';
import Library from './Library.vue';
import PlayerBuilder from './PlayerBuilder.vue';
import ErrorNotice from './ErrorNotice.vue';
import Lobby from './Lobby.vue';
import HelpPage from './HelpPage.vue';
import ProducerSignIn from './ProducerSignIn.vue';
import type { Command } from '@rpg/contracts';
import { api } from './api';
import { navigate } from './navigate';

const table = createTable();
provideTable(table);
const { path, sessionId, view, stage, inviteToken, testCharacterId, snapshot, error, notice, loading, busy, connected, director, player, setup, latestHistory, work, send, restoreSession, dispose, requestPause, setStatus } = table;

const seat = computed(() => view !== 'lobby' && !(setup.value && !setup.value.started) && !director.value && Boolean(player.value));
const workspace = computed(() => view !== 'lobby' && !(setup.value && !setup.value.started) && Boolean(director.value));

const preShow = computed(() => view !== 'lobby' && Boolean(setup.value && !setup.value.started) && !director.value && Boolean(player.value));

const helpRoute = path === '/help' || path.startsWith('/help/');
const producerRoute = path === '/producer' || path === '/producer/';
const producerLabel = ref<string | null>(null);
const viewerRole = ref<string | null>(null);
const roleLabel = computed(() => producerLabel.value !== null ? `Producer · ${producerLabel.value}` : director.value || viewerRole.value === 'host' ? 'Host' : player.value || viewerRole.value === 'player' ? 'Player' : '');
const streamPath = computed(() => `/sessions/${sessionId}/lobby#${director.value ? 'stage-links' : 'my-stream-view'}`);

async function loadViewer() {
  try {
    const viewer = await api.me();
    producerLabel.value = viewer.producer ? viewer.producer.label : null;
    viewerRole.value = viewer.role;
  } catch { producerLabel.value = null; viewerRole.value = null; }
}

async function startOrSend(command: Command) {
  let sent = false;
  await work(async () => { await send(command); sent = true; });
  if (sent && command.type === 'start_session') navigate(`/sessions/${encodeURIComponent(sessionId)}/director`);
}

const RETURN_KEY = 'story-table-return-path';
function rememberReturnPath() {
  if (helpRoute) return;
  try { window.sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search + window.location.hash); } catch { /* storage unavailable */ }
}

onMounted(async () => {
  rememberReturnPath();
  window.addEventListener('pagehide', rememberReturnPath);
  if (helpRoute || producerRoute) return;
  if (path === '/library' || path === '/build-character' || path === '/make') { loading.value = false; return; }
  if (!inviteToken && (!sessionId || view === 'director' || view === 'lobby')) void loadViewer();
  if (sessionId) await restoreSession();
  else loading.value = false;
});
onUnmounted(() => {
  window.removeEventListener('pagehide', rememberReturnPath);
  dispose();
});
</script>

<template>
  <StageView v-if="stage" />
  <template v-else>
    <header class="app-header"><span v-if="path === '/build-character'" class="brand">The Story Table</span><a v-else class="brand" :href="identityPath('/')">The Story Table</a><div class="header-meta"><a :href="identityPath('/help')">Help</a><span v-if="roleLabel" class="role-label">{{ roleLabel }}</span><a v-if="sessionId && (director || player)" data-testid="stream-this-show" :href="identityPath(streamPath)">Stream this show</a><span v-if="sessionId" class="status" :class="{ offline: !connected }">{{ connected ? 'Connected' : 'Reconnecting' }}</span><a v-if="director" data-testid="stage-preview-link" :href="identityPath(`/sessions/${sessionId}/stage`)" target="_blank" rel="noopener">Preview (not for OBS) <span class="glyph-new-tab" aria-hidden="true"></span></a></div></header>
    <main v-if="producerRoute" class="welcome"><ProducerSignIn /></main><HelpPage v-else-if="helpRoute" />
    <PlayerBuilder v-else-if="path === '/build-character'" /><Library v-else-if="path === '/library'" /><MakeShow v-else-if="path === '/make'" /><HostHome v-else-if="!sessionId" />
    <main v-else class="shell" :data-view="view">
      <ErrorNotice v-if="error" :message="error" @dismiss="error = ''"><button type="button" class="quiet" :disabled="busy" @click="restoreSession">{{ testCharacterId !== null ? 'Retry opening seat' : 'Refresh state' }}</button></ErrorNotice>
      <div v-if="notice" class="notice" role="status">{{ notice }}</div>
      <div v-if="loading" class="loading">Loading the show…</div>
      <template v-if="snapshot">
        <div v-if="!connected" class="notice">{{ !director && player ? 'Connection lost. Your unsent words stay in this browser. The page reconnects by itself and never sends anything for you.' : 'Connection interrupted. Unsaved words stay in this browser. Reconnect refreshes the show; it never sends them.' }}</div>
        <div v-if="snapshot.session.status === 'paused' && !seat" class="notice">{{ player ? 'The show is paused. The director will start again soon.' : 'The show is paused. Check in with the cast before continuing.' }}</div>
        <section v-if="!seat && !workspace && !preShow" class="scene-heading"><div><p class="eyebrow">{{ snapshot.session.title }}<template v-if="!player"> · Beat {{ snapshot.session.beatNumber }} · Action round {{ snapshot.session.actionRoundNumber }}</template></p><h1>{{ snapshot.session.scene.title }}</h1><p>{{ snapshot.session.scene.description }}</p></div><div v-if="director" class="actions"><a :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button class="secondary" :disabled="busy || Boolean(setup && !setup.started)" @click="setStatus(snapshot.session.status === 'paused' ? 'live' : 'paused')">{{ snapshot.session.status === 'paused' ? 'Resume show' : 'Pause show' }}</button></div><a v-if="player" :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button v-if="player" class="secondary" :disabled="busy" @click="requestPause">Ask for a pause</button></section>
        <section v-if="!seat && !workspace && !preShow && snapshot.facts.length" class="panel" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section>
        <Lobby v-if="view === 'lobby' && (director || player)" :snapshot="director ?? player!" :busy="busy" @command="startOrSend" />
        <PreShow v-else-if="preShow" :snapshot="player!" :busy="busy" @command="command => work(() => send(command))" />
        <section v-else-if="setup && !setup.started && director" class="panel"><p class="eyebrow">Before the show starts</p><h2>Get your cast ready.</h2><p>Every seat needs a card. Start the show from Cast & lobby.</p><a class="button" data-testid="setup-lobby-link" :href="identityPath(`/sessions/${sessionId}/lobby`)">Open cast & lobby</a></section>
        <DirectorWorkspace v-else-if="director" />
        <PlayerSeat v-else-if="player" />
        <section v-else class="panel"><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /></section>
      </template>
    </main>
  </template>
</template>