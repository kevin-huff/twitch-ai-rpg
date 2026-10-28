<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { SessionSnapshot, StreamAccessResponse, StreamAudio } from '@rpg/contracts';
import { api, subscribeToSession } from './api';
import BroadcastAudio from './BroadcastAudio.vue';
import { selectIdentity } from './identity';
import StageFrame from './StageFrame.vue';
import StageOverlay from './StageOverlay.vue';
import StageScene from './StageScene.vue';
import StageSlate from './StageSlate.vue';
import { parseStreamLocation } from './stream';

const RENEW_BEFORE_MS = 30 * 60 * 1000;
const MIN_RENEW_DELAY_MS = 60 * 1000;
const RETRY_MS = [2000, 5000, 15000];
const SLOW_RETRY_MS = 60 * 1000;

const requested = parseStreamLocation(window.location);
const layout = requested.layout;
const token = requested.token;

const access = shallowRef<StreamAccessResponse | null>(null);
const snapshot = shallowRef<SessionSnapshot | null>(null);
const connected = ref(false);
const offline = ref(!token);
const identityReady = ref(false);
const activeSegmentId = ref<string | null>(null);

const inObs = 'obsstudio' in window;
const audio = computed<StreamAudio>(() => {
  const canPresent = (access.value?.link.canPresent ?? false) && inObs;
  const wanted = requested.audio ?? (canPresent ? 'present' : 'listen');
  return wanted === 'present' && !canPresent ? 'listen' : wanted;
});
const beatId = computed(() => {
  const history = snapshot.value?.history ?? [];
  return history[history.length - 1]?.id;
});
const showPicture = computed(() => !offline.value && snapshot.value !== null);
const showTitle = computed(() => snapshot.value?.session.title || 'The Story Table');
const audioOn = computed(() => identityReady.value && !offline.value && access.value !== null && audio.value !== 'off');

const audioMounted = computed(() => audioOn.value && !!access.value && !offline.value);
watch(audioMounted, on => {
  if (!on) activeSegmentId.value = null;
});

let disposed = false;
let exchanging = false;
let failures = 0;
let exchangeRequests = 0;
let socketFailures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let socketTimer: ReturnType<typeof setTimeout> | undefined;
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | null = null;
let subscription = 0;
let refreshRequested = 0;
let refreshApplied = 0;

function statusOf(error: unknown) {
  return (error as { status?: number } | null)?.status;
}

function stopSubscription() {
  subscription++;
  const current = unsubscribe;
  unsubscribe = null;
  current?.();
}

function subscribe(sessionId: string) {
  stopSubscription();
  const generation = subscription;
  unsubscribe = subscribeToSession(sessionId, () => {
    if (generation === subscription) void refresh();
  }, value => {
    if (generation !== subscription) return;
    connected.value = value;
    if (value) {
      socketFailures = 0;
      clearSocketTimer();
    } else {
      handleDisconnect();
    }
  });
}

function clearSocketTimer() {
  clearTimeout(socketTimer);
  socketTimer = undefined;
}

function accessIsValid() {
  const current = access.value;
  if (!current) return false;
  return Date.parse(current.expiresAt) - Date.now() > RENEW_BEFORE_MS;
}

function handleDisconnect() {
  if (disposed || !token) return;
  if (!accessIsValid()) {
    requestExchange();
    return;
  }
  if (socketTimer !== undefined) return;
  const delay = RETRY_MS[socketFailures] ?? SLOW_RETRY_MS;
  socketFailures++;
  socketTimer = setTimeout(() => {
    socketTimer = undefined;
    if (disposed) return;
    const sessionId = access.value?.sessionId;
    if (!sessionId || !accessIsValid()) {
      requestExchange();
      return;
    }
    subscribe(sessionId);
    void refresh();
  }, delay);
}

async function refresh() {
  const sessionId = access.value?.sessionId;
  if (!sessionId || disposed) return;
  const request = ++refreshRequested;
  try {
    const next = await api.snapshot(sessionId, 'stage');
    if (disposed || request < refreshApplied || access.value?.sessionId !== sessionId) return;
    refreshApplied = request;
    exchangeRequests = 0;
    snapshot.value = next;
    document.title = `Stage · ${next.session.title}`;
  } catch (error) {
    if (!disposed && statusOf(error) === 401) requestExchange();
  }
}

function scheduleRetry(delay: number) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = undefined; void exchange(); }, delay);
}

function requestExchange(immediate = false) {
  if (disposed || !token || exchanging || retryTimer !== undefined) return;
  if (immediate) {
    scheduleRetry(0);
    return;
  }
  scheduleRetry(RETRY_MS[exchangeRequests] ?? SLOW_RETRY_MS);
  exchangeRequests++;
}

function scheduleRenewal(expiresAt: string) {
  clearTimeout(renewTimer);
  const delay = Math.max(MIN_RENEW_DELAY_MS, Date.parse(expiresAt) - Date.now() - RENEW_BEFORE_MS);
  renewTimer = setTimeout(() => { renewTimer = undefined; requestExchange(true); }, Number.isFinite(delay) ? delay : MIN_RENEW_DELAY_MS);
}

async function exchange() {
  if (disposed || !token || exchanging) return;
  exchanging = true;
  try {
    const result = await api.streamAccess(token);
    if (disposed) return;
    failures = 0;
    clearSocketTimer();
    stopSubscription();
    selectIdentity(result.identityId);
    access.value = result;
    identityReady.value = true;
    offline.value = false;
    scheduleRenewal(result.expiresAt);
    void refresh();
    subscribe(result.sessionId);
  } catch (error) {
    if (disposed) return;
    if (statusOf(error) === 401) {
      offline.value = true;
      connected.value = false;
      clearSocketTimer();
      stopSubscription();
      clearTimeout(renewTimer);
      renewTimer = undefined;
      scheduleRetry(SLOW_RETRY_MS);
    } else {
      scheduleRetry(RETRY_MS[failures] ?? SLOW_RETRY_MS);
      failures++;
    }
  } finally {
    exchanging = false;
  }
}

onMounted(() => {
  document.title = 'Stage';
  if (token) void exchange();
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(retryTimer);
  clearTimeout(renewTimer);
  clearSocketTimer();
  retryTimer = undefined;
  renewTimer = undefined;
  stopSubscription();
});
</script>

<template>
  <div class="stream-view" :data-layout="layout">
    <StageFrame :layout="layout" :checker="requested.checker">
      <template v-if="showPicture && snapshot">
        <StageOverlay v-if="layout === 'overlay'" :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
        <StageScene v-else :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
      </template>
      <div v-else class="offline" :class="layout">
        <StageSlate kind="offline" :show-title="showTitle" :compact="layout === 'overlay'" />
      </div>
    </StageFrame>
    <BroadcastAudio v-if="audioOn && access" :session-id="access.sessionId" :beat-id="beatId" :mode="audio" @segment="activeSegmentId = $event" />
  </div>
</template>

<style scoped>
.stream-view { position: fixed; inset: 0; overflow: hidden; }
.offline { width: 100%; height: 100%; }
.offline.scene { background: var(--void); }
</style>
