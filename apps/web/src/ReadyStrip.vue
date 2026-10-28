<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import type { StreamLinkSummary } from '@rpg/contracts';
import { api } from './api';
import StreamLinkCard from './StreamLinkCard.vue';

const props = defineProps<{ sessionId: string; seats: Array<{ id: string; displayName: string; hasCard: boolean }>; showStart: boolean; busy: boolean; linksKey: number }>();
const emit = defineEmits<{ start: [] }>();
const prefix = useId();
const fieldId = (key: string) => `${prefix}-${key}`;

const working = ref(false);
const invitesMessage = ref('');
const invitesError = ref('');
const invitesText = ref('');
const showFallback = ref(false);
const fallback = ref<HTMLTextAreaElement | null>(null);
const showLink = ref<StreamLinkSummary | null>(null);
const showToken = ref('');
const showLoaded = ref(false);
const showFailed = ref(false);

const withCard = computed(() => props.seats.filter(seat => seat.hasCard).length);
const allReady = computed(() => props.seats.length > 0 && withCard.value === props.seats.length);

async function writeClipboard(text: string, element: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    if (!element) return false;
    element.select();
    try { return document.execCommand('copy') === true; } catch { return false; }
  }
}

async function copyAll() {
  working.value = true; invitesMessage.value = ''; invitesError.value = ''; showFallback.value = false;
  try {
    const { invites } = await api.invites(props.sessionId);
    const waiting = invites.filter(item => item.role === 'player' && item.status === 'waiting');
    const lines: string[] = [];
    for (const seat of props.seats) {
      const invite = waiting.find(item => item.characterId === seat.id);
      if (!invite) continue;
      const shown = await api.inviteLink(props.sessionId, invite.id);
      const url = `${window.location.origin}/join/${encodeURIComponent(shown.token)}`;
      lines.push(`${seat.displayName}: ${url}`);
    }
    if (!lines.length) { invitesMessage.value = 'No invitations are waiting.'; return; }
    const text = lines.join('\n');
    invitesText.value = text;
    if (await writeClipboard(text, null)) { invitesMessage.value = 'Copied'; return; }
    showFallback.value = true;
    await nextTick();
    fallback.value?.select();
    let ok = false;
    try { ok = document.execCommand('copy') === true; } catch { ok = false; }
    if (ok) { invitesMessage.value = 'Copied'; showFallback.value = false; }
    else invitesError.value = 'Copy failed. Select the text and copy it.';
  } catch { invitesError.value = 'The invitations could not be loaded. Try again in a moment.'; }
  finally { working.value = false; }
}

const isActive = (item: StreamLinkSummary) => item.revokedAt === null && Date.parse(item.expiresAt) > Date.now();

let loadSeq = 0;
async function loadShowLink() {
  const mine = ++loadSeq;
  showFailed.value = false;
  try {
    const { links } = await api.streamLinks(props.sessionId);
    if (mine !== loadSeq) return;
    const link = links.filter(item => item.subject === 'show' && isActive(item)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (link) {
      const shown = await api.streamLink(props.sessionId, link.id);
      if (mine !== loadSeq) return;
      showLink.value = link; showToken.value = shown.token;
    } else { showLink.value = null; showToken.value = ''; }
    showLoaded.value = true;
  } catch { if (mine === loadSeq) { showFailed.value = true; showLink.value = null; showToken.value = ''; } }
}

onMounted(loadShowLink);
watch(() => props.linksKey, loadShowLink);
</script>

<template>
  <section class="ready-strip" data-testid="ready-strip" :aria-labelledby="fieldId('title')">
    <h3 :id="fieldId('title')">{{ showStart ? 'Ready to start' : 'Invitations and show link' }}</h3>
    <p v-if="showStart" data-testid="seats-with-card">Seats with a card: {{ withCard }} of {{ seats.length }}</p>
    <div class="strip-row">
      <button type="button" class="secondary" data-testid="copy-all-invitations" :disabled="working" @click="copyAll">Copy all invitations</button>
      <span class="copied" aria-live="polite">{{ invitesMessage }}</span>
    </div>
    <p v-if="invitesError" class="notice error" aria-live="polite">{{ invitesError }}</p>
    <label v-if="showFallback" class="fallback">Invitations to copy
      <textarea ref="fallback" data-testid="invitations-text" readonly rows="4" :value="invitesText" @focus="($event.target as HTMLTextAreaElement).select()"></textarea>
    </label>
    <StreamLinkCard v-if="showLink" compact :link="showLink" :token="showToken" title="Main show link" :can-turn-off="false" testid="ready-show-link" />
    <div v-else-if="showFailed" class="strip-row" data-testid="show-link-error">
      <p class="notice error" role="alert">The main show link could not be loaded.</p>
      <button type="button" class="secondary" data-testid="show-link-retry" @click="loadShowLink">Try again</button>
    </div>
    <p v-else-if="showLoaded" class="muted" data-testid="show-link-none">No main show link yet. Make one under Stream this show.</p>
    <div v-if="showStart" class="strip-row">
      <button type="button" data-testid="start-session" :disabled="!allReady || busy" @click="emit('start')">Start show</button>
    </div>
  </section>
</template>

<style scoped>
.ready-strip { position: relative; padding: 24px; display: grid; gap: 12px; margin-bottom: 28px; }
.ready-strip::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.ready-strip h3, .ready-strip p { margin: 0; }
.strip-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.strip-row input { flex: 1 1 320px; min-width: 0; }
.fallback { display: grid; gap: 8px; }
.fallback textarea { width: 100%; }
.copied { color: var(--herb); font-size: 20px; line-height: 24px; }
</style>
