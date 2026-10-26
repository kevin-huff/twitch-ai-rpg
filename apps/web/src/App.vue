<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { identityPath } from './identity';
import { createTable, provideTable } from './table';
import Story from './Story.vue';
import StageView from './StageView.vue';
import HostHome from './HostHome.vue';
import PlayerSeat from './PlayerSeat.vue';
import DirectorWorkspace from './DirectorWorkspace.vue';
import Library from './Library.vue';
import PlayerBuilder from './PlayerBuilder.vue';
import ErrorNotice from './ErrorNotice.vue';
import Lobby from './Lobby.vue';
import HelpPage from './HelpPage.vue';
import ProducerSignIn from './ProducerSignIn.vue';
import { api } from './api';

const table = createTable();
provideTable(table);
const { path, sessionId, view, stage, inviteToken, testCharacterId, snapshot, error, notice, loading, busy, connected, director, player, setup, latestHistory, work, send, restoreSession, dispose, requestPause, setStatus } = table;

const seat = computed(() => view !== 'lobby' && !(setup.value && !setup.value.started) && !director.value && Boolean(player.value));
const workspace = computed(() => view !== 'lobby' && !(setup.value && !setup.value.started) && Boolean(director.value));

const helpRoute = path === '/help' || path.startsWith('/help/');
const producerRoute = path === '/producer' || path === '/producer/';
const producerLabel = ref<string | null>(null);
const roleLabel = computed(() => producerLabel.value !== null ? `Producer · ${producerLabel.value}` : director.value ? 'Director workspace' : player.value ? 'Player seat' : 'A shared live story');

async function loadViewer() {
  try {
    const viewer = await api.me();
    producerLabel.value = viewer.producer ? viewer.producer.label : null;
  } catch { producerLabel.value = null; }
}

onMounted(async () => {
  if (helpRoute || producerRoute) return;
  if (path === '/library' || path === '/build-character') { loading.value = false; return; }
  if (!inviteToken && (!sessionId || view === 'director')) void loadViewer();
  if (sessionId) await restoreSession();
  else loading.value = false;
});
onUnmounted(dispose);
</script>

<template>
  <StageView v-if="stage" />
  <template v-else>
    <header class="app-header"><span v-if="path === '/build-character'" class="brand"><span class="brand-mark">S</span> THE STORY TABLE</span><a v-else class="brand" :href="identityPath('/')"><span class="brand-mark">S</span> THE STORY TABLE</a><div class="header-meta"><a :href="identityPath('/help')">Help</a><span class="role-label">{{ roleLabel }}</span><span v-if="sessionId" class="status" :class="{ offline: !connected }">{{ connected ? 'Connected' : 'Reconnecting' }}</span><a v-if="director" :href="identityPath(`/sessions/${sessionId}/stage`)" target="_blank" rel="noopener">Open stage ↗</a></div></header>
    <main v-if="producerRoute" class="welcome"><ProducerSignIn /></main><HelpPage v-else-if="helpRoute" />
    <PlayerBuilder v-else-if="path === '/build-character'" /><Library v-else-if="path === '/library'" /><HostHome v-else-if="!sessionId" />
    <main v-else class="shell" :data-view="view">
      <ErrorNotice v-if="error" :message="error" @dismiss="error = ''"><button type="button" class="quiet" :disabled="busy" @click="restoreSession">{{ testCharacterId !== null ? 'Retry opening seat' : 'Refresh state' }}</button></ErrorNotice>
      <div v-if="notice" class="notice" role="status">{{ notice }}</div>
      <div v-if="loading" class="loading">Restoring the table…</div>
      <template v-if="snapshot">
        <div v-if="!connected" class="notice">{{ !director && player ? 'Connection lost. Your unsent words stay in this browser. The page reconnects by itself and never sends anything for you.' : 'Connection interrupted. Unsaved words stay in this browser. Reconnect refreshes the table; it never sends them.' }}</div>
        <div v-if="snapshot.session.status === 'paused' && !seat" class="notice">{{ player ? 'The show is paused. The director will start again soon.' : 'The table is paused. Check in with the cast before continuing.' }}</div>
        <section v-if="!seat && !workspace" class="scene-heading"><div><p class="eyebrow">{{ snapshot.session.title }}<template v-if="!player"> · Beat {{ snapshot.session.beatNumber }} · Action round {{ snapshot.session.actionRoundNumber }}</template></p><h1>{{ snapshot.session.scene.title }}</h1><p>{{ snapshot.session.scene.description }}</p></div><div v-if="director" class="actions"><a :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button class="secondary" :disabled="busy || Boolean(setup && !setup.started)" @click="setStatus(snapshot.session.status === 'paused' ? 'live' : 'paused')">{{ snapshot.session.status === 'paused' ? 'Resume table' : 'Pause table' }}</button></div><a v-if="player" :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button v-if="player" class="secondary" :disabled="busy" @click="requestPause">Ask for a pause</button></section>
        <section v-if="!seat && !workspace && snapshot.facts.length" class="panel" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section>
        <Lobby v-if="view === 'lobby' && (director || player)" :snapshot="director ?? player!" :busy="busy" @command="command => work(() => send(command))" />
        <section v-else-if="setup && !setup.started" class="panel"><p class="eyebrow">Before the story begins</p><template v-if="director"><h2>Review your cast and boundaries.</h2><p>The director starts this session after character approval and player readiness.</p></template><template v-else><h2>The show has not started yet.</h2><p>Open Cast & lobby. Write your character card or check the one you were given, and press Submit card for approval if you change it. When the director approves it, tick the box and press Mark ready.</p></template><a class="button" data-testid="setup-lobby-link" :href="identityPath(`/sessions/${sessionId}/lobby`)">{{ director ? 'Open cast & lobby' : 'Open Cast & lobby' }}</a></section>
        <DirectorWorkspace v-else-if="director" />
        <PlayerSeat v-else-if="player" />
        <section v-else class="panel"><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /></section>
      </template>
    </main>
  </template>
</template>