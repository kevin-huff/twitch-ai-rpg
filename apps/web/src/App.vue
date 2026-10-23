<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import type { ActionContract, AiSegment, Command, CreateSessionResponse, DirectorSnapshot, Effect, PlayerSnapshot, SessionSnapshot, Submission } from '@rpg/contracts';
import { ActionContractSchema } from '@rpg/contracts';
import { api, subscribeToSession } from './api';
import { identityPath, selectIdentity } from './identity';
import Story from './Story.vue';
import AudioPanel from './AudioPanel.vue';
import DraftAudioPanel from './DraftAudioPanel.vue';
import OperationsPanel from './OperationsPanel.vue';
import Library from './Library.vue';
import PlayerBuilder from './PlayerBuilder.vue';
import ErrorNotice from './ErrorNotice.vue';
import Lobby from './Lobby.vue';
import LiveControls from './LiveControls.vue';
import CorrectionControls from './CorrectionControls.vue';
import BeatSteering from './BeatSteering.vue';
import FieldGenerator from './FieldGenerator.vue';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const path = window.location.pathname;
const route = path.match(/^\/sessions\/([^/]+)\/(play|director|stage|lobby)\/?$/);
const sessionId = route ? decodeURIComponent(route[1]) : '';
const view = route?.[2] ?? 'home';
const stage = view === 'stage';
const inviteToken = path.startsWith('/join/') ? decodeURIComponent(path.slice(6)) : '';
const testCharacterId = view === 'play' ? new URLSearchParams(window.location.search).get('testCharacterId') : null;
const snapshot = ref<SessionSnapshot | null>(null);
const error = ref('');
const notice = ref('');
const loading = ref(true);
const busy = ref(false);
const connected = ref(false);
const hostToken = ref('');
const hostReady = ref(false);
const title = ref('The Ledger Job');
const recentSessions = ref<Array<{ id: string; title: string }>>([]);
const created = ref<CreateSessionResponse | null>(null);
const director = computed<DirectorSnapshot | null>(() => !stage && snapshot.value?.role === 'director' ? snapshot.value : null);
const player = computed<PlayerSnapshot | null>(() => !stage && snapshot.value?.role === 'player' ? snapshot.value : null);
const setup = computed(() => director.value?.setup ?? player.value?.setup);
const playerReady = computed(() => !player.value?.setup || Boolean(player.value.setup.started && player.value.ownCharacter?.approved && player.value.ownCharacter.ready && player.value.ownCharacter.acceptedBoundariesRevision === player.value.setup.boundariesRevision));
const beat = computed(() => director.value?.activeBeat ?? null);
const latestHistory = computed(() => snapshot.value?.history.slice(-1) ?? []);
const publicStakes = computed(() => snapshot.value?.role !== 'director' ? snapshot.value?.activeBeat?.stakes ?? [] : []);
const pending = computed(() => director.value?.submissions.filter(item => ['queued', 'selected'].includes(item.status)) ?? []);
const selected = ref<string[]>([]);
const contracts = ref<ActionContract[]>([]);
const reviewClassification = ref<'ordinary' | 'action'>('ordinary');
const abortReason = ref('');
const contractJson = ref('');
const script = ref<AiSegment[]>([]);
const scriptEpoch = ref(0);
const scriptRowKeys = new WeakMap<AiSegment, number>();
let nextScriptRowKey = 0;
const scriptContext = computed(() => `${sessionId}:${beat.value?.id}:${beat.value?.revision}:${scriptEpoch.value}`);
function scriptRowKey(segment: AiSegment): number {
  let key = scriptRowKeys.get(segment);
  if (key === undefined) { key = ++nextScriptRowKey; scriptRowKeys.set(segment, key); }
  return key;
}
const contractsDirty = computed(() => JSON.stringify(reviewClassification.value === 'ordinary' ? [] : contracts.value) !== JSON.stringify(beat.value?.contracts ?? []) || reviewClassification.value !== beat.value?.classification);
const scriptDirty = computed(() => JSON.stringify(script.value) !== JSON.stringify(beat.value?.draft?.segments ?? []));
const rendering = computed(() => director.value?.jobs.some(job => job.beatId === beat.value?.id && job.generation === beat.value?.generation && job.task === 'render' && ['queued', 'running'].includes(job.status)) ?? false);
watch(contracts, value => { contractJson.value = JSON.stringify(value, null, 2); }, { deep: true });
let editorRevision = '';
let unsubscribe: (() => void) | undefined;
let refreshSequence = 0;

const kind = ref<'say' | 'act' | 'ooc'>('say');
const speech = ref('');
const intent = ref('');
const approach = ref('');
const recipient = ref('');
const stageDirection = ref('');
const alreadySpoken = ref(true);
const dirty = ref(false);
const editing = ref<Submission | null>(null);
const inputContext = ref<{ epoch: number; beatId: string | null } | null>(null);

const initials = (name: string) => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
const nameOf = (id: string) => snapshot.value?.characters.find(character => character.id === id)?.displayName ?? 'Player';
const phaseName = (phase: string) => ({ collecting: 'Collecting input', stakes_review: 'Review stakes', locked: 'Locked · dice fixed', draft_review: 'Review script', published: 'Published', aborted: 'Aborted' })[phase] ?? phase;
const effectLabel = (effect: Effect) => {
  if (effect.kind === 'track_delta') return `${snapshot.value?.tracks.find(track => track.id === effect.trackId)?.label ?? 'Track'} ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
  if (effect.kind === 'strain_delta') return `${nameOf(effect.characterId)} strain ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
  if (effect.kind === 'fact_add') return `${effect.visibility === 'director' ? 'Private fact' : 'Fact'}: ${effect.text}`;
  return `${nameOf(effect.characterId)} ${effect.kind === 'inventory_add' ? 'gains' : 'loses'} ${effect.item}`;
};
const context = () => ({ epoch: snapshot.value?.session.inputEpoch ?? 0, beatId: snapshot.value?.activeBeat && ['collecting', 'stakes_review'].includes(snapshot.value.activeBeat.phase) ? snapshot.value.activeBeat.id : null });

function beginInput() {
  if (!dirty.value) inputContext.value = context();
  dirty.value = true;
}

async function refresh() {
  if (testCharacterId !== null) return;
  const sequence = ++refreshSequence;
  try {
    const next = await api.snapshot(sessionId, stage ? 'stage' : view === 'director' ? 'director' : view === 'play' ? 'player' : undefined);
    if (sequence !== refreshSequence) return;
    snapshot.value = next;
    if (!recipient.value) recipient.value = next.npcs.find(npc => npc.status === 'present')?.id ?? '';
    if (next.role === 'director' && !stage) {
      const key = next.activeBeat ? `${next.activeBeat.id}:${next.activeBeat.revision}` : '';
      if (key !== editorRevision) {
        editorRevision = key;
        contracts.value = structuredClone(next.activeBeat?.contracts ?? []);
        reviewClassification.value = next.activeBeat?.classification === 'ordinary' || (!next.activeBeat?.classification && next.activeBeat?.kind === 'conversation') ? 'ordinary' : 'action';
        ensureContracts();
        contractJson.value = JSON.stringify(contracts.value, null, 2);
        script.value = structuredClone(next.activeBeat?.draft?.segments ?? []);
        scriptEpoch.value++;
      }
      selected.value = selected.value.filter(id => next.submissions.some(item => item.id === id && ['queued', 'selected'].includes(item.status)));
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load the session.'; }
  finally { loading.value = false; }
}

async function work(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await task(); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
  finally { busy.value = false; }
}

async function send(command: Command) {
  await api.command(sessionId, command);
  await refresh();
}

function beatMeta() {
  if (!beat.value) throw new Error('There is no active beat.');
  return { commandId: crypto.randomUUID(), beatId: beat.value.id, expectedBeatRevision: beat.value.revision };
}

function login() { return work(async () => { await api.login(hostToken.value); hostToken.value = ''; hostReady.value = true; recentSessions.value = await api.sessions(); }); }
function createSession() { return work(async () => { created.value = await api.create(title.value); recentSessions.value = await api.sessions(); }); }
function join() { return work(async () => {
  const result = await api.redeem(inviteToken);
  window.location.replace(identityPath(`/sessions/${encodeURIComponent(result.sessionId)}/${result.role === 'stage' ? 'stage' : 'play'}`));
}); }
const invitationUrl = (token: string) => `${window.location.origin}/join/${encodeURIComponent(token)}`;

async function restoreSession() {
  if (testCharacterId !== null) {
    await work(async () => {
      const result = await api.testSeat(sessionId, testCharacterId);
      if (result.sessionId !== sessionId || result.role !== 'player' || result.characterId !== testCharacterId) throw new Error('The requested character seat could not be opened.');
      selectIdentity(result.identityId);
      window.location.replace(identityPath(`/sessions/${encodeURIComponent(sessionId)}/play`));
    });
    loading.value = false;
    return;
  }
  await refresh();
  if (snapshot.value && !unsubscribe) {
    try { unsubscribe = subscribeToSession(sessionId, () => { void refresh(); }, value => { connected.value = value; }); }
    catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not connect to the session.'; }
  }
}

function saveSubmission() { return work(async () => {
  const captured = inputContext.value ?? context();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), ...(editing.value ? { submissionId: editing.value.id } : {}), expectedSubmissionRevision: editing.value?.revision ?? 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, kind: kind.value, text: speech.value, intent: intent.value, approach: approach.value, recipientNpcIds: kind.value === 'say' && recipient.value ? [recipient.value] : [], stageDirection: stageDirection.value, alreadySpokenAloud: alreadySpoken.value });
  resetInput(); notice.value = 'Saved to the director’s queue. It becomes public only after review and publication.';
}); }

function resetInput() { speech.value = ''; intent.value = ''; approach.value = ''; stageDirection.value = ''; editing.value = null; dirty.value = false; inputContext.value = null; }
function editSubmission(item: Submission) {
  kind.value = item.kind; speech.value = item.text; intent.value = item.intent; approach.value = item.approach; stageDirection.value = item.stageDirection;
  recipient.value = item.recipientNpcIds[0] ?? ''; alreadySpoken.value = item.alreadySpokenAloud; editing.value = item;
  inputContext.value = context(); dirty.value = true;
}
function pauseRequest() { return work(async () => {
  const captured = context();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, kind: 'ooc', text: 'Pause requested. Please check in with the table.', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true });
  notice.value = 'Pause requested. Let the table know on your voice call too.';
}); }
function openBeat(mode: 'conversation' | 'action') { return work(() => send({ type: 'open_beat', commandId: crypto.randomUUID(), expectedInputEpoch: snapshot.value!.session.inputEpoch, kind: mode })); }
function plan() { return work(() => send({ type: 'plan_beat', ...beatMeta(), submissionIds: selected.value })); }
function ensureContracts() {
  if (reviewClassification.value !== 'action' || contracts.value.length) return;
  const inputs = director.value?.submissions.filter(item => beat.value?.selectedSubmissionIds.includes(item.id) && item.kind !== 'ooc') ?? [];
  const actors = [...new Set(inputs.map(item => item.characterId))];
  contracts.value = actors.map(actorCharacterId => {
    const actorInputs = inputs.filter(item => item.characterId === actorCharacterId);
    const action = actorInputs.find(item => item.kind === 'act');
    return {
      id: crypto.randomUUID(), version: 1, actorCharacterId, helperCharacterIds: [], submissionIds: actorInputs.map(item => item.id),
      intent: action?.intent || `Resolve the requested concession: ${actorInputs.map(item => item.text).join(' ')}`,
      approach: action?.approach || 'Use the submitted dialogue.', ruling: 'check', trait: action ? 'wits' : 'presence', edge: 0, edgeReason: null,
      risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: { clean: { publicText: 'The agreed goal is achieved.', effects: [] }, costly: { publicText: '', effects: [] }, setback: { publicText: '', effects: [] } },
    };
  });
}
function approveStakes() { return work(async () => {
  const proposed = reviewClassification.value === 'ordinary' ? [] : contracts.value;
  if (reviewClassification.value === 'action' && !proposed.length) throw new Error('An action needs a reviewed contract for the selected input.');
  if (proposed.some(contract => !contract.intent.trim() || !contract.approach.trim() || Object.values(contract.outcomes).some(branch => !branch.publicText.trim()))) throw new Error('Fill in the goal, approach, and all three outcome branches before approving stakes.');
  const checked = proposed.map(contract => ActionContractSchema.parse(contract));
  await send({ type: 'approve_stakes', ...beatMeta(), classification: reviewClassification.value, contracts: checked });
}); }
function abortBeat() { return work(async () => { await send({ type: 'abort_beat', ...beatMeta(), reason: abortReason.value.trim() }); abortReason.value = ''; }); }
function useContractJson() {
  try { contracts.value = JSON.parse(contractJson.value).map((item: unknown) => ActionContractSchema.parse(item)); error.value = ''; notice.value = 'Contract edits loaded. Review and approve to save.'; }
  catch { error.value = 'The contract data is not valid. Keep all contract fields and supported typed effects.'; }
}
function lock() { return work(() => send({ type: 'lock_beat', ...beatMeta() })); }
function render() { return work(() => send({ type: 'render_beat', ...beatMeta() })); }
function saveScript() { return work(() => send({ type: 'edit_script', ...beatMeta(), segments: JSON.parse(JSON.stringify(script.value)) })); }
function addNarration() { script.value.push({ kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], text: '', delivery: 'neutral' }); }
function addNpc() {
  const npc = snapshot.value?.npcs.find(item => item.status === 'present');
  if (npc) script.value.push({ kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], text: '', delivery: 'neutral' });
}
function approveContinuity() { return work(() => send({ type: 'approve_continuity', ...beatMeta(), updates: beat.value?.draft?.continuity ?? [] })); }
function publish(audioPreparationId?: string) {
  if (scriptDirty.value || rendering.value) return;
  return work(() => send({ type: 'publish_beat', ...beatMeta(), expectedStateRevision: snapshot.value!.session.stateRevision, draftRevision: beat.value!.draftRevision, textOnly: !audioPreparationId, ...(audioPreparationId ? { audioPreparationId } : {}) }));
}
function status(value: 'live' | 'paused') { return work(() => send({ type: 'set_status', commandId: crypto.randomUUID(), status: value, expectedStateRevision: snapshot.value!.session.stateRevision })); }

onMounted(async () => {
  if (path === '/library' || path === '/build-character') { loading.value = false; return; }
  if (sessionId) {
    await restoreSession();
  } else {
    loading.value = false;
    if (!inviteToken) {
      try { recentSessions.value = await api.sessions(); hostReady.value = true; } catch { /* A host signs in before accessing saved sessions. */ }
    }
  }
});
onUnmounted(() => unsubscribe?.());
</script>

<template>
  <template v-if="stage && snapshot">
    <main class="stage">
      <header class="stage-top"><div><p class="eyebrow">A live tabletop story</p><h1>{{ snapshot.session.title }}</h1></div><span class="status" :class="{ offline: !connected || snapshot.session.status === 'paused' }">{{ snapshot.session.status === 'paused' ? 'Paused' : connected ? 'Live table' : 'Reconnecting' }}</span></header>
      <div class="stage-layout"><section class="stage-story"><p class="eyebrow">The current scene</p><h2 class="scene-title">{{ snapshot.session.scene.title }}</h2><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" stage /></section>
        <aside><section v-if="snapshot.facts.length" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section><div><p class="eyebrow">The objective</p><p>{{ snapshot.session.scene.description }}</p></div><div><div v-for="track in snapshot.tracks.filter(item => item.enabled)" :key="track.id" class="track" :class="track.kind"><div class="track-label"><span>{{ track.label }}</span><span>{{ track.current }}/{{ track.max }}</span></div><div class="track-pips" :aria-label="`${track.label}: ${track.current} of ${track.max}`"><span v-for="pip in track.max" :key="pip" :class="{ filled: pip <= track.current }"></span></div></div></div>
          <div v-for="stake in publicStakes" :key="stake.id"><p class="eyebrow">At stake · {{ nameOf(stake.actorCharacterId) }}</p><p>{{ stake.intent }}</p><small>On a cost: {{ stake.outcomes.costly }}</small><p v-if="stake.helperCharacterIds.length"><small>With {{ stake.helperCharacterIds.map(nameOf).join(', ') }}</small></p></div>
        </aside>
      </div>
      <div class="cast"><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><span class="avatar">{{ initials(character.displayName) }}</span><div><strong>{{ character.displayName }}</strong><small>Strain {{ character.strain }}/4 {{ character.strain === 4 ? '· Needs help' : '' }}</small></div></div></div>
      <AudioPanel :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="false" stage />
      <footer class="stage-foot"><span>Beat {{ snapshot.session.beatNumber }} · Action round {{ snapshot.session.actionRoundNumber }}</span><span>AI-generated characters & narration · Captions always available</span></footer>
    </main>
  </template>
  <template v-else>
    <header class="app-header"><span v-if="path === '/build-character'" class="brand"><span class="brand-mark">S</span> THE STORY TABLE</span><a v-else class="brand" :href="identityPath('/')"><span class="brand-mark">S</span> THE STORY TABLE</a><div class="header-meta"><span class="role-label">{{ director ? 'Director workspace' : player ? 'Player seat' : 'A shared live story' }}</span><span v-if="sessionId" class="status" :class="{ offline: !connected }">{{ connected ? 'Connected' : 'Reconnecting' }}</span><a v-if="director" :href="identityPath(`/sessions/${sessionId}/stage`)" target="_blank" rel="noopener">Open stage ↗</a></div></header>
    <PlayerBuilder v-if="path === '/build-character'" /><Library v-else-if="path === '/library'" /><main v-else-if="!sessionId" class="welcome">
      <section class="welcome-copy"><p class="eyebrow">Four players. One missing ledger.</p><h1>A good story<br>needs <em>accomplices.</em></h1><p>A members-only club. A bartender who knows too much. Your cast writes the choices; the world answers back.</p><p class="welcome-note">The Ledger Job · Original rehearsal scenario<br>Human-directed storytelling · Server dice · Reviewed publication</p></section>
      <section class="panel">
        <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
        <template v-if="inviteToken"><p class="eyebrow">An invitation to the table</p><h2>Your seat is waiting.</h2><p class="muted">Redeem this invitation to enter your assigned player seat or the read-only stage. Your invitation will leave the address bar.</p><button :disabled="busy" @click="join">{{ busy ? 'Joining…' : 'Join session' }}</button></template>
        <template v-else-if="!hostReady"><p class="eyebrow">Host access</p><h2>Bring the table together.</h2><form @submit.prevent="login"><label>Host access token<input :aria-describedby="helpId('host-token')" v-model="hostToken" type="password" autocomplete="current-password" required placeholder="Enter your configured host token"></label><p :id="helpId('host-token')" class="field-help">Use the configured host token to manage shows. Players join through their own invitations.</p><button :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in as host' }}</button><small>Your host token is configured on the server. Players join through their own invitations.</small></form></template>
        <template v-else-if="created"><p class="eyebrow">Your table is ready</p><h2>{{ title }}</h2><p class="muted">Copy each invitation for its intended player. The stage invitation has read-only access.</p><div class="invites"><div v-for="(invite, index) in created.invites" :key="invite.token"><label class="invite">{{ invite.role === 'stage' ? 'Broadcast stage' : `Player ${index + 1}` }}<input :aria-describedby="helpId('invite', invite.token)" :value="invitationUrl(invite.token)" readonly @focus="($event.target as HTMLInputElement).select()" :aria-label="invite.role === 'stage' ? 'Stage invitation' : `Player ${index + 1} invitation`"></label><p :id="helpId('invite', invite.token)" class="field-help">Save this link now; it is displayed once and can be redeemed once by its intended player or stage viewer.</p></div></div><p class="muted"><small>Save these invitation links now. They are displayed once.</small></p><a class="button" :href="identityPath(`/sessions/${created.sessionId}/director`)">Enter director workspace</a></template>
        <template v-else><p class="eyebrow">Host workspace</p><h2>Set the scene.</h2><p><a class="button" data-testid="library-link" :href="identityPath('/library')">Library & custom shows</a></p><p class="muted">Or start the four-player Ledger Job rehearsal below.</p><form @submit.prevent="createSession"><label>Session title<input :aria-describedby="helpId('title')" v-model="title" maxlength="160" required></label><p :id="helpId('title')" class="field-help">Name this particular rehearsal session so you can find and resume the show later.</p><FieldGenerator v-model="title" field="session.title" context-key="host-rehearsal" :disabled="busy" /><button :disabled="busy">{{ busy ? 'Creating…' : 'Create rehearsal session' }}</button></form><div v-if="recentSessions.length"><h3 style="margin-top: 2rem">Resume a saved session</h3><p v-for="session in recentSessions" :key="session.id"><a :href="identityPath(`/sessions/${session.id}/director`)">{{ session.title }} →</a></p></div></template>
      </section>
    </main>
    <main v-else class="shell">
      <ErrorNotice v-if="error" :message="error" @dismiss="error = ''"><button type="button" class="quiet" :disabled="busy" @click="restoreSession">{{ testCharacterId !== null ? 'Retry opening seat' : 'Refresh state' }}</button></ErrorNotice>
      <div v-if="notice" class="notice" role="status">{{ notice }}</div>
      <div v-if="loading" class="loading">Restoring the table…</div>
      <template v-if="snapshot">
        <div v-if="!connected" class="notice">Connection interrupted. Unsaved words stay in this browser. Reconnect refreshes the table; it never sends them.</div>
        <div v-if="snapshot.session.status === 'paused'" class="notice">The table is paused. Check in with the cast before continuing.</div>
        <section class="scene-heading"><div><p class="eyebrow">{{ snapshot.session.title }} · Beat {{ snapshot.session.beatNumber }} · Action round {{ snapshot.session.actionRoundNumber }}</p><h1>{{ snapshot.session.scene.title }}</h1><p>{{ snapshot.session.scene.description }}</p></div><div v-if="director" class="actions"><a :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button class="secondary" :disabled="busy || Boolean(setup && !setup.started)" @click="status(snapshot.session.status === 'paused' ? 'live' : 'paused')">{{ snapshot.session.status === 'paused' ? 'Resume table' : 'Pause table' }}</button></div><a v-if="player" :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a><button v-if="player" class="secondary" :disabled="busy" @click="pauseRequest">Request a pause</button></section>
        <section v-if="snapshot.facts.length" class="panel" data-testid="public-facts"><p class="eyebrow">Known to the party</p><p v-for="fact in snapshot.facts" :key="fact.id" style="white-space: pre-wrap; overflow-wrap: anywhere">{{ fact.text }}</p></section>
        <Lobby v-if="view === 'lobby' && (director || player)" :snapshot="director ?? player!" :busy="busy" @command="command => work(() => send(command))" />
        <section v-else-if="setup && !setup.started" class="panel"><p class="eyebrow">Before the story begins</p><h2>Review your cast and boundaries.</h2><p>The director starts this session after character approval and player readiness.</p><a class="button" data-testid="setup-lobby-link" :href="identityPath(`/sessions/${sessionId}/lobby`)">Open cast & lobby</a></section>
        <div v-else-if="director" class="workspace" data-testid="director-controls">
          <aside class="stack"><section class="panel"><div class="panel-heading"><h2>At the table</h2><span class="status">{{ pending.length }} queued</span></div><p class="muted"><small>Choose the lines for this beat. One player is enough to keep a conversation moving.</small></p><div v-if="!pending.length" class="empty">No pending submissions. Invite your cast to speak or act.</div><div v-for="item in pending" :key="item.id" class="queue-item"><label class="check"><input :aria-describedby="helpId('queue', item.id)" v-model="selected" type="checkbox" :value="item.id" :disabled="item.kind === 'ooc' || !['collecting', 'stakes_review'].includes(beat?.phase ?? 'collecting')"><strong>{{ nameOf(item.characterId) }}</strong></label><p :id="helpId('queue', item.id)" class="field-help">Select this submitted input for planning. Out-of-character questions cannot become dialogue.</p><small>{{ item.kind === 'ooc' ? 'Out of character · private to the table' : item.kind === 'act' ? 'Action' : 'Exact dialogue' }} · {{ item.status }}</small><p>{{ item.kind === 'act' ? item.intent : item.text }}</p><small v-if="item.kind === 'act'">{{ item.approach }}</small></div></section><section class="panel"><p class="eyebrow">Live state</p><div v-for="track in snapshot.tracks" :key="track.id" class="track" :class="track.kind"><div class="track-label"><span>{{ track.label }}</span><span>{{ track.current }}/{{ track.max }}{{ !track.enabled ? ' · inactive' : '' }}</span></div><div class="track-pips"><span v-for="pip in track.max" :key="pip" :class="{ filled: pip <= track.current }"></span></div></div></section></aside>
          <section class="stack"><LiveControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" /><CorrectionControls :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" /><BeatSteering :snapshot="director" :busy="busy" @command="(command, onSaved) => work(async () => { await send(command); onSaved(); })" /><OperationsPanel :session-id="sessionId" /><div class="panel"><div class="panel-heading"><h2>{{ beat ? phaseName(beat.phase) : 'Direct the next beat' }}</h2><span v-if="beat" class="status">{{ beat.kind }}</span></div>
              <template v-if="!beat || ['published', 'aborted'].includes(beat.phase)"><p class="muted">Keep the exchange short, or bring the cast together for a consequential action.</p><div class="actions"><button :disabled="busy" data-testid="open-conversation" @click="openBeat('conversation')">Open conversation</button><button class="secondary" :disabled="busy" data-testid="open-action" @click="openBeat('action')">Open action round</button></div></template>
              <template v-else>
                <p v-if="beat.lastError" class="notice error" role="alert">{{ beat.lastError }} Your accepted input and any dice are preserved.</p>
                <div v-if="['collecting', 'stakes_review'].includes(beat.phase)" class="actions"><button :disabled="busy || !selected.length" data-testid="plan" @click="plan">{{ busy ? 'Working…' : 'Plan selected input' }}</button><small>{{ selected.length }} selected</small></div>
                <template v-if="beat.phase === 'stakes_review' || (beat.phase === 'collecting' && beat.selectedSubmissionIds.length > 0 && beat.lastError)"><label>How should this input resolve?<select :aria-describedby="helpId('classification')" v-model="reviewClassification" data-testid="stakes-classification" @change="ensureContracts"><option value="ordinary" :disabled="beat.classification === 'needs_action'">Ordinary conversation · no mechanical consequences</option><option value="action">Action · review the agreed goal and consequences</option></select></label><p :id="helpId('classification')" class="field-help">Choose ordinary conversation or an action that needs an agreed goal and consequences.</p><p v-if="beat.phase === 'collecting'" class="notice">Planning failed. You can review manual stakes below, retry planning, or abandon this beat with a reason.</p><p v-if="beat.classification === 'needs_action'" class="notice">This exchange has consequences. Review the action stakes before locking.</p><p v-if="reviewClassification === 'ordinary'" class="notice">Ordinary conversation. No check or mechanical effects.</p>
                  <article v-for="contract in reviewClassification === 'action' ? contracts : []" :key="contract.id" class="contract"><h3>{{ nameOf(contract.actorCharacterId) }}</h3><label>Ruling<select :aria-describedby="helpId('contract', contract.id, 'ruling')" v-model="contract.ruling" data-testid="contract-ruling"><option value="check">Check · uncertain and consequential</option><option value="no_check">No check · achievable without uncertainty</option><option value="blocked">Blocked · explain the missing requirement</option></select></label><p :id="helpId('contract', contract.id, 'ruling')" class="field-help">Choose a check for uncertainty, no check for automatic success, or blocked for a missing requirement.</p><label>Agreed goal<textarea :aria-describedby="helpId('contract', contract.id, 'intent')" v-model="contract.intent" rows="2" /></label><p :id="helpId('contract', contract.id, 'intent')" class="field-help">State the result the character is trying to achieve.</p><label>Approach<textarea :aria-describedby="helpId('contract', contract.id, 'approach')" v-model="contract.approach" rows="2" /></label><p :id="helpId('contract', contract.id, 'approach')" class="field-help">Describe how the character will attempt the agreed goal.</p><div class="contract-grid"><div><label>Trait<select :aria-describedby="helpId('contract', contract.id, 'trait')" v-model="contract.trait"><option v-for="trait in ['force', 'finesse', 'wits', 'presence']" :key="trait">{{ trait }}</option></select></label><p :id="helpId('contract', contract.id, 'trait')" class="field-help">Choose the character trait whose modifier is added to the check.</p></div><div><label>Risk<select :aria-describedby="helpId('contract', contract.id, 'risk')" v-model="contract.risk"><option>low</option><option>normal</option><option>high</option></select></label><p :id="helpId('contract', contract.id, 'risk')" class="field-help">Describe the severity of the consequences; risk does not change the dice modifier.</p></div></div><p v-if="contract.helperCharacterIds.length"><small>Helpers: {{ contract.helperCharacterIds.map(nameOf).join(', ') }} · Edge +{{ contract.edge }}</small></p><div v-for="band in (['clean', 'costly', 'setback'] as const)" :key="band" class="branch"><label>{{ band === 'clean' ? '10+ · Clean success' : band === 'costly' ? '7–9 · Success with a cost' : '6 or less · Setback' }}<textarea :aria-describedby="helpId('contract', contract.id, 'outcome', band)" v-model="contract.outcomes[band].publicText" :data-testid="`outcome-${band}`" rows="2" placeholder="Write the agreed outcome and consequences" /></label><p :id="helpId('contract', contract.id, 'outcome', band)" class="field-help">Describe the public result for this roll band. Mechanical effects are configured separately.</p><small v-for="(effect, index) in contract.outcomes[band].effects" :key="index" style="display: block">{{ effectLabel(effect) }}</small></div></article>
                  <details v-if="reviewClassification === 'action' && contracts.length"><summary>Edit typed effects, helpers & dependencies</summary><p class="muted"><small>Use the complete contract data. The server validates effects, actors, dependencies, and available traits before approval.</small></p><label>Contract data<textarea :aria-describedby="helpId('contract-data')" v-model="contractJson" rows="14" spellcheck="false" /></label><p :id="helpId('contract-data')" class="field-help">Advanced contract data includes effects, helpers, and dependencies. Load contract edits before approving stakes.</p><button class="secondary" @click="useContractJson">Load contract edits</button></details>
                  <div class="actions" style="margin-top: 1rem"><button :disabled="busy" data-testid="approve-stakes" @click="approveStakes">Approve stakes</button><button class="secondary" :disabled="busy || !beat.stakesApproved || contractsDirty" data-testid="lock" @click="lock">Lock input{{ contracts.some(item => item.ruling === 'check') ? ' & roll' : '' }}</button></div>
                </template>
                <template v-if="['locked', 'draft_review'].includes(beat.phase)"><div v-if="beat.resolution?.rolls.length" class="rolls"><div v-for="roll in beat.resolution.rolls" :key="roll.id" class="roll"><strong>{{ roll.total }}</strong>{{ roll.faces.join(' + ') }} + {{ roll.traitModifier }}<span v-if="roll.edge"> + 1 Edge</span><small>{{ nameOf(roll.actorCharacterId) }} · {{ roll.band === 'costly' ? 'Success with a cost' : roll.band }}</small></div></div><p class="muted"><small>Input and results are fixed. Retrying narration keeps the same dice.</small></p><div class="actions"><button :disabled="busy" data-testid="render" @click="render">{{ beat.draft ? 'Regenerate script' : 'Draft the scene' }}</button><button class="secondary" :disabled="busy" @click="addNarration">Add manual narration</button><button class="secondary" :disabled="busy" @click="addNpc">Add NPC dialogue</button></div>
                  <div v-for="(segment, index) in script" :key="scriptRowKey(segment)" class="segment"><template v-if="segment.kind === 'npc_dialogue'"><label>Speaker<select :aria-describedby="helpId('script', scriptRowKey(segment), 'speaker')" v-model="segment.speakerNpcId"><option v-for="npc in snapshot.npcs.filter(item => item.status === 'present')" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option></select></label><p :id="helpId('script', scriptRowKey(segment), 'speaker')" class="field-help">Choose the present non-player character whose name and voice will deliver this dialogue.</p></template><label>{{ segment.kind === 'narration' ? 'Narrator' : 'NPC dialogue' }}<textarea :aria-describedby="helpId('script', scriptRowKey(segment), 'text')" v-model="segment.text" :data-testid="`script-segment-${index}`" /></label><p :id="helpId('script', scriptRowKey(segment), 'text')" class="field-help">Edit this unpublished narration or dialogue. Save script edits before publishing the beat.</p><FieldGenerator v-if="segment.kind === 'narration' || segment.kind === 'npc_dialogue'" v-model="segment.text" :field="segment.kind === 'narration' ? 'script.narration' : 'script.npcDialogue'" :context-key="`${scriptContext}:${scriptRowKey(segment)}:${segment.speakerNpcId}`" :premise="director.session.brief?.premise" :premise-label="`Session scenario: ${director.session.title}`" :disabled="busy" /><button class="quiet" :disabled="busy" @click="script.splice(index, 1)">Remove segment</button></div>
                  <button v-if="script.length" class="secondary" :disabled="busy || script.some(segment => !segment.text.trim())" @click="saveScript">Save script edits</button>
                  <div v-if="beat.draft" style="margin-top: 1.5rem"><p v-if="beat.draft.directorSummary" class="private-note">{{ beat.draft.directorSummary }}</p><details v-if="beat.draft.continuity.length"><summary>Review {{ beat.draft.continuity.length }} proposed continuity updates</summary><p v-for="(update, index) in beat.draft.continuity" :key="index" class="private-note">{{ update.kind === 'npc_knowledge' ? `${snapshot.npcs.find(npc => npc.id === update.npcId)?.displayName} learns (${update.category}): ${update.statement}` : `World fact: ${update.text}` }}</p><button class="secondary" :disabled="busy || scriptDirty" @click="approveContinuity">Approve continuity updates</button><p v-if="scriptDirty" class="muted"><small>Save your script edits before approving continuity.</small></p></details><div v-if="beat.resolution?.effects.length" class="notice"><strong>Changes on publication</strong><p v-for="(effect, index) in beat.resolution.effects" :key="index" style="margin: .25rem 0">{{ effectLabel(effect) }}</p></div><p class="muted"><small>Player quotes are inserted verbatim from locked submissions. Only saved script edits will be published.</small></p><DraftAudioPanel :session-id="sessionId" :beat-id="beat.id" :beat-revision="beat.revision" :draft-revision="beat.draftRevision" :generation="beat.generation" :dirty="scriptDirty" :busy="busy" :rendering="rendering" @publish="publish" /><button :disabled="busy || scriptDirty || rendering" data-testid="publish" @click="publish()">Publish text-only beat</button></div>
                </template>
                <details><summary>Abandon this beat</summary><p class="muted"><small>This records the reason and closes the current beat. Published history is preserved.</small></p><label>Reason for abandoning this beat<textarea :aria-describedby="helpId('abort')" v-model="abortReason" data-testid="abort-reason" maxlength="6000" rows="2" /></label><p :id="helpId('abort')" class="field-help">Record a private reason for abandoning this unfinished beat. Published history is preserved.</p><button class="secondary" data-testid="abort-beat" :disabled="busy || !abortReason.trim()" @click="abortBeat">Abort beat</button></details>
              </template>
            </div><section class="panel"><div class="panel-heading"><h2>On the stage</h2><small>Published only</small></div><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /><AudioPanel :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="true" /></section></section>
          <aside class="stack"><section class="panel"><p class="eyebrow">In the room</p><div v-for="npc in director.npcDetails" :key="npc.id" class="queue-item"><h3>{{ npc.displayName }}</h3><p class="muted">{{ npc.role }} · {{ npc.status }}</p><details><summary>Director notes & memory</summary><p class="private-note">{{ npc.goal }}</p><p v-for="secret in npc.secrets" :key="secret" class="private-note">Secret: {{ secret }}</p><p v-for="memory in npc.knowledge" :key="memory.id" class="private-note">{{ memory.category }} · {{ memory.statement }}</p></details></div></section><section class="panel"><p class="eyebrow">Private direction</p><p class="private-note">{{ director.directorNotes }}</p></section><section class="panel"><p class="eyebrow">The cast</p><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><span class="avatar">{{ initials(character.displayName) }}</span><div><strong>{{ character.displayName }}</strong><small>Strain {{ character.strain }}/4</small></div></div></section></aside>
        </div>
        <div v-else-if="player" class="player-workspace"><section class="stack"><div class="panel"><p class="eyebrow">The shared story</p><Story :history="snapshot.history.slice(-3)" :characters="snapshot.characters" :corrections="snapshot.corrections" /><AudioPanel :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="false" /></div><section v-if="publicStakes.length" class="panel"><h2>The wager</h2><article v-for="stake in publicStakes" :key="stake.id" class="contract"><h3>{{ nameOf(stake.actorCharacterId) }} · {{ stake.risk }} risk · {{ stake.trait }}</h3><p>{{ stake.intent }}</p><div v-for="band in (['clean', 'costly', 'setback'] as const)" :key="band" class="branch"><strong>{{ band === 'clean' ? 'Clean success' : band === 'costly' ? 'Success with a cost' : 'Setback' }}</strong><p>{{ stake.outcomes[band] }}</p></div><p v-if="stake.helperCharacterIds.length"><small>Helpers: {{ stake.helperCharacterIds.map(nameOf).join(', ') }}</small></p></article></section></section>
          <aside class="stack"><section class="panel"><p class="eyebrow">Your character</p><h2>{{ player.ownCharacter?.displayName ?? 'Unassigned seat' }}</h2><p v-if="!playerReady" class="notice">Review your approved card and accept the boundaries before speaking or acting. You can still send an out-of-character question.<a :href="identityPath(`/sessions/${sessionId}/lobby`)">Review cast & lobby</a></p><p v-if="player.ownCharacter" class="muted"><span v-for="(value, trait) in player.ownCharacter.traits" :key="trait">{{ trait }} +{{ value }} &nbsp; </span><br>Strain {{ player.ownCharacter.strain }}/4 {{ player.ownCharacter.strain === 4 ? '· Needs help; you can still speak.' : '' }}</p><form data-testid="submission-form" @submit.prevent="saveSubmission"><div class="tabs" aria-label="Submission type"><button v-for="tab in (['say', 'act', 'ooc'] as const)" :key="tab" type="button" :class="{ secondary: kind !== tab }" :aria-pressed="kind === tab" @click="kind = tab; beginInput()">{{ tab === 'say' ? 'Say' : tab === 'act' ? 'Act' : 'Out of character' }}</button></div><template v-if="kind === 'say'"><label>Addressed to<select :aria-describedby="helpId('recipient')" v-model="recipient" @change="beginInput"><option value="">The party</option><option v-for="npc in snapshot.npcs.filter(item => item.status === 'present')" :key="npc.id" :value="npc.id">{{ npc.displayName }} · {{ npc.role }}</option></select></label><p :id="helpId('recipient')" class="field-help">Address your words to the party or a non-player character currently in the scene.</p></template><template v-if="kind === 'act'"><label>What do you want to achieve?<textarea :aria-describedby="helpId('player-intent')" v-model="intent" data-testid="intent-input" required maxlength="2000" @input="beginInput" /></label><p :id="helpId('player-intent')" class="field-help">Tell the director what result your character wants to achieve.</p><label>How will you do it?<textarea :aria-describedby="helpId('player-approach')" v-model="approach" data-testid="approach-input" required maxlength="2000" @input="beginInput" /></label><p :id="helpId('player-approach')" class="field-help">Tell the director how your character will attempt that goal.</p></template><label>{{ kind === 'ooc' ? 'Question for the director' : kind === 'act' ? 'Exact dialogue (optional)' : 'Your exact words' }}<textarea :aria-describedby="helpId('speech')" v-model="speech" data-testid="speech-input" :required="kind !== 'act'" maxlength="4000" :placeholder="kind === 'say' ? 'What do you want to say?' : ''" @input="beginInput" /></label><p :id="helpId('speech')" class="field-help">{{ kind === 'ooc' ? 'A private question for you and the director, never published as dialogue.' : 'These words appear verbatim after director selection, locking, and publication.' }}</p><template v-if="kind === 'say'"><label>Stage direction (optional)<input :aria-describedby="helpId('stage-direction')" v-model="stageDirection" maxlength="1000" placeholder="An incidental gesture, not a consequential action" @input="beginInput"></label><p :id="helpId('stage-direction')" class="field-help">Add an incidental gesture alongside your words. Submit consequential actions through Act.</p></template><template v-if="kind !== 'ooc'"><label class="check"><input :aria-describedby="helpId('already-spoken')" v-model="alreadySpoken" type="checkbox" @change="beginInput">I already said this on our voice call</label><p :id="helpId('already-spoken')" class="field-help">Mark words already spoken on your voice call. You still need to send them to the director.</p></template><small v-if="dirty">Unsaved · stays here until you send it</small><div v-if="dirty && inputContext && (inputContext.epoch !== snapshot.session.inputEpoch || inputContext.beatId !== context().beatId)" class="notice">The input window changed while you were writing. Review your words before queueing them for the current situation.<button type="button" class="secondary" data-testid="review-current-input" @click="inputContext = context()">I reviewed this for the current beat</button></div><small v-if="editing">Editing saved submission {{ editing.revision }}. Changes invalidate its reviewed stakes.</small><div class="actions"><button :disabled="busy || !player.ownCharacter || (kind !== 'ooc' && !playerReady)">{{ busy ? 'Saving…' : editing ? 'Save revision' : 'Send to director' }}</button><button v-if="editing" type="button" class="quiet" @click="resetInput">Cancel edit</button></div><small>{{ kind === 'ooc' ? 'Out-of-character questions are never published as dialogue.' : 'Your words become public after director review. The storyteller cannot speak or choose for you.' }}</small></form></section>
            <section v-if="player.submissions.length" class="panel"><h3>Your submissions</h3><div v-for="item in player.submissions.slice(-6).reverse()" :key="item.id" class="queue-item"><small>{{ item.kind }} · {{ item.status }} · Revision {{ item.revision }}</small><p>{{ item.kind === 'act' ? item.intent : item.text }}</p><button v-if="['queued', 'selected'].includes(item.status)" class="secondary" :disabled="busy" @click="editSubmission(item)">Edit submission</button></div></section>
            <section class="panel"><p class="eyebrow">At the table</p><div class="cast"><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><span class="avatar">{{ initials(character.displayName) }}</span><div><strong>{{ character.displayName }}</strong><small>Strain {{ character.strain }}/4</small></div></div></div></section>
          </aside>
        </div>
        <section v-else class="panel"><Story :history="latestHistory" :characters="snapshot.characters" :corrections="snapshot.corrections" /></section>
      </template>
    </main>
  </template>
</template>
