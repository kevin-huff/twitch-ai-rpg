<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { StreamLinkSummary } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import StreamLinkCard from './StreamLinkCard.vue';

const props = defineProps<{ sessionId: string; ownCharacterId: string }>();
const root = ref<HTMLDetailsElement | null>(null);
const loading = ref(false);
const loaded = ref(false);
const working = ref(false);
const loadError = ref('');
const actionError = ref('');
const link = ref<StreamLinkSummary | null>(null);
const token = ref('');
const turnedOff = ref(false);

const isActive = (item: { revokedAt: string | null; expiresAt: string }) => item.revokedAt === null && Date.parse(item.expiresAt) > Date.now();

async function load() {
  if (loading.value) return;
  loading.value = true; loadError.value = '';
  try {
    const existing = (await api.streamLinks(props.sessionId)).links
      .find(item => item.subject === 'player' && item.characterId === props.ownCharacterId && isActive(item));
    const shown = existing ? await api.streamLink(props.sessionId, existing.id) : await api.createStreamLink(props.sessionId, { subject: 'player', characterId: props.ownCharacterId });
    link.value = shown.link; token.value = shown.token; turnedOff.value = false; loaded.value = true;
  } catch {
    loadError.value = 'Your stream link could not be loaded. Try again in a moment.';
  } finally { loading.value = false; }
}

function ensureLoaded() { if (!loaded.value && !loadError.value && !loading.value) void load(); }

function onToggle() {
  if (root.value?.open) ensureLoaded();
}

async function turnOff() {
  if (!link.value || working.value) return;
  working.value = true; actionError.value = '';
  try {
    await api.revokeStreamLink(props.sessionId, link.value.id);
    link.value = null; token.value = ''; turnedOff.value = true;
  } catch { actionError.value = 'This link could not be turned off. Try again.'; }
  finally { working.value = false; }
}

async function makeNew() {
  if (working.value) return;
  working.value = true; actionError.value = '';
  try {
    const created = await api.createStreamLink(props.sessionId, { subject: 'player', characterId: props.ownCharacterId });
    link.value = created.link; token.value = created.token; turnedOff.value = false;
  } catch { actionError.value = 'Your link could not be created. Try again.'; }
  finally { working.value = false; }
}

async function openFromHash() {
  if (window.location.hash !== '#my-stream-view' || !root.value) return;
  root.value.open = true;
  ensureLoaded();
  await nextTick();
  root.value?.scrollIntoView?.({ block: 'start' });
}

onMounted(() => { window.addEventListener('hashchange', openFromHash); void openFromHash(); });
onBeforeUnmount(() => window.removeEventListener('hashchange', openFromHash));
</script>

<template>
  <details id="my-stream-view" ref="root" class="lobby-section" data-testid="my-stream-view" @toggle="onToggle">
    <summary>Stream this show</summary>
    <p>Make your own link to show the stage in OBS or another browser. It can listen to the narration but never carries the show audio.</p>
    <p><a :href="identityPath('/help#streaming-your-own-obs')">OBS setup guide</a></p>
    <p v-if="loading" role="status">Loading your link…</p>
    <div v-else-if="loadError" role="alert">
      <p>{{ loadError }}</p>
      <button type="button" class="secondary" @click="load">Try again</button>
    </div>
    <template v-else>
      <StreamLinkCard v-if="link && token" :link="link" :token="token" title="Your own stream link" :busy="working" testid="stream-row-own" @turn-off="turnOff" />
      <div v-else-if="turnedOff" data-testid="stream-row-own-off">
        <p>Turned off.</p>
        <button type="button" class="secondary" data-testid="make-new-link" :disabled="working" @click="makeNew">Make a new link</button>
      </div>
      <p v-if="actionError" role="alert">{{ actionError }}</p>
    </template>
  </details>
</template>
