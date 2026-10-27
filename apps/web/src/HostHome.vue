<script setup lang="ts">
import { nextTick, onMounted, ref, useId, watch } from 'vue';
import type { InvitePreviewResponse, SessionListEntry, Viewer } from '@rpg/contracts';
import { api, ApiError } from './api';
import { identityPath } from './identity';
import { navigate } from './navigate';
import { useTable } from './table';
import ErrorNotice from './ErrorNotice.vue';
import ProducerAccess from './ProducerAccess.vue';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const { inviteToken, error, busy, work } = useTable();
const hostToken = ref('');
const hostReady = ref(false);
const recentSessions = ref<SessionListEntry[]>([]);
const viewer = ref<Viewer | null>(null);
const preview = ref<InvitePreviewResponse | null>(null);
const previewState = ref<'loading' | 'ready' | 'invalid' | 'failed'>('loading');
let viewerRequested = false;

async function loadViewer() {
  if (viewerRequested) return;
  viewerRequested = true;
  try { viewer.value = await api.me(); } catch { viewer.value = null; }
}
watch(hostReady, ready => { if (ready) void loadViewer(); }, { immediate: true });

function login() { return work(async () => { await api.login(hostToken.value); hostToken.value = ''; hostReady.value = true; recentSessions.value = await api.sessions(); }); }
function tryItNow() { return work(async () => {
  const result = await api.create('The Ledger Job');
  navigate(`/sessions/${encodeURIComponent(result.sessionId)}/director`);
}); }
function join() { return work(async () => {
  const result = await api.redeem(inviteToken);
  navigate(`/sessions/${encodeURIComponent(result.sessionId)}/${result.role === 'stage' ? 'stage' : 'play'}`, { replace: true });
}); }
async function loadPreview() {
  try {
    preview.value = await api.invitePreview(inviteToken);
    previewState.value = 'ready';
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 401) {
      previewState.value = 'invalid';
    } else {
      previewState.value = 'failed';
      error.value = caught instanceof Error ? caught.message : 'The invitation could not be checked. Try again.';
    }
  }
}
const linkFallbackId = ref<string | null>(null);
const linkFallbackBox = ref<HTMLInputElement[] | HTMLInputElement | null>(null);
async function copyGalleryLink(session: SessionListEntry) {
  const url = session.gallery?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    linkFallbackId.value = null;
  } catch {
    linkFallbackId.value = session.id;
    await nextTick();
    const box = Array.isArray(linkFallbackBox.value) ? linkFallbackBox.value[0] : linkFallbackBox.value;
    box?.select();
  }
}

onMounted(async () => {
  if (inviteToken) {
    await loadPreview();
  } else {
    try { recentSessions.value = await api.sessions(); hostReady.value = true; } catch { /* A host signs in before accessing saved sessions. */ }
  }
});
</script>

<template>
  <main class="welcome">
    <section class="panel">
      <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
      <template v-if="inviteToken">
        <template v-if="previewState === 'invalid'"><p class="muted" role="alert" data-testid="invite-error">This invitation has already been used or has expired. Ask your host for a new link.</p></template>
        <template v-else-if="previewState === 'loading'"><p class="muted">Checking your invitation…</p></template>
        <template v-else>
          <h2 v-if="preview">{{ preview.role === 'stage' ? `You've been invited to open the stage for ${preview.title}.` : `You've been invited to play ${preview.title}.` }}</h2>
          <p v-if="preview" class="muted">{{ preview.role === 'stage' ? 'Press Join to open the stage.' : 'Press Join to take your seat.' }}</p>
          <button data-testid="join" :disabled="busy" @click="join">{{ busy ? 'Joining…' : 'Join' }}</button>
        </template>
      </template>
      <template v-else-if="!hostReady"><p class="muted">The Story Table runs live roleplay shows: your cast sends lines from their seats, the AI voices everyone else, and you review every beat before the audience sees it.</p><p class="eyebrow">Host access</p><h2>Bring the table together.</h2><form @submit.prevent="login"><label>Host access token<input :aria-describedby="helpId('host-token')" v-model="hostToken" type="password" autocomplete="current-password" required placeholder="Enter your configured host token"></label><p :id="helpId('host-token')" class="field-help">Use the configured host token to manage shows. Players join through their own invitations.</p><button :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in as host' }}</button><small>Your host token is configured on the server. Players join through their own invitations.</small></form><p class="muted">Producers: open the link your host sent you.</p></template>
      <template v-else><p class="eyebrow">{{ viewer?.role === 'producer' ? 'Producer workspace' : 'Host workspace' }}</p><h2>Set the scene.</h2><p v-if="viewer?.role === 'producer'" class="muted">You have producer access. You can run every show, edit the library and manage invitations until the host ends your access.</p><div v-if="viewer?.role === 'producer'" data-testid="shows-you-can-run"><h3>Shows you can run</h3><p v-if="!recentSessions.length" class="muted">No shows yet.</p><p v-for="session in recentSessions" :key="session.id">{{ session.title }} <a :href="identityPath(`/sessions/${session.id}/director`)" :data-testid="`open-director-${session.id}`">Open the director page</a></p></div><p><button type="button" data-testid="try-it-now" :disabled="busy" @click="tryItNow">{{ busy ? 'Starting…' : 'Try it now' }}</button> <a class="button" data-testid="make-a-show" :href="identityPath('/make')">Make a show</a></p><p><a class="quiet" data-testid="library-link" :href="identityPath('/library')">Library & custom shows</a></p><div v-if="viewer?.role !== 'producer' && recentSessions.length"><h3 style="margin-top: 2rem">Your shows</h3><p v-for="session in recentSessions" :key="session.id">{{ session.title }} <a :href="identityPath(`/sessions/${session.id}/director`)" :data-testid="`open-director-${session.id}`">Open the director page</a><template v-if="session.status === 'ended' && session.gallery"> <span class="gallery-tag" data-testid="session-gallery-tag"><span data-testid="session-gallery-label">{{ session.gallery.listed ? 'Gallery: on the public list' : 'Gallery: link only' }}</span> <button type="button" class="quiet" data-testid="session-gallery-copy" @click="copyGalleryLink(session)">Copy link</button></span><input v-if="linkFallbackId === session.id" ref="linkFallbackBox" class="gallery-url" data-testid="session-gallery-url" :value="session.gallery.url" readonly aria-label="Gallery link"></template></p></div><details v-if="viewer?.role === 'host'" data-testid="home-more"><summary>More</summary><ProducerAccess /></details></template>
    </section>
  </main>
</template>

<style scoped>
.gallery-tag { display: inline-flex; align-items: center; gap: 0.5rem; margin-left: 0.5rem; font-size: 0.85em; opacity: 0.85; }
.gallery-url { margin-left: 0.5rem; min-width: 18rem; }
</style>
