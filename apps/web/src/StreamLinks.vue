<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ProducerSummary, PublicCharacter, StreamLinkSummary } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import MyStreamLink from './MyStreamLink.vue';
import StreamLinkCard from './StreamLinkCard.vue';

const props = withDefaults(defineProps<{ sessionId: string; characters: PublicCharacter[]; mode?: 'director' | 'player'; ownCharacterId?: string }>(), { mode: 'director', ownCharacterId: undefined });
const isPlayer = computed(() => props.mode === 'player');
const root = ref<HTMLDetailsElement | null>(null);
const started = ref(false);
const loading = ref(false);
const working = ref(false);
const loadError = ref('');
const actionError = ref('');
const links = ref<StreamLinkSummary[]>([]);
const producers = ref<ProducerSummary[]>([]);
const viewerGrantId = ref<string | null>(null);
const tokens = ref<Record<string, string>>({});
const turnedOff = ref<string[]>([]);
const failedSubjects = ref<string[]>([]);
const unrevealed = ref<string[]>([]);

const isActive = (item: { revokedAt: string | null; expiresAt: string }) => item.revokedAt === null && Date.parse(item.expiresAt) > Date.now();
const slot = (match: (link: StreamLinkSummary) => boolean) => {
  const matching = links.value.filter(match);
  return matching.find(isActive) ?? [...matching].reverse().find(link => turnedOff.value.includes(link.id)) ?? null;
};
const showLink = computed(() => slot(link => link.subject === 'show'));
const playerLink = (characterId: string) => slot(link => link.subject === 'player' && link.characterId === characterId);
const ownProducerLink = computed(() => viewerGrantId.value ? slot(link => link.subject === 'producer' && link.producerGrantId === viewerGrantId.value) : null);
const otherLinks = computed(() => links.value.filter(link => (link.subject === 'host' || (link.subject === 'producer' && link.producerGrantId !== viewerGrantId.value))
  && (isActive(link) || turnedOff.value.includes(link.id))));
const isOff = (link: StreamLinkSummary) => !isActive(link) && turnedOff.value.includes(link.id);
const otherTitle = (link: StreamLinkSummary) => link.subject === 'host'
  ? 'Host view'
  : `Producer ${producers.value.find(item => item.id === link.producerGrantId)?.label ?? link.label}`.trim();

function remember(link: StreamLinkSummary, token: string) {
  links.value = [...links.value.filter(item => item.id !== link.id), link];
  tokens.value = { ...tokens.value, [link.id]: token };
}

function bodyFor(link: StreamLinkSummary) {
  if (link.subject === 'show') return { subject: 'show' as const };
  if (link.subject === 'host') return { subject: 'host' as const };
  if (link.subject === 'producer') return { subject: 'producer' as const, producerGrantId: link.producerGrantId ?? '' };
  return { subject: 'player' as const, characterId: link.characterId ?? '' };
}

async function load() {
  if (loading.value) return;
  loading.value = true; loadError.value = ''; actionError.value = ''; failedSubjects.value = []; unrevealed.value = [];
  try {
    let producerViewer = false;
    try {
      const viewer = await api.me();
      if (viewer.role === 'producer' && viewer.producer) { producerViewer = true; viewerGrantId.value = viewer.producer.grantId; }
    } catch { /* treat the viewer as the host */ }
    if (!producerViewer) {
      viewerGrantId.value = null;
      try { producers.value = (await api.producers()).producers; } catch { producers.value = []; }
    } else producers.value = [];
    links.value = (await api.streamLinks(props.sessionId)).links;
    const found: Record<string, string> = {};
    await Promise.all(links.value.filter(isActive).map(async link => {
      try { found[link.id] = (await api.streamLink(props.sessionId, link.id)).token; }
      catch { unrevealed.value = [...unrevealed.value, link.id]; }
    }));
    tokens.value = { ...tokens.value, ...found };
    const missing: { key: string; body: ReturnType<typeof bodyFor> }[] = [];
    for (const character of props.characters) {
      if (!playerLink(character.id)) missing.push({ key: `player:${character.id}`, body: { subject: 'player', characterId: character.id } });
    }
    if (viewerGrantId.value && !ownProducerLink.value) missing.push({ key: 'own-producer', body: { subject: 'producer', producerGrantId: viewerGrantId.value } });
    await Promise.all(missing.map(async item => {
      try { const created = await api.createStreamLink(props.sessionId, item.body); remember(created.link, created.token); }
      catch { failedSubjects.value = [...failedSubjects.value, item.key]; }
    }));
  } catch { loadError.value = 'The stream links could not be loaded. Try again in a moment.'; }
  finally { loading.value = false; }
}

function ensureLoaded() {
  if (started.value && !loadError.value) return;
  started.value = true;
  void load();
}

function onToggle() { if (root.value?.open) ensureLoaded(); }

async function guard(task: () => Promise<void>, message: string) {
  working.value = true; actionError.value = '';
  try { await task(); } catch { actionError.value = message; } finally { working.value = false; }
}

const makeShow = () => guard(async () => {
  const created = await api.createStreamLink(props.sessionId, { subject: 'show' });
  remember(created.link, created.token);
}, 'The main show link could not be created. Try again.');

const makeNew = (link: StreamLinkSummary) => guard(async () => {
  const created = await api.createStreamLink(props.sessionId, bodyFor(link));
  remember(created.link, created.token);
}, 'The link could not be created. Try again.');

const retryCreate = (key: string, body: ReturnType<typeof bodyFor>) => guard(async () => {
  const created = await api.createStreamLink(props.sessionId, body);
  remember(created.link, created.token);
  failedSubjects.value = failedSubjects.value.filter(item => item !== key);
}, 'The link could not be created. Try again.');

const reveal = (link: StreamLinkSummary) => guard(async () => {
  const shown = await api.streamLink(props.sessionId, link.id);
  remember(shown.link, shown.token);
  unrevealed.value = unrevealed.value.filter(id => id !== link.id);
}, 'This link could not be shown. Try again.');

const turnOff = (link: StreamLinkSummary) => guard(async () => {
  const revoked = await api.revokeStreamLink(props.sessionId, link.id);
  links.value = links.value.map(item => item.id === revoked.id ? revoked : item);
  const { [link.id]: _gone, ...rest } = tokens.value; tokens.value = rest;
  turnedOff.value = [...turnedOff.value, link.id];
}, 'This link could not be turned off. Try again.');

async function openFromHash() {
  if (isPlayer.value || window.location.hash !== '#stage-links' || !root.value) return;
  root.value.open = true;
  ensureLoaded();
  await nextTick();
  root.value?.scrollIntoView?.({ block: 'start' });
}

function onDocumentClick(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor) return;
  const url = new URL(anchor.href, window.location.href);
  if (url.hash !== '#stage-links' || url.pathname !== window.location.pathname) return;
  setTimeout(() => { void openFromHash(); }, 0);
}

onMounted(() => {
  window.addEventListener('hashchange', openFromHash);
  document.addEventListener('click', onDocumentClick);
  void openFromHash();
});
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', openFromHash);
  document.removeEventListener('click', onDocumentClick);
});
</script>

<template>
  <MyStreamLink v-if="isPlayer && ownCharacterId" :session-id="sessionId" :own-character-id="ownCharacterId" />
  <details v-else-if="!isPlayer" id="stage-links" ref="root" class="lobby-section" data-testid="stream-setup" @toggle="onToggle">
    <summary>Stream this show</summary>
    <p>Paste one of these links into an OBS browser source. Each link keeps working through reloads until you turn it off.</p>
    <p><a :href="identityPath('/help#stage-and-obs')">OBS setup guide</a></p>
    <p v-if="loading" class="muted">Loading links…</p>
    <div v-if="loadError" class="notice error" role="alert">
      <p>{{ loadError }}</p>
      <button type="button" class="secondary" data-testid="stream-links-retry" @click="load">Try again</button>
    </div>
    <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
    <div v-if="started && !loading && !loadError" class="links-body">
      <section aria-labelledby="stream-group-show" class="group">
        <h4 id="stream-group-show">For your stream</h4>
        <template v-if="showLink">
          <div v-if="isOff(showLink)" class="off-row" data-testid="stream-row-show">
            <strong>Main show link</strong>
            <p>Turned off.</p>
            <button type="button" class="secondary" :data-testid="`make-new-link-${showLink.id}`" :disabled="working" @click="makeNew(showLink)">Make a new link</button>
          </div>
          <StreamLinkCard v-else-if="tokens[showLink.id]" :link="showLink" :token="tokens[showLink.id]!" title="Main show link" :busy="working" testid="stream-row-show" @turn-off="turnOff(showLink)" />
          <div v-else class="off-row" data-testid="stream-row-show">
            <strong>Main show link</strong>
            <p>This link could not be shown.</p>
            <button type="button" class="secondary" :disabled="working" @click="reveal(showLink)">Try again</button>
          </div>
        </template>
        <button v-else type="button" data-testid="make-show-link" :disabled="working" @click="makeShow">Make the main show link</button>
      </section>
      <section aria-labelledby="stream-group-cast" class="group">
        <h4 id="stream-group-cast">For a cast member's own stream</h4>
        <p v-if="!characters.length && !otherLinks.length" class="muted">No cast members yet.</p>
        <template v-for="character in characters" :key="character.id">
          <template v-if="playerLink(character.id)">
            <div v-if="isOff(playerLink(character.id)!)" class="off-row" :data-testid="`stream-row-player-${character.id}`">
              <strong>{{ character.displayName }}</strong>
              <p>Turned off.</p>
              <button type="button" class="secondary" :data-testid="`make-new-link-${playerLink(character.id)!.id}`" :disabled="working" @click="makeNew(playerLink(character.id)!)">Make a new link</button>
            </div>
            <StreamLinkCard v-else-if="tokens[playerLink(character.id)!.id]" :link="playerLink(character.id)!" :token="tokens[playerLink(character.id)!.id]!" :title="character.displayName" :busy="working" :testid="`stream-row-player-${character.id}`" @turn-off="turnOff(playerLink(character.id)!)" />
            <div v-else class="off-row" :data-testid="`stream-row-player-${character.id}`">
              <strong>{{ character.displayName }}</strong>
              <p>This link could not be shown.</p>
              <button type="button" class="secondary" :disabled="working" @click="reveal(playerLink(character.id)!)">Try again</button>
            </div>
          </template>
          <div v-else class="off-row" :data-testid="`stream-row-player-${character.id}`">
            <strong>{{ character.displayName }}</strong>
            <p v-if="failedSubjects.includes(`player:${character.id}`)">This link could not be created.</p>
            <button type="button" class="secondary" :disabled="working" @click="retryCreate(`player:${character.id}`, { subject: 'player', characterId: character.id })">{{ failedSubjects.includes(`player:${character.id}`) ? 'Try again' : 'Make a link' }}</button>
          </div>
        </template>
        <template v-for="link in otherLinks" :key="link.id">
          <div v-if="isOff(link)" class="off-row" :data-testid="link.subject === 'host' ? 'stream-row-host' : `stream-row-producer-${link.producerGrantId}`">
            <strong>{{ otherTitle(link) }}</strong>
            <p>Turned off.</p>
            <button type="button" class="secondary" :data-testid="`make-new-link-${link.id}`" :disabled="working" @click="makeNew(link)">Make a new link</button>
          </div>
          <StreamLinkCard v-else-if="tokens[link.id]" :link="link" :token="tokens[link.id]!" :title="otherTitle(link)" :busy="working" :testid="link.subject === 'host' ? 'stream-row-host' : `stream-row-producer-${link.producerGrantId}`" @turn-off="turnOff(link)" />
          <div v-else class="off-row" :data-testid="link.subject === 'host' ? 'stream-row-host' : `stream-row-producer-${link.producerGrantId}`">
            <strong>{{ otherTitle(link) }}</strong>
            <p>This link could not be shown.</p>
            <button type="button" class="secondary" :disabled="working" @click="reveal(link)">Try again</button>
          </div>
        </template>
      </section>
      <section v-if="viewerGrantId" aria-labelledby="stream-group-own" class="group">
        <h4 id="stream-group-own">For your own stream</h4>
        <template v-if="ownProducerLink">
          <div v-if="isOff(ownProducerLink)" class="off-row" data-testid="stream-row-own-producer">
            <strong>Your own stream link</strong>
            <p>Turned off.</p>
            <button type="button" class="secondary" :data-testid="`make-new-link-${ownProducerLink.id}`" :disabled="working" @click="makeNew(ownProducerLink)">Make a new link</button>
          </div>
          <StreamLinkCard v-else-if="tokens[ownProducerLink.id]" :link="ownProducerLink" :token="tokens[ownProducerLink.id]!" title="Your own stream link" :busy="working" testid="stream-row-own-producer" @turn-off="turnOff(ownProducerLink)" />
          <div v-else class="off-row" data-testid="stream-row-own-producer">
            <strong>Your own stream link</strong>
            <p>This link could not be shown.</p>
            <button type="button" class="secondary" :disabled="working" @click="reveal(ownProducerLink)">Try again</button>
          </div>
        </template>
        <div v-else class="off-row" data-testid="stream-row-own-producer">
          <strong>Your own stream link</strong>
          <p v-if="failedSubjects.includes('own-producer')">This link could not be created.</p>
          <button type="button" class="secondary" :disabled="working" @click="retryCreate('own-producer', { subject: 'producer', producerGrantId: viewerGrantId })">{{ failedSubjects.includes('own-producer') ? 'Try again' : 'Make a link' }}</button>
        </div>
      </section>
    </div>
  </details>
</template>

<style scoped>
.lobby-section { border-top: 2px solid var(--night-raised); margin-top: 40px; padding-top: 30px; }
.links-body { margin-top: 20px; display: grid; gap: 24px; }
.group { display: grid; gap: 16px; justify-items: start; }
.group h4 { margin: 0; }
.group > :deep(.stream-card), .off-row { width: 100%; }
.off-row { position: relative; padding: 20px; display: grid; gap: 8px; justify-items: start; }
.off-row::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.off-row p { margin: 0; }
</style>
