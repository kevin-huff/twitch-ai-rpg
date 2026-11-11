<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { SessionSnapshot, StreamAccessResponse, StreamAudio } from '@rpg/contracts';
import { api, subscribeToSession } from './api';
import BroadcastAudio from './BroadcastAudio.vue';
import { selectIdentity } from './identity';
import StageBadge from './StageBadge.vue';
import StageCaptions from './StageCaptions.vue';
import StageCorrections from './StageCorrections.vue';
import StageDice from './StageDice.vue';
import StageFacts from './StageFacts.vue';
import StageFrame from './StageFrame.vue';
import StageOverlay from './StageOverlay.vue';
import StageParty from './StageParty.vue';
import StagePictureCorner from './StagePictureCorner.vue';
import StageScene from './StageScene.vue';
import StageSlate from './StageSlate.vue';
import StageStakes from './StageStakes.vue';
import StageTracks from './StageTracks.vue';
import { parseStreamLocation, pieceInfo } from './stream';
import { heldStage, useDiceMoment } from './use-dice-moment';
import { createDiceSounds, diceSoundEvents, momentVolume } from './dice-sounds';

const PIECE_COMPONENTS = {
  captions: StageCaptions,
  dice: StageDice,
  stakes: StageStakes,
  party: StageParty,
  tracks: StageTracks,
  picture: StagePictureCorner,
  badge: StageBadge,
  facts: StageFacts,
  corrections: StageCorrections,
} as const;

const RENEW_BEFORE_MS = 30 * 60 * 1000;
const MIN_RENEW_DELAY_MS = 60 * 1000;
const RETRY_MS = [2000, 5000, 15000];
const SLOW_RETRY_MS = 60 * 1000;

const requested = parseStreamLocation(window.location);
const layout = requested.layout;
const token = requested.token;
const unknownView = requested.view === 'unknown';
const info = requested.view && !unknownView ? pieceInfo(requested.view) : null;
const pieceComponent = requested.view && requested.view !== 'unknown' ? PIECE_COMPONENTS[requested.view] : null;
const rootLayout = requested.view ? 'piece' : layout;

const access = shallowRef<StreamAccessResponse | null>(null);
const snapshot = shallowRef<SessionSnapshot | null>(null);
const connected = ref(false);
const offline = ref(!token || unknownView);
const identityReady = ref(false);
const activeSegmentId = ref<string | null>(null);

const inObs = 'obsstudio' in window;
const audio = computed<StreamAudio>(() => {
  const canPresent = (access.value?.link.canPresent ?? false) && inObs;
  let wanted: StreamAudio;
  if (requested.view) wanted = requested.audio ?? 'follow';
  else if (layout === 'audio') wanted = canPresent ? 'present' : 'listen';
  else wanted = requested.audio ?? (canPresent ? 'present' : 'listen');
  return wanted === 'present' && !canPresent ? 'listen' : wanted;
});
const pieceAllowsAudio = computed(() => {
  if (!requested.view) return true;
  if (!info) return false;
  return audio.value !== 'follow' || info.followsSpeech;
});
const beatId = computed(() => {
  const history = snapshot.value?.history ?? [];
  return history[history.length - 1]?.id;
});
const showPicture = computed(() => !offline.value && snapshot.value !== null);
const showTitle = computed(() => snapshot.value?.session.title || 'The Story Table');
const audioOn = computed(() => identityReady.value && !offline.value && access.value !== null && audio.value !== 'off' && pieceAllowsAudio.value);

const audioMounted = computed(() => audioOn.value && !!access.value && !offline.value);
watch(audioMounted, on => {
  if (!on) activeSegmentId.value = null;
});

// The dice moment: one memory for the whole page, so a slate or a layout change never replays a round.
const { moment: diceMoment, elapsed: diceElapsed } = useDiceMoment(snapshot);
// Until the dice land, every part of the stage shows what it showed before the publish; only the dice see the new rolls.
const heldSnapshot = computed(() => (diceMoment.value && snapshot.value ? heldStage(snapshot.value, diceMoment.value.before) : null));
const stageSnapshot = computed(() => (heldSnapshot.value && diceMoment.value && diceElapsed.value < diceMoment.value.schedule.revealAt ? heldSnapshot.value : snapshot.value));
// Only the Dice piece plays the moment among the pieces.
const pieceMoment = computed(() => (requested.view === 'dice' ? { moment: diceMoment.value, elapsed: diceElapsed.value } : {}));
// Dice sounds play only where this page is playing the narration right now, so OBS never doubles them.
const audioStatus = ref({ presenting: false, listening: false });
const diceSoundOn = computed(() => audioMounted.value && (audioStatus.value.presenting || audioStatus.value.listening));
const diceSounds = createDiceSounds();
watch([diceMoment, diceSoundOn], ([moment, on]) => {
  if (!moment || !on) { diceSounds.stop(); return; }
  diceSounds.play(diceSoundEvents(moment.schedule), Date.now() - moment.startedAt, momentVolume(moment.schedule.rolls.length));
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
  if (token && !unknownView) void exchange();
});

onBeforeUnmount(() => {
  disposed = true;
  diceSounds.dispose();
  clearTimeout(retryTimer);
  clearTimeout(renewTimer);
  clearSocketTimer();
  retryTimer = undefined;
  renewTimer = undefined;
  stopSubscription();
});
</script>

<template>
  <div class="stream-view" :data-layout="rootLayout" :data-view="requested.view ?? undefined">
    <StageFrame v-if="requested.view" :layout="info ? 'piece' : 'blank'" :checker="requested.checker" :box="info?.box">
      <component
        :is="pieceComponent"
        v-if="pieceComponent && showPicture && stageSnapshot"
        :snapshot="stageSnapshot"
        :connected="connected"
        :active-segment-id="activeSegmentId"
        :character-id="requested.who"
        v-bind="pieceMoment"
      />
    </StageFrame>
    <StageFrame v-else-if="layout === 'audio'" layout="blank" :checker="requested.checker" />
    <StageFrame v-else :layout="layout" :checker="requested.checker">
      <template v-if="showPicture && stageSnapshot">
        <StageOverlay v-if="layout === 'overlay'" :snapshot="stageSnapshot" :connected="connected" :active-segment-id="activeSegmentId" :dice-moment="diceMoment" :dice-elapsed="diceElapsed" />
        <StageScene v-else :snapshot="stageSnapshot" :connected="connected" :active-segment-id="activeSegmentId" :dice-moment="diceMoment" :dice-elapsed="diceElapsed" />
      </template>
      <div v-else class="offline" :class="layout">
        <StageSlate kind="offline" :show-title="showTitle" :compact="layout === 'overlay'" />
      </div>
    </StageFrame>
    <BroadcastAudio v-if="audioOn && access" :session-id="access.sessionId" :beat-id="beatId" :mode="audio" @segment="activeSegmentId = $event" @status="audioStatus = $event" />
  </div>
</template>

<style scoped>
.stream-view { position: fixed; inset: 0; overflow: hidden; }
.offline { width: 100%; height: 100%; }
.offline.scene { background: var(--void); }
</style>
