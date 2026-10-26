<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import type { ProducerSummary, PublicCharacter, StreamAudio, StreamLayout, StreamLinkSummary } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import { streamUrl } from './stream';

const props = withDefaults(defineProps<{ sessionId: string; characters: PublicCharacter[]; mode?: 'director' | 'player'; ownCharacterId?: string }>(), { mode: 'director', ownCharacterId: undefined });
const isPlayer = computed(() => props.mode === 'player');
const prefix = useId();
const fieldId = (key: string) => `${prefix}-${key}`;
const open = ref(false);
const loading = ref(false);
const working = ref(false);
const loadError = ref('');
const actionError = ref('');
const links = ref<StreamLinkSummary[]>([]);
const producers = ref<ProducerSummary[]>([]);
const viewerGrantId = ref<string | null>(null);
const tokens = ref<Record<string, string>>({});
const layouts = ref<Record<string, StreamLayout>>({});
const audios = ref<Record<string, StreamAudio>>({});
const confirming = ref('');
const copied = ref('');
const copyFailed = ref('');
const section = ref<HTMLElement | null>(null);
const target = ref('you');
const urlInputs = new Map<string, HTMLInputElement>();

const isActive = (item: { revokedAt: string | null; expiresAt: string }) => item.revokedAt === null && Date.parse(item.expiresAt) > Date.now();
const activeLinks = computed(() => links.value.filter(isActive));
const ownLink = computed(() => activeLinks.value.find(link => link.subject === 'player' && !!props.ownCharacterId && link.characterId === props.ownCharacterId));
const hasShowLink = computed(() => activeLinks.value.some(link => link.subject === 'show'));
const activeProducers = computed(() => producers.value.filter(isActive));
const layoutOf = (link: StreamLinkSummary): StreamLayout => layouts.value[link.id] ?? 'scene';
const audioOf = (link: StreamLinkSummary): StreamAudio => audios.value[link.id] ?? (link.canPresent ? 'present' : 'listen');
const urlOf = (link: StreamLinkSummary) => {
  const token = tokens.value[link.id];
  return token ? streamUrl(window.location.origin, token, { layout: layoutOf(link), audio: audioOf(link) }) : '';
};
const ownerOf = (link: StreamLinkSummary) => {
  if (link.subject === 'show') return 'The whole show';
  if (link.subject === 'host') return 'Host';
  if (link.subject === 'producer') return `Producer ${producers.value.find(item => item.id === link.producerGrantId)?.label ?? ''}`.trim();
  return `Player ${props.characters.find(item => item.id === link.characterId)?.displayName ?? ''}`.trim();
};

async function toggle() {
  open.value = !open.value;
  if (open.value && !loading.value && !links.value.length && !loadError.value) await load();
  else if (open.value && loadError.value) await load();
}

async function load() {
  loading.value = true; loadError.value = '';
  if (isPlayer.value) {
    try { links.value = (await api.streamLinks(props.sessionId)).links; }
    catch { loadError.value = 'Your stream view could not be loaded. Try again in a moment.'; }
    finally { loading.value = false; }
    return;
  }
  let producerViewer = false;
  try {
    const viewer = await api.me();
    if (viewer.role === 'producer' && viewer.producer) { producerViewer = true; viewerGrantId.value = viewer.producer.grantId; }
  } catch { /* treat the viewer as the host */ }
  if (!producerViewer) {
    viewerGrantId.value = null;
    try { producers.value = (await api.producers()).producers; } catch { producers.value = []; }
  } else producers.value = [];
  try { links.value = (await api.streamLinks(props.sessionId)).links; }
  catch { loadError.value = 'The stream links could not be loaded. Try again in a moment.'; }
  finally { loading.value = false; }
}

function remember(link: StreamLinkSummary, token: string) {
  links.value = [link, ...links.value.filter(item => item.id !== link.id)];
  tokens.value = { ...tokens.value, [link.id]: token };
}

async function guard(task: () => Promise<void>, message: string) {
  working.value = true; actionError.value = '';
  try { await task(); } catch { actionError.value = message; } finally { working.value = false; }
}

const createShow = () => guard(async () => {
  const created = await api.createStreamLink(props.sessionId, { subject: 'show' });
  remember(created.link, created.token);
}, 'The main show link could not be created. Try again.');

const createPersonal = () => guard(async () => {
  const [kind, ...rest] = target.value.split(':');
  const value = rest.join(':');
  const created = kind === 'player'
    ? await api.createStreamLink(props.sessionId, { subject: 'player', characterId: value })
    : kind === 'producer'
      ? await api.createStreamLink(props.sessionId, { subject: 'producer', producerGrantId: value })
      : kind === 'you' && viewerGrantId.value
        ? await api.createStreamLink(props.sessionId, { subject: 'producer', producerGrantId: viewerGrantId.value })
        : await api.createStreamLink(props.sessionId, { subject: 'host' });
  remember(created.link, created.token);
}, 'The link could not be created. Try again.');

const createOwn = () => guard(async () => {
  if (!props.ownCharacterId) return;
  const created = await api.createStreamLink(props.sessionId, { subject: 'player', characterId: props.ownCharacterId });
  remember(created.link, created.token);
}, 'Your link could not be created. Try again.');

const reveal = (link: StreamLinkSummary) => guard(async () => {
  const shown = await api.streamLink(props.sessionId, link.id);
  remember(shown.link, shown.token);
}, 'This link could not be shown. Try again.');

const revoke = (link: StreamLinkSummary) => guard(async () => {
  const revoked = await api.revokeStreamLink(props.sessionId, link.id);
  links.value = links.value.map(item => item.id === revoked.id ? revoked : item);
  const { [link.id]: _gone, ...rest } = tokens.value; tokens.value = rest;
  confirming.value = '';
}, 'This link could not be turned off. Try again.');

async function copy(link: StreamLinkSummary) {
  const url = urlOf(link); if (!url) return;
  let done = false;
  try { await navigator.clipboard.writeText(url); done = true; }
  catch {
    const input = urlInputs.get(link.id);
    if (input) {
      input.select();
      try { done = document.execCommand('copy') === true; } catch { done = false; }
    }
  }
  copied.value = done ? link.id : '';
  copyFailed.value = done ? '' : link.id;
}

const copyNote = (link: StreamLinkSummary) => copied.value === link.id ? 'Copied' : copyFailed.value === link.id ? 'Copy failed. Select the link and copy it.' : '';

onMounted(async () => {
  if (isPlayer.value || window.location.hash !== '#stage-links') return;
  await toggle();
  await nextTick();
  section.value?.scrollIntoView?.({ block: 'start' });
});

function preview(link: StreamLinkSummary) {
  const token = tokens.value[link.id]; if (!token) return;
  window.open(streamUrl(window.location.origin, token, { layout: layoutOf(link), audio: 'off' }), '_blank', 'noopener');
}

const setLayout = (link: StreamLinkSummary, value: string) => { layouts.value = { ...layouts.value, [link.id]: value === 'overlay' ? 'overlay' : 'scene' }; copied.value = ''; copyFailed.value = ''; };
const setAudio = (link: StreamLinkSummary, value: string) => { audios.value = { ...audios.value, [link.id]: value === 'present' || value === 'off' ? value : 'listen' }; copied.value = ''; copyFailed.value = ''; };
const bindInput = (id: string) => (element: unknown) => { if (element instanceof HTMLInputElement) urlInputs.set(id, element); else urlInputs.delete(id); };
</script>

<template>
  <section v-if="isPlayer" id="my-stream-view" class="lobby-section">
    <h3>My stream view</h3>
    <p>Make your own link to show the stage in OBS or another browser. It can listen to the narration but never carries the show audio.</p>
    <p><a :href="identityPath('/help#stage-and-obs')">OBS setup guide</a></p>
    <button class="secondary" type="button" :aria-expanded="open" :aria-controls="fieldId('body')" @click="toggle">{{ open ? 'Hide my stream view' : 'Show my stream view' }}</button>
    <div v-if="open" :id="fieldId('body')" class="links-body">
      <p v-if="loading" class="muted">Loading your stream view…</p>
      <p v-if="loadError" class="notice error" aria-live="polite">{{ loadError }}</p>
      <p v-if="actionError" class="notice error" aria-live="polite">{{ actionError }}</p>
      <template v-if="!loading && !loadError">
        <p class="notice" aria-live="polite">If this seat is also listening, you will hear the narration twice. Choose Off here or mute the seat.</p>
        <div v-if="!ownLink" class="create-row">
          <button type="button" :disabled="working || !ownCharacterId" @click="createOwn">Create my stream link</button>
        </div>
        <article v-else class="link-row">
          <label>Layout
            <select :value="layoutOf(ownLink)" :aria-describedby="fieldId('own-layout-help')" @change="setLayout(ownLink, ($event.target as HTMLSelectElement).value)">
              <option value="scene">Full scene (1920×1080)</option>
              <option value="overlay">Transparent overlay</option>
            </select>
          </label>
          <p :id="fieldId('own-layout-help')" class="field-help">Full scene is a complete 1920×1080 picture. Transparent overlay shows captions, cast and dice over your camera.</p>
          <label>Audio
            <select :value="audioOf(ownLink)" :aria-describedby="fieldId('own-audio-help')" @change="setAudio(ownLink, ($event.target as HTMLSelectElement).value)">
              <option value="listen">Listen only</option>
              <option value="off">Off</option>
            </select>
          </label>
          <p :id="fieldId('own-audio-help')" class="field-help">Listen only plays the narration in step with the show. Off is picture only.</p>
          <template v-if="tokens[ownLink.id]">
            <label>Link address
              <input :ref="bindInput(ownLink.id)" readonly :value="urlOf(ownLink)" :aria-describedby="fieldId('own-url-help')" @focus="($event.target as HTMLInputElement).select()" />
            </label>
            <p :id="fieldId('own-url-help')" class="field-help">Paste into OBS: Sources, +, Browser, URL. Width 1920, height 1080.</p>
          </template>
          <div class="actions">
            <button v-if="!tokens[ownLink.id]" type="button" class="secondary" :disabled="working" @click="reveal(ownLink)">Show link</button>
            <template v-else>
              <button type="button" class="secondary" @click="copy(ownLink)">Copy link</button>
              <button type="button" class="secondary" @click="preview(ownLink)">Open preview</button>
              <span class="copied" aria-live="polite">{{ copyNote(ownLink) }}</span>
            </template>
            <button v-if="confirming !== ownLink.id" type="button" class="quiet" :disabled="working" @click="confirming = ownLink.id">Revoke</button>
          </div>
          <div v-if="confirming === ownLink.id" class="confirm">
            <p>Turn off this link? OBS sources using it switch to a holding screen within seconds.</p>
            <button type="button" :disabled="working" @click="revoke(ownLink)">Turn off link</button>
            <button type="button" class="secondary" @click="confirming = ''">Keep link</button>
          </div>
        </article>
      </template>
    </div>
  </section>
  <section v-else id="stage-links" ref="section" class="lobby-section">
    <h3>Stage &amp; OBS links</h3>
    <p>Paste one of these links into an OBS browser source. Each link keeps working through reloads until you revoke it.</p>
    <p><a :href="identityPath('/help#stage-and-obs')">OBS setup guide</a></p>
    <button class="secondary" type="button" :aria-expanded="open" :aria-controls="fieldId('body')" @click="toggle">{{ open ? 'Hide stage & OBS links' : 'Show stage & OBS links' }}</button>
    <div v-if="open" :id="fieldId('body')" class="links-body">
      <p v-if="loading" class="muted">Loading links…</p>
      <p v-if="loadError" class="notice error" aria-live="polite">{{ loadError }}</p>
      <p v-if="actionError" class="notice error" aria-live="polite">{{ actionError }}</p>
      <template v-if="!loading && !loadError">
        <div v-if="!hasShowLink" class="create-row">
          <button type="button" :disabled="working" @click="createShow">Create main show link</button>
        </div>
        <div class="create-row">
          <label>Create a personal link for
            <select v-model="target" :aria-describedby="fieldId('target-help')">
              <option value="you">You</option>
              <option v-if="viewerGrantId" value="host">Host</option>
              <option v-for="producer in activeProducers" :key="producer.id" :value="`producer:${producer.id}`">Producer {{ producer.label }}</option>
              <option v-for="character in characters" :key="character.id" :value="`player:${character.id}`">{{ character.displayName }}</option>
            </select>
          </label>
          <p :id="fieldId('target-help')" class="field-help">A personal link follows one person and can only listen, never carry the show audio.</p>
          <button type="button" class="secondary" :disabled="working" @click="createPersonal">Create link</button>
        </div>
        <p v-if="!activeLinks.length" class="muted">No stream links yet. Create the main show link first.</p>
        <article v-for="link in activeLinks" :key="link.id" class="link-row">
          <div class="link-title"><strong>{{ link.label }}</strong> <small class="muted">{{ ownerOf(link) }}</small></div>
          <label>Layout
            <select :value="layoutOf(link)" :aria-describedby="fieldId(`${link.id}-layout-help`)" @change="setLayout(link, ($event.target as HTMLSelectElement).value)">
              <option value="scene">Full scene (1920×1080)</option>
              <option value="overlay">Transparent overlay</option>
            </select>
          </label>
          <p :id="fieldId(`${link.id}-layout-help`)" class="field-help">Full scene is a complete 1920×1080 picture. Transparent overlay shows captions, cast and dice over your camera.</p>
          <label>Audio
            <select :value="audioOf(link)" :aria-describedby="fieldId(`${link.id}-audio-help`)" @change="setAudio(link, ($event.target as HTMLSelectElement).value)">
              <option v-if="link.canPresent" value="present">Broadcast audio</option>
              <option value="listen">Listen only</option>
              <option value="off">Off</option>
            </select>
          </label>
          <p :id="fieldId(`${link.id}-audio-help`)" class="field-help">{{ link.canPresent ? 'Broadcast audio sends the narration to this OBS source. Use it on exactly one source.' : 'Listen only plays the narration in step with the show. Off is picture only.' }}</p>
          <template v-if="tokens[link.id]">
            <label>Link address
              <input :ref="bindInput(link.id)" readonly :value="urlOf(link)" :aria-describedby="fieldId(`${link.id}-url-help`)" @focus="($event.target as HTMLInputElement).select()" />
            </label>
            <p :id="fieldId(`${link.id}-url-help`)" class="field-help">Paste into OBS: Sources, +, Browser, URL. Width 1920, height 1080.</p>
          </template>
          <div class="actions">
            <button v-if="!tokens[link.id]" type="button" class="secondary" :disabled="working" @click="reveal(link)">Show link</button>
            <template v-else>
              <button type="button" class="secondary" @click="copy(link)">Copy link</button>
              <button type="button" class="secondary" @click="preview(link)">Open preview</button>
              <span class="copied" aria-live="polite">{{ copyNote(link) }}</span>
            </template>
            <button v-if="confirming !== link.id" type="button" class="quiet" :disabled="working" @click="confirming = link.id">Revoke</button>
          </div>
          <div v-if="confirming === link.id" class="confirm">
            <p>Turn off this link? OBS sources using it switch to a holding screen within seconds.</p>
            <button type="button" :disabled="working" @click="revoke(link)">Turn off link</button>
            <button type="button" class="secondary" @click="confirming = ''">Keep link</button>
          </div>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.lobby-section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.5rem; }
.links-body { margin-top: 1rem; display: grid; gap: 1rem; }
.create-row { display: grid; gap: .4rem; justify-items: start; }
.create-row label { width: min(100%, 24rem); }
.link-row { border: 1px solid var(--line); border-radius: 6px; padding: 1rem; display: grid; gap: .3rem; }
.link-row label { max-width: 32rem; }
.link-row input { width: 100%; }
.actions, .confirm { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: .4rem; }
.confirm p { flex-basis: 100%; margin: 0; }
.copied { color: var(--teal); font-size: .85rem; }
</style>
