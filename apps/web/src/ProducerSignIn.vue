<script setup lang="ts">
import { ref } from 'vue';
import { api } from './api';
import { identityPath } from './identity';
import { readHashToken } from './stream';
import ErrorNotice from './ErrorNotice.vue';

const token = readHashToken(window.location.hash);
if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);

const busy = ref(false);
const error = ref('');

async function signIn() {
  if (!token || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.producerSignIn(token);
    let target = identityPath('/');
    try {
      const shows = await api.sessions();
      if (shows.length === 1) target = identityPath(`/sessions/${shows[0].id}/director`);
    } catch { /* go home */ }
    window.location.replace(target);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Producer sign-in failed. Ask the host for a new link.';
    busy.value = false;
  }
}
</script>

<template>
    <section class="welcome-copy">
      <p class="eyebrow">Producer access</p>
      <template v-if="token">
        <h1>Welcome, <em>producer.</em></h1>
        <p>You have been given producer access. You can run every show, edit the library and manage invitations until the host ends your access.</p>
        <button type="button" :disabled="busy" @click="signIn">{{ busy ? 'Signing in…' : 'Sign in as producer' }}</button>
        <p class="muted">Keep this link private. Open it again if you are ever signed out.</p>
      </template>
      <template v-else>
        <h1>Producer <em>sign-in.</em></h1>
        <p>Open the producer link your host sent you.</p>
      </template>
    </section>
    <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
</template>
