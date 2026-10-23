<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { SessionOperationsSchema, type SessionOperations } from '@rpg/contracts';
import { getIdentity, identityHeaders } from './identity';

const props = defineProps<{ sessionId: string }>();
const snapshot = ref<SessionOperations | null>(null);
const message = ref('Checking session status…');
const stale = ref(false);
const now = ref(performance.now());
let receivedAt = 0;
let generation = 0;
let disposed = false;
let identityInvalid = false;
let selectedIdentity: string | undefined;
let poll: ReturnType<typeof setTimeout> | undefined;
let pending: { controller: AbortController; timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null;
try { selectedIdentity = getIdentity(); } catch { identityInvalid = true; message.value = 'This tab’s identity is invalid. Reload its original session link.'; }

const stageLabels = { plan: 'Planning the beat', render: 'Drafting the script', draft_audio: 'Preparing private narration', published_audio: 'Preparing published narration' };
const outcomeLabels = { running: 'In progress', succeeded: 'Finished', failed: 'Failed', cancelled: 'Replaced or cancelled', expired: 'Expired' };
const failureLabels = { plan: 'Planning request failed.', render: 'Script request failed.', speech: 'Speech request failed.' };
const running = computed(() => snapshot.value?.progress.some(item => item.status === 'running'));
const sampleTime = computed(() => snapshot.value ? Date.parse(snapshot.value.sampledAt) + (stale.value ? 0 : Math.max(0, now.value - receivedAt)) : 0);

function clearRequest() {
  generation++;
  clearTimeout(poll); poll = undefined;
  const request = pending; pending = null;
  if (request) { clearTimeout(request.timer); request.controller.abort(); request.cancel(); }
}
function identityCurrent() {
  if (identityInvalid) return false;
  try { if (getIdentity() === selectedIdentity) return true; } catch { /* An invalid selector must not fall back to another identity. */ }
  identityInvalid = true; clearRequest(); snapshot.value = null; stale.value = false;
  message.value = 'This tab’s identity changed. Reload the page to view session status.';
  return false;
}

async function refresh() {
  if (!identityCurrent() || disposed || pending) return;
  const requestGeneration = ++generation;
  const sessionId = props.sessionId;
  const controller = new AbortController();
  let cancel!: () => void;
  const deadline = new Promise<never>((_, reject) => { cancel = () => reject(new Error('Cancelled')); });
  const timer = setTimeout(() => { controller.abort(); cancel(); }, 10_000);
  const request = { controller, timer, cancel }; pending = request;
  try {
    const result = await Promise.race([
      (async () => {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/operations`, { credentials: 'same-origin', cache: 'no-store', headers: identityHeaders(), signal: controller.signal });
        if (!response.ok) return { status: response.status, data: null };
        return { status: response.status, data: await response.json() as unknown };
      })(),
      deadline,
    ]);
    if (!identityCurrent() || disposed || requestGeneration !== generation || sessionId !== props.sessionId) return;
    if ([401, 403, 404].includes(result.status)) {
      snapshot.value = null; stale.value = false;
      message.value = 'Session status is unavailable for this identity.';
      return;
    }
    if (result.status < 200 || result.status >= 300) throw new Error('Request failed');
    const parsed = SessionOperationsSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.sessionId !== sessionId) throw new Error('Invalid response');
    snapshot.value = parsed.data; receivedAt = performance.now(); now.value = receivedAt;
    stale.value = false; message.value = '';
  } catch {
    if (!identityCurrent() || disposed || requestGeneration !== generation || sessionId !== props.sessionId) return;
    stale.value = snapshot.value !== null;
    message.value = stale.value ? 'Status could not be refreshed. Showing the last successful update.' : 'Session status could not be loaded. Retrying shortly.';
  } finally {
    clearTimeout(timer);
    if (pending === request) {
      pending = null;
      if (!disposed && !identityInvalid) poll = setTimeout(() => { void refresh(); }, 2000);
    }
  }
}

function elapsed(item: SessionOperations['progress'][number]) {
  const end = item.finishedAt ? Date.parse(item.finishedAt) : item.status === 'running' ? sampleTime.value : Date.parse(snapshot.value!.sampledAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(item.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function dateLabel(value: string) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function readiness(value: SessionOperations['speech']['draft']) {
  if (!value) return 'No recording prepared';
  const labels = { missing: 'No recording prepared', preparing: 'Preparing', ready: 'Ready', failed: 'Preparation failed', expired: 'Preparation expired', unavailable: 'Speech is not configured' };
  return `${labels[value.status]}${value.totalSegments ? ` · ${value.completedSegments} of ${value.totalSegments} clips ready` : ''}`;
}

watch(() => props.sessionId, () => {
  clearRequest(); snapshot.value = null; stale.value = false;
  if (!identityInvalid) message.value = 'Checking session status…';
  void refresh();
}, { immediate: true, flush: 'sync' });
const clock = setInterval(() => { now.value = performance.now(); identityCurrent(); }, 1000);
const identityChanged = () => { identityCurrent(); };
window.addEventListener('popstate', identityChanged);
onUnmounted(() => { disposed = true; clearInterval(clock); window.removeEventListener('popstate', identityChanged); clearRequest(); });
</script>

<template>
  <section class="operations-panel" data-testid="operations-panel" aria-label="Session status and usage">
    <div class="operations-heading"><strong>Session status</strong><span class="operations-limit">Limits: Unlimited</span></div>
    <p data-testid="operations-update" class="operations-update" :class="{ 'is-stale': stale }" aria-live="polite">{{ message }}</p>
    <template v-if="snapshot">
      <div data-testid="operations-progress" class="operations-progress">
        <p v-if="!running" class="operations-idle">No preparation is running.</p>
        <div v-for="item in snapshot.progress" :key="item.id" :data-testid="`progress-${item.id}`" class="operation" :class="{ 'is-running': item.status === 'running' }">
          <span><strong>{{ stageLabels[item.kind] }}</strong> · {{ outcomeLabels[item.status] }}</span>
          <span class="operation-detail">Elapsed {{ elapsed(item) }}<template v-if="item.totalSegments !== null"> · {{ item.completedSegments }} of {{ item.totalSegments }} clips ready</template></span>
        </div>
      </div>
      <div class="operations-readiness">
        <span data-testid="draft-readiness"><strong>Draft narration:</strong> {{ readiness(snapshot.speech.draft) }}</span>
        <span data-testid="published-readiness"><strong>Published narration:</strong> {{ readiness(snapshot.speech.published) }}</span>
        <span v-if="!snapshot.speech.configured">Speech is not configured. Existing recordings remain available.</span>
      </div>
      <p class="operations-save"><template v-if="snapshot.lastSavedAt">Last saved session change: <time data-testid="last-saved" :datetime="snapshot.lastSavedAt">{{ dateLabel(snapshot.lastSavedAt) }}</time></template><template v-else>No saved session change recorded.</template></p>
      <p v-if="snapshot.usage.partial" data-testid="usage-partial" class="operations-warning">Some usage could not be recorded. These totals are incomplete.</p>
      <div v-if="snapshot.failures.length" data-testid="recent-failures" class="operations-failures">
        <h4>Recent failures</h4>
        <p v-for="failure in snapshot.failures" :key="failure.id">{{ failureLabels[failure.kind] }} <time :datetime="failure.occurredAt">{{ dateLabel(failure.occurredAt) }}</time></p>
      </div>
      <details data-testid="operations-usage">
        <summary>Recorded usage <span>· {{ snapshot.usage.ai.attempts }} planning/script attempts · {{ snapshot.usage.speech.attempts }} speech attempts</span></summary>
        <p class="operations-scope">Session planning and narration only. Field, library and character drafts are excluded. Counts include recorded attempts, including failures; they are not provider billing totals.</p>
        <p class="operations-scope">Since <time data-testid="usage-since" :datetime="snapshot.usage.since">{{ dateLabel(snapshot.usage.since) }}</time>. Earlier requests were not tracked. Playback adds no requests.</p>
        <div class="operations-counts">
          <div>
            <h4>Planning and scripts</h4>
            <dl>
              <dt>Attempts</dt><dd data-testid="ai-attempts">{{ snapshot.usage.ai.attempts }}</dd>
              <dt>Succeeded</dt><dd>{{ snapshot.usage.ai.succeeded }}</dd>
              <dt>Failed</dt><dd>{{ snapshot.usage.ai.failed }}</dd>
              <dt>Pending</dt><dd>{{ snapshot.usage.ai.pending }}</dd>
              <dt>Interrupted — completion unknown</dt><dd>{{ snapshot.usage.ai.interrupted }}</dd>
            </dl>
          </div>
          <div>
            <h4>Speech</h4>
            <dl>
              <dt>Attempts</dt><dd data-testid="speech-attempts">{{ snapshot.usage.speech.attempts }}</dd>
              <dt>Succeeded</dt><dd>{{ snapshot.usage.speech.succeeded }}</dd>
              <dt>Failed</dt><dd>{{ snapshot.usage.speech.failed }}</dd>
              <dt>Pending</dt><dd>{{ snapshot.usage.speech.pending }}</dd>
              <dt>Interrupted — completion unknown</dt><dd>{{ snapshot.usage.speech.interrupted }}</dd>
              <dt>Characters</dt><dd>{{ snapshot.usage.speech.characters }}</dd>
              <dt>Cache reuse</dt><dd>{{ snapshot.usage.speech.cacheHits }}</dd>
              <dt>Shared preparation reuse</dt><dd>{{ snapshot.usage.speech.sharedHits }}</dd>
            </dl>
          </div>
        </div>
        <p class="operations-scope">Tokens and cost: Not reported</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.operations-panel { margin: 1rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: .6rem; font-size: .82rem; overflow-wrap: anywhere; }
.operations-heading { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
.operations-heading > strong { font-size: .95rem; }
.operations-limit { color: var(--gold); font-size: .75rem; }
.operations-update { margin: .6rem 0 0; color: var(--muted); }
.operations-update:empty { display: none; }
.operations-progress { margin-top: .75rem; }
.operations-idle { margin: 0 0 .5rem; color: var(--muted); }
.operation { display: grid; gap: .2rem; padding: .4rem 0; }
.is-running { border-left: 2px solid var(--gold); padding-left: .65rem; }
.operation-detail, .operations-readiness, .operations-save, .operations-scope { color: var(--muted); font-size: .75rem; }
.operations-readiness { display: grid; gap: .35rem; margin: .7rem 0; }
.operations-save { margin: .65rem 0 0; }
details { margin-top: .8rem; padding-top: .7rem; border-top: 1px solid var(--line); }
summary { cursor: pointer; line-height: 1.6; min-height: 1.5rem; }
summary > span { color: var(--muted); font-size: .75rem; }
.operations-scope { margin: .7rem 0; }
.operations-counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
h4 { margin: .5rem 0; font-size: .8rem; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .35rem .75rem; margin: 0; font-size: .75rem; }
dt { color: var(--muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
.operations-warning, .is-stale { color: var(--gold); }
.operations-failures p { margin: .4rem 0; color: var(--muted); font-size: .75rem; }
@media (max-width: 520px) { .operations-counts { grid-template-columns: 1fr; gap: .6rem; } }
</style>
