<script setup lang="ts">
import { onMounted, ref, useId, watch } from 'vue';
import type { CreateSessionResponse, Viewer } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import { useTable } from './table';
import ErrorNotice from './ErrorNotice.vue';
import FieldGenerator from './FieldGenerator.vue';
import ProducerAccess from './ProducerAccess.vue';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const { inviteToken, error, busy, work } = useTable();
const hostToken = ref('');
const hostReady = ref(false);
const title = ref('The Ledger Job');
const recentSessions = ref<Array<{ id: string; title: string }>>([]);
const created = ref<CreateSessionResponse | null>(null);
const viewer = ref<Viewer | null>(null);
let viewerRequested = false;

async function loadViewer() {
  if (viewerRequested) return;
  viewerRequested = true;
  try { viewer.value = await api.me(); } catch { viewer.value = null; }
}
watch(hostReady, ready => { if (ready) void loadViewer(); }, { immediate: true });

function login() { return work(async () => { await api.login(hostToken.value); hostToken.value = ''; hostReady.value = true; recentSessions.value = await api.sessions(); }); }
function createSession() { return work(async () => { created.value = await api.create(title.value); recentSessions.value = await api.sessions(); }); }
function join() { return work(async () => {
  const result = await api.redeem(inviteToken);
  window.location.replace(identityPath(`/sessions/${encodeURIComponent(result.sessionId)}/${result.role === 'stage' ? 'stage' : 'play'}`));
}); }
const invitationUrl = (token: string) => `${window.location.origin}/join/${encodeURIComponent(token)}`;

onMounted(async () => {
  if (!inviteToken) {
    try { recentSessions.value = await api.sessions(); hostReady.value = true; } catch { /* A host signs in before accessing saved sessions. */ }
  }
});
</script>

<template>
  <main class="welcome">
    <section class="welcome-copy"><p class="eyebrow">Four players. One missing ledger.</p><h1>A good story<br>needs <em>accomplices.</em></h1><p>A members-only club. A bartender who knows too much. Your cast writes the choices; the world answers back.</p><p class="welcome-note">The Ledger Job · Original rehearsal scenario<br>Human-directed storytelling · Server dice · Reviewed publication</p></section>
    <section class="panel">
      <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
      <template v-if="inviteToken"><p class="eyebrow">An invitation to the table</p><h2>Your seat is waiting.</h2><p class="muted">Redeem this invitation to enter your assigned player seat or the read-only stage. Your invitation will leave the address bar.</p><button :disabled="busy" @click="join">{{ busy ? 'Joining…' : 'Join session' }}</button></template>
      <template v-else-if="!hostReady"><p class="eyebrow">Host access</p><h2>Bring the table together.</h2><form @submit.prevent="login"><label>Host access token<input :aria-describedby="helpId('host-token')" v-model="hostToken" type="password" autocomplete="current-password" required placeholder="Enter your configured host token"></label><p :id="helpId('host-token')" class="field-help">Use the configured host token to manage shows. Players join through their own invitations.</p><button :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in as host' }}</button><small>Your host token is configured on the server. Players join through their own invitations.</small></form><p class="muted">Producers: open the link your host sent you.</p></template>
      <template v-else-if="created"><p class="eyebrow">Your table is ready</p><h2>{{ title }}</h2><p class="muted">Copy each invitation for its intended player. The stage invitation has read-only access.</p><div class="invites"><div v-for="(invite, index) in created.invites" :key="invite.token"><label class="invite">{{ invite.role === 'stage' ? 'Broadcast stage' : `Player ${index + 1}` }}<input :aria-describedby="helpId('invite', invite.token)" :value="invitationUrl(invite.token)" readonly @focus="($event.target as HTMLInputElement).select()" :aria-label="invite.role === 'stage' ? 'Stage invitation' : `Player ${index + 1} invitation`"></label><p :id="helpId('invite', invite.token)" class="field-help">Save this link now; it is displayed once and can be redeemed once by its intended player or stage viewer.</p></div></div><p class="muted"><small>Save these invitation links now. They are displayed once.</small></p><a class="button" :href="identityPath(`/sessions/${created.sessionId}/director`)">Enter director workspace</a></template>
      <template v-else><p class="eyebrow">{{ viewer?.role === 'producer' ? 'Producer workspace' : 'Host workspace' }}</p><h2>Set the scene.</h2><p v-if="viewer?.role === 'producer'" class="muted">You have producer access. You can run every show, edit the library and manage invitations until the host ends your access.</p><p><a class="button" data-testid="library-link" :href="identityPath('/library')">Library & custom shows</a></p><p class="muted">Players can write their own characters. When you create a custom show in Library & custom shows, choose Player writes their own character for their seat.</p><p class="muted">Or start the four-player Ledger Job rehearsal below.</p><form @submit.prevent="createSession"><label>Session title<input :aria-describedby="helpId('title')" v-model="title" maxlength="160" required></label><p :id="helpId('title')" class="field-help">Name this particular rehearsal session so you can find and resume the show later.</p><FieldGenerator v-model="title" field="session.title" context-key="host-rehearsal" :disabled="busy" /><button :disabled="busy">{{ busy ? 'Creating…' : 'Create rehearsal session' }}</button></form><div v-if="recentSessions.length"><h3 style="margin-top: 2rem">Resume a saved session</h3><p v-for="session in recentSessions" :key="session.id"><a :href="identityPath(`/sessions/${session.id}/director`)">{{ session.title }} →</a></p></div><ProducerAccess v-if="viewer?.role === 'host'" /></template>
    </section>
  </main>
</template>
