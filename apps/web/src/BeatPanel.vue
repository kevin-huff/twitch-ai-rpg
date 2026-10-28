<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, toRaw, useId, watch } from 'vue';
import type { ActionContract, AiSegment, Beat } from '@rpg/contracts';
import { ActionContractSchema, hasAudioTags, playerWords, stripAudioTags } from '@rpg/contracts';
import { useTable } from './table';
import DraftAudioPanel from './DraftAudioPanel.vue';
import StakesCards from './StakesCards.vue';
import ScriptEditor from './ScriptEditor.vue';
import BeatStepper from './BeatStepper.vue';
import { bandLabel } from './stage-format';
import type { VoiceState } from './voice-state';
import { GOLD_LABELS, GOLD_TEST_IDS, beatStep, goldAction, stepPosition, usesActionSteps, type GoldAction } from './beat-step';

const props = withDefaults(defineProps<{ selected: string[]; showAudio?: 'checking' | 'presenting' | 'none' | 'unknown'; playbackError?: string }>(), { showAudio: 'checking', playbackError: '' });
const emit = defineEmits<{ published: [beatId: string, voiced: boolean]; 'start-playback': [] }>();
const selected = computed(() => props.selected);

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const { sessionId, stage, snapshot, busy, director, work, send, onSnapshot, nameOf, phaseName, effectLabel } = useTable();

const MAX_PLANNED_LINES = 12;
const beat = computed(() => director.value?.activeBeat ?? null);
const contracts = ref<ActionContract[]>([]);
const reviewClassification = ref<'ordinary' | 'action'>('ordinary');
const abortReason = ref('');
const script = ref<AiSegment[]>([]);
const scriptEpoch = ref(0);
const scriptEditor = ref<InstanceType<typeof ScriptEditor> | null>(null);
const steerText = ref('');
const currentNote = computed(() => { const text = beat.value?.steering?.trim() ?? ''; return /[.!?…]$/.test(text) ? text : `${text}.`; });
const scriptContext = computed(() => `${sessionId}:${beat.value?.id}:${beat.value?.revision}:${scriptEpoch.value}`);
const savedClassification = computed<'ordinary' | 'action'>(() => beat.value?.classification === 'ordinary' ? 'ordinary' : 'action');
const contractsDirty = computed(() => JSON.stringify(reviewClassification.value === 'ordinary' ? [] : contracts.value) !== JSON.stringify(beat.value?.contracts ?? []) || reviewClassification.value !== savedClassification.value);
const scriptDirty = computed(() => JSON.stringify(script.value) !== JSON.stringify(beat.value?.draft?.segments ?? []));
const rendering = computed(() => director.value?.jobs.some(job => job.beatId === beat.value?.id && job.generation === beat.value?.generation && job.task === 'render' && ['queued', 'running'].includes(job.status)) ?? false);
const paused = computed(() => snapshot.value?.session.status === 'paused');
const continuityPending = computed(() => {
  const draft = beat.value?.draft;
  if (!draft || beat.value?.approvedContinuity?.length) return 0;
  return draft.continuity.length;
});
const tickedIds = computed(() => {
  const order = new Map((director.value?.submissions ?? []).map((item, index) => [item.id, index]));
  return [...selected.value].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)).slice(0, MAX_PLANNED_LINES);
});
const stepInput = computed(() => ({ beat: beat.value, selectedCount: selected.value.length, contractsDirty: contractsDirty.value, scriptDirty: scriptDirty.value, rendering: rendering.value, paused: paused.value, continuityPending: continuityPending.value }));
const ordinary = computed(() => reviewClassification.value === 'ordinary' && beat.value?.classification !== 'needs_action');
const quickLock = computed(() => ['stakes', 'lock'].includes(beatStep(stepInput.value).step) && ordinary.value);
const step = computed(() => beatStep(quickLock.value ? { ...stepInput.value, quickLock: true } : stepInput.value));
const idle = computed(() => !beat.value || ['published', 'aborted'].includes(beat.value.phase));
const showStakes = computed(() => !idle.value && (beat.value!.phase === 'stakes_review' || (beat.value!.phase === 'collecting' && beat.value!.selectedSubmissionIds.length > 0 && Boolean(beat.value!.lastError))));
const showScript = computed(() => !idle.value && ['locked', 'draft_review'].includes(beat.value!.phase));
const position = computed(() => stepPosition(step.value.step, usesActionSteps(idle.value ? null : beat.value, showStakes.value ? reviewClassification.value : undefined)));
const gold = computed<GoldAction>(() => goldAction({ step: step.value.step, beat: idle.value ? null : beat.value, paused: paused.value, ordinary: ordinary.value }));

const barError = ref('');
const running = ref<{ task: 'plan' | 'render'; since: number } | null>(null);
const seenJobs = reactive(new Map<string, number>());
const activeJob = computed(() => idle.value ? null : director.value?.jobs.find(job => job.beatId === beat.value?.id && job.generation === beat.value?.generation && ['queued', 'running'].includes(job.status)) ?? null);
watch(activeJob, job => { if (job && !seenJobs.has(job.id)) seenJobs.set(job.id, Date.now()); }, { immediate: true });
const now = ref(Date.now());
const working = computed(() => running.value ?? (activeJob.value ? { task: activeJob.value.task, since: seenJobs.get(activeJob.value.id) ?? now.value } : null));
const voice = ref<VoiceState>({ status: 'checking' });
const skipFacts = ref(false);
const waiting = ref<{ beatId: string; draftRevision: number } | null>(null);
const playerLines = computed(() => (beat.value?.lockedSubmissions ?? []).filter(line => line.kind !== 'ooc' && playerWords(line).trim()).map(line => ({ id: line.id, characterId: line.characterId, action: line.kind === 'act', words: playerWords(line) })));
const hasDraft = computed(() => Boolean(!idle.value && showScript.value && beat.value?.draft));
const voicePending = computed(() => voice.value.status === 'checking' || voice.value.status === 'preparing');
const statusText = computed(() => {
  const task = working.value;
  if (task) {
    const seconds = Math.max(0, Math.floor((now.value - task.since) / 1000));
    return task.task === 'plan' ? `Planning… ${seconds} s` : `Writing the script… ${seconds} s`;
  }
  if (waiting.value) return 'Waiting for the voice, then publishing…';
  if (busy.value || !hasDraft.value || scriptDirty.value || rendering.value || !['review', 'publish'].includes(step.value.step)) return '';
  if (voicePending.value) return 'Preparing voice…';
  return voice.value.status === 'ready' ? 'Voice ready' : '';
});
const chainLabel = ref<string | null>(null);
const goldLabel = computed(() => chainLabel.value ?? (gold.value === 'publish' && voicePending.value && !scriptDirty.value ? 'Preparing voice…' : GOLD_LABELS[gold.value]));
const noShowAudio = computed(() => hasDraft.value && voice.value.status !== 'unavailable' && props.showAudio === 'none');
let ticker: ReturnType<typeof setInterval> | undefined;
watch(() => Boolean(working.value), active => {
  if (ticker) { clearInterval(ticker); ticker = undefined; }
  if (!active) return;
  now.value = Date.now();
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
onUnmounted(() => { if (ticker) clearInterval(ticker); });
const errorText = computed(() => barError.value || (!idle.value && beat.value?.lastError) || '');

const needsLines = computed(() => ['answer', 'plan'].includes(gold.value));
const MAX_ROLLS_PER_ROUND = 6;
const tickedLineCount = computed(() => {
  const kinds = new Map((director.value?.submissions ?? []).map(item => [item.id, item.kind]));
  return selected.value.filter(id => kinds.get(id) !== 'ooc').length;
});
const tooManyLines = computed(() => needsLines.value && tickedLineCount.value > MAX_ROLLS_PER_ROUND);
const tooManyWarning = computed(() => `${tickedLineCount.value} lines need ${tickedLineCount.value} rolls, and a round shows at most six. Untick some lines, then plan the rest next round.`);
const goldDisabled = computed(() => {
  if (busy.value) return true;
  if (gold.value === 'resume') return false;
  if (needsLines.value && !tickedIds.value.length) return true;
  if (tooManyLines.value) return true;
  if (gold.value === 'publish') return scriptDirty.value || rendering.value || Boolean(working.value) || Boolean(waiting.value) || voice.value.status === 'failed';
  return Boolean(working.value);
});
const locked = computed(() => busy.value || paused.value);

const root = ref<HTMLElement | null>(null);
const actionsBar = ref<HTMLElement | null>(null);
const more = ref<HTMLDetailsElement | null>(null);
watch(scriptDirty, dirty => { if (dirty && more.value) more.value.open = true; });
function focusPrimary() {
  root.value?.scrollIntoView?.({ block: 'start' });
  const goldButton = Array.from(actionsBar.value?.querySelectorAll<HTMLButtonElement>('.beat-actions button') ?? []).find(button => !button.disabled && !button.classList.contains('secondary') && !button.classList.contains('quiet'));
  if (goldButton) { goldButton.focus(); return; }
  actionsBar.value?.focus();
}
defineExpose({ focusPrimary });
const confirmRegenerate = ref<null | 'plain' | 'note' | 'replace'>(null);
watch(() => `${beat.value?.id}:${beat.value?.revision}`, () => { confirmRegenerate.value = null; });
watch(() => `${beat.value?.id}:${beat.value?.draftRevision}`, () => { skipFacts.value = false; });
watch(() => beat.value?.id, () => { barError.value = ''; steerText.value = ''; });
watch(reviewClassification, value => { if (value === 'action') ensureContracts(); });
let editorRevision = '';

function applyEditorReset(next: NonNullable<typeof snapshot.value>) {
  if (next.role === 'director' && !stage) {
    const key = next.activeBeat ? `${next.activeBeat.id}:${next.activeBeat.revision}` : '';
    if (key !== editorRevision) {
      editorRevision = key;
      contracts.value = structuredClone(next.activeBeat?.contracts ?? []);
      reviewClassification.value = next.activeBeat?.classification === 'ordinary' ? 'ordinary' : 'action';
      ensureContracts();
      script.value = structuredClone(next.activeBeat?.draft?.segments ?? []);
      scriptEpoch.value++;
    }
  }
}
if (snapshot.value) applyEditorReset(toRaw(snapshot.value));
const stopListening = onSnapshot(applyEditorReset);
onUnmounted(stopListening);

function beatMeta() {
  if (!beat.value) throw new Error('There is no active beat.');
  return { commandId: crypto.randomUUID(), beatId: beat.value.id, expectedBeatRevision: beat.value.revision };
}

function runBar(task: () => Promise<void>) {
  barError.value = '';
  return work(async () => {
    try { await task(); }
    catch (cause) { barError.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
    finally { running.value = null; }
  });
}
function reached(beatId: string, phase: Beat['phase']) {
  const current = beat.value;
  return Boolean(current && current.id === beatId && !current.lastError && current.phase === phase);
}
async function planStep(submissionIds: string[]) {
  running.value = { task: 'plan', since: Date.now() };
  try { await send({ type: 'plan_beat', ...beatMeta(), submissionIds }); } finally { running.value = null; }
}
async function renderStep() {
  running.value = { task: 'render', since: Date.now() };
  try { await send({ type: 'render_beat', ...beatMeta() }); } finally { running.value = null; }
}
async function lockAndDraftSteps(beatId: string) {
  await send({ type: 'approve_stakes', ...beatMeta(), classification: 'ordinary', contracts: [] });
  if (!reached(beatId, 'stakes_review') || !beat.value?.stakesApproved) return;
  await send({ type: 'lock_beat', ...beatMeta() });
  if (!reached(beatId, 'locked')) return;
  await renderStep();
}
function checkedContracts() {
  const proposed = reviewClassification.value === 'ordinary' ? [] : structuredClone(toRaw(contracts.value));
  if (reviewClassification.value === 'action' && !proposed.length) throw new Error('An action needs a reviewed contract for the selected input.');
  for (const contract of proposed) {
    const critical = contract.outcomes.critical;
    if (critical && !critical.publicText.trim() && !critical.effects.length) delete contract.outcomes.critical;
  }
  if (proposed.some(contract => !contract.intent.trim() || !contract.approach.trim() || Object.values(contract.outcomes).some(branch => !branch.publicText.trim()))) throw new Error('Fill in the goal, approach and every outcome before approving stakes.');
  return proposed.map(contract => ActionContractSchema.parse(contract));
}

function openBeat(mode: 'conversation' | 'action') { return runBar(() => send({ type: 'open_beat', commandId: crypto.randomUUID(), expectedInputEpoch: snapshot.value!.session.inputEpoch, kind: mode })); }
function answerLines() {
  const ids = tickedIds.value;
  if (!ids.length) return;
  return runBar(async () => {
    await send({ type: 'open_beat', commandId: crypto.randomUUID(), expectedInputEpoch: snapshot.value!.session.inputEpoch, kind: 'conversation' });
    if (!beat.value || !reached(beat.value.id, 'collecting')) return;
    await planStep(ids);
  });
}
function plan() { const ids = tickedIds.value; if (!ids.length) return; return runBar(() => planStep(ids)); }
function lockAndDraft() {
  if (paused.value || !ordinary.value) return;
  return runBar(async () => { if (beat.value) await lockAndDraftSteps(beat.value.id); });
}
function approveAndRoll() {
  if (paused.value) return;
  return runBar(async () => {
    const checked = checkedContracts();
    const beatId = beatMeta().beatId;
    await send({ type: 'approve_stakes', ...beatMeta(), classification: reviewClassification.value, contracts: checked });
    if (!reached(beatId, 'stakes_review') || !beat.value?.stakesApproved) return;
    await send({ type: 'lock_beat', ...beatMeta() });
    if (!reached(beatId, 'locked')) return;
    await renderStep();
  });
}
function approveStakes() { return runBar(async () => {
  const checked = checkedContracts();
  await send({ type: 'approve_stakes', ...beatMeta(), classification: reviewClassification.value, contracts: checked });
}); }
function resumeShow() { return runBar(() => send({ type: 'set_status', commandId: crypto.randomUUID(), status: 'live', expectedStateRevision: snapshot.value!.session.stateRevision })); }
function ensureContracts() {
  if (reviewClassification.value !== 'action' || contracts.value.length) return;
  const clean = (value: string) => hasAudioTags(value) ? stripAudioTags(value) : value;
  const order = new Map((director.value?.submissions ?? []).map((item, index) => [item.id, index]));
  const inputs = (director.value?.submissions.filter(item => beat.value?.selectedSubmissionIds.includes(item.id) && item.kind !== 'ooc') ?? [])
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const blank = () => ({ publicText: '', effects: [] });
  contracts.value = inputs.map(item => {
    const action = item.kind === 'act';
    return {
      id: crypto.randomUUID(), version: 1, actorCharacterId: item.characterId, helperCharacterIds: [], submissionIds: [item.id],
      intent: action ? clean(item.intent) : `Resolve the requested concession: ${clean(item.text)}`,
      approach: action ? clean(item.approach) : 'Use the submitted dialogue.', ruling: 'check', trait: action ? 'wits' : 'presence', edge: 0, edgeReason: null,
      risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: { clean: blank(), costly: blank(), setback: blank(), critical: blank() },
    };
  });
}
function abortBeat() { return runBar(async () => { await send({ type: 'abort_beat', ...beatMeta(), reason: abortReason.value.trim() }); abortReason.value = ''; }); }
function lock() { return runBar(() => send({ type: 'lock_beat', ...beatMeta() })); }
function render() {
  if (paused.value) return;
  if (beat.value?.draft) { confirmRegenerate.value = 'plain'; return; }
  if (scriptDirty.value) { confirmRegenerate.value = 'replace'; return; }
  return runRender();
}
function runRender() { return runBar(renderStep); }
function regenerate() {
  if (paused.value) return;
  const note = steerText.value.trim();
  if (!note) return render();
  if (scriptDirty.value) { confirmRegenerate.value = 'note'; return; }
  confirmRegenerate.value = null;
  return runNoteRegenerate(note);
}
function runNoteRegenerate(note: string) {
  return runBar(async () => {
    const beatId = beatMeta().beatId;
    await send({ type: 'set_beat_steering', ...beatMeta(), text: note });
    if (!beat.value || beat.value.id !== beatId || beat.value.lastError) return;
    await renderStep();
    if (beat.value?.id === beatId && !beat.value.lastError) steerText.value = '';
  });
}
function writeItMyself() { scriptEditor.value?.addNarration(); }
function confirmRender() {
  const mode = confirmRegenerate.value;
  confirmRegenerate.value = null;
  if (mode === 'note') {
    const note = steerText.value.trim();
    return note ? runNoteRegenerate(note) : runRender();
  }
  return runRender();
}
function saveScript() { return runBar(() => send({ type: 'edit_script', ...beatMeta(), segments: JSON.parse(JSON.stringify(script.value)) })); }
function onVoice(state: VoiceState) { voice.value = state; }
function publishable() { return hasDraft.value && !scriptDirty.value && !rendering.value && !paused.value; }
function runPublish(audioPreparationId?: string) {
  waiting.value = null;
  if (!publishable()) return;
  return runBar(async () => {
    const current = beat.value!;
    const beatId = current.id;
    const draftRevision = current.draftRevision;
    if (continuityPending.value > 0 && !skipFacts.value) {
      await send({ type: 'approve_continuity', ...beatMeta(), updates: current.draft!.continuity });
      const next = beat.value;
      if (!next || next.id !== beatId || next.lastError || next.phase !== 'draft_review' || next.draftRevision !== draftRevision) return;
    }
    await send({ type: 'publish_beat', ...beatMeta(), expectedStateRevision: snapshot.value!.session.stateRevision, draftRevision, textOnly: !audioPreparationId, ...(audioPreparationId ? { audioPreparationId } : {}) });
    emit('published', beatId, Boolean(audioPreparationId));
  });
}
function publish() {
  if (!publishable() || waiting.value) return;
  const state = voice.value;
  if (state.status === 'ready') return runPublish(state.preparationId);
  if (state.status === 'unavailable') return runPublish();
  if (state.status === 'failed') return;
  waiting.value = { beatId: beat.value!.id, draftRevision: beat.value!.draftRevision };
}
function publishTextOnly() {
  if (voice.value.status === 'unavailable') return;
  return runPublish();
}
watch([waiting, voice, busy, scriptDirty, rendering, paused, () => beat.value?.id, () => beat.value?.draftRevision, () => beat.value?.phase], () => {
  const wait = waiting.value;
  if (!wait) return;
  const current = beat.value;
  if (!current || current.id !== wait.beatId || current.draftRevision !== wait.draftRevision || !hasDraft.value || scriptDirty.value || rendering.value || paused.value || voice.value.status === 'failed') { waiting.value = null; return; }
  if (busy.value) return;
  if (voice.value.status === 'ready') void runPublish(voice.value.preparationId);
  else if (voice.value.status === 'unavailable') void runPublish();
});
async function runChain(action: () => Promise<void> | undefined) {
  chainLabel.value = GOLD_LABELS[gold.value];
  try { await action(); } finally { chainLabel.value = null; }
}
function runGold() {
  switch (gold.value) {
    case 'resume': return resumeShow();
    case 'answer': return runChain(answerLines);
    case 'plan': return plan();
    case 'lock-and-draft': return runChain(lockAndDraft);
    case 'approve-and-roll': return runChain(approveAndRoll);
    case 'draft': case 'try-again': return render();
    case 'publish': return publish();
  }
}
</script>


<template>
  <div v-if="director && snapshot" ref="root" class="panel beat-panel"><div class="panel-heading"><h2>{{ !beat ? 'Direct the next beat' : beat.phase === 'stakes_review' ? (beat.kind === 'action' ? 'Action round' : 'Conversation') : phaseName(beat.phase) }}</h2><span v-if="beat" class="status">{{ beat.kind }}</span></div>
      <BeatStepper :n="position.n" :m="position.m" />
      <template v-if="idle || !beat"><p class="muted">Keep the exchange short, or bring the cast together for a consequential action.</p></template>
      <template v-else>
        <StakesCards v-if="showStakes" :beat="beat" :contracts="contracts" :busy="busy" v-model:classification="reviewClassification" />
        <template v-if="showScript"><div v-if="beat.resolution?.rolls.length" class="rolls"><div v-for="roll in beat.resolution.rolls" :key="roll.id" class="roll"><strong>{{ roll.total }}</strong>{{ roll.faces.join(' + ') }} + {{ roll.traitModifier }}<span v-if="roll.edge"> + 1 Edge</span><small>{{ nameOf(roll.actorCharacterId) }} · {{ bandLabel(roll.band) }}</small></div></div><p v-if="beat.resolution?.rolls.length" class="muted"><small>The dice are rolled. Regenerating the script keeps them.</small></p>
          <section v-if="playerLines.length" class="player-lines" data-testid="player-lines"><h4>Read aloud first, word for word</h4><p v-for="line in playerLines" :key="line.id" data-testid="player-line"><strong>{{ nameOf(line.characterId) }}</strong> <span v-if="line.action" class="player-line-tag">Action</span> <span class="player-line-words">{{ line.words }}</span></p></section>
          <ScriptEditor ref="scriptEditor" :segments="script" :npcs="snapshot.npcs" :busy="busy" :context-key="scriptContext" :premise="director.session.brief?.premise" :premise-label="`Show scenario: ${director.session.title}`" />
          <div v-if="beat.draft" style="margin-top: 1.5rem"><p v-if="beat.draft.directorSummary" class="private-note">{{ beat.draft.directorSummary }}</p><section v-if="continuityPending > 0" class="beat-facts" data-testid="facts-to-remember" aria-label="Facts to remember"><strong>Facts to remember</strong><ul><li v-for="(update, index) in beat.draft.continuity" :key="index">{{ update.kind === 'npc_knowledge' ? `${snapshot.npcs.find(npc => npc.id === update.npcId)?.displayName} learns (${update.category}): ${update.statement}` : `World fact: ${update.text}` }}</li></ul><label class="check"><input v-model="skipFacts" type="checkbox" data-testid="skip-facts" :disabled="locked" />Don't keep these</label></section><div v-if="beat.resolution?.effects.length" class="notice"><strong>Changes on publication</strong><p v-for="(effect, index) in beat.resolution.effects" :key="index" style="margin: .25rem 0">{{ effectLabel(effect) }}</p></div><p class="muted"><small>Player lines and actions are read first, word for word, when you publish. Only saved script edits will be published.</small></p><DraftAudioPanel :session-id="sessionId" :beat-id="beat.id" :beat-revision="beat.revision" :draft-revision="beat.draftRevision" :generation="beat.generation" :dirty="scriptDirty" :busy="busy" :rendering="rendering" :paused="paused" @voice="onVoice" /></div>
        </template>
      </template>
      <div ref="actionsBar" class="beat-actions" role="region" tabindex="-1" aria-label="Beat actions">
        <p class="beat-next" data-testid="beat-next">{{ step.next }}<span v-if="step.reason" class="beat-reason">{{ ' ' + step.reason }}</span></p>
        <p v-if="statusText" class="beat-status" data-testid="beat-status">{{ statusText }}</p>
        <p v-if="hasDraft && !scriptDirty && voice.status === 'failed'" class="beat-status" data-testid="voice-failed">The voice could not be prepared. Press Prepare voice again, or Publish without voice.</p>
        <p v-if="noShowAudio" class="beat-status" data-testid="no-show-audio">No show audio: the main show link isn't open in OBS.</p>
        <p v-if="errorText" class="notice error beat-error" data-testid="beat-error" role="alert">{{ errorText }}</p>
        <p v-if="playbackError" class="notice error beat-error" data-testid="playback-error" role="alert">{{ playbackError }} <button type="button" class="secondary" data-testid="start-playback" @click="emit('start-playback')">Play latest reviewed beat</button></p>
        <div v-if="(confirmRegenerate === 'plain' || confirmRegenerate === 'note') && beat?.draft && showScript" class="beat-confirm"><p>Replace the current draft? Saved script edits are discarded; the dice stay the same.</p><button class="secondary" :disabled="locked" @click="confirmRender">Yes, regenerate</button><button class="secondary" :disabled="paused" @click="confirmRegenerate = null">Keep draft</button></div>
        <div v-if="confirmRegenerate === 'replace' && beat" class="beat-confirm"><p>Replace what you wrote? The AI writes a new script and the lines you typed are lost. The dice stay the same.</p><button class="secondary" :disabled="locked" data-testid="confirm-replace" @click="confirmRender">Yes, replace it</button><button class="secondary" :disabled="paused" data-testid="keep-written" @click="confirmRegenerate = null">Keep what I wrote</button></div>
        <div class="actions">
          <button :data-testid="GOLD_TEST_IDS[gold]" :disabled="goldDisabled" @click="runGold">{{ goldLabel }}</button>
          <p v-if="tooManyLines" class="beat-status" data-testid="too-many-lines">{{ tooManyWarning }}</p>
          <button v-if="step.step === 'open'" class="secondary" :disabled="locked" data-testid="open-action" @click="openBeat('action')">Open action round</button>
          <button v-if="hasDraft && voice.status !== 'unavailable'" class="secondary" :disabled="locked || scriptDirty || rendering || Boolean(working)" data-testid="publish-text-only" @click="publishTextOnly">Publish without voice</button>
          <button v-if="step.step === 'draft' && !idle && beat?.lastError" class="secondary" :disabled="locked" data-testid="write-it-myself" @click="writeItMyself">Write it myself</button>
        </div>
        <details ref="more" class="beat-more" data-testid="beat-more"><summary>More</summary>
          <div class="actions">
            <button v-if="step.step === 'open'" class="secondary" :disabled="locked" data-testid="open-conversation" @click="openBeat('conversation')">Open conversation</button>
            <template v-if="!idle && (step.step === 'stakes' || step.step === 'lock')">
              <button class="secondary" :disabled="locked" data-testid="approve-stakes" @click="approveStakes">Approve stakes</button>
              <button class="secondary" :disabled="locked || !beat?.stakesApproved || contractsDirty" data-testid="lock" @click="lock">Roll the dice</button>
              <button class="secondary" :disabled="locked || !tickedIds.length || Boolean(working)" data-testid="plan-again" @click="plan">Plan again</button>
            </template>
            <template v-if="showScript && beat?.draft">
              <label class="steer-note">Tell the AI what to change<input v-model="steerText" type="text" maxlength="3000" data-testid="steer-text" :disabled="locked || Boolean(working)" @keydown.enter.prevent="regenerate" /></label>
              <p v-if="beat.steering" class="field-help" data-testid="current-note">Current note: {{ currentNote }} What you type here replaces it.</p>
              <button class="secondary" :disabled="locked || Boolean(working)" data-testid="regenerate" @click="regenerate">Regenerate script</button>
            </template>
            <button v-if="showScript && scriptDirty" class="secondary" :disabled="locked || script.some(segment => !segment.text.trim())" data-testid="save-script" @click="saveScript">Save edits</button>
          </div>
          <details v-if="!idle && beat" class="beat-abandon"><summary>Abandon this beat</summary><p class="muted"><small>This records the reason and closes the current beat. Published history is preserved.</small></p><label>Reason for abandoning this beat<textarea :aria-describedby="helpId('abort')" v-model="abortReason" data-testid="abort-reason" maxlength="6000" rows="2" :disabled="paused" /></label><p :id="helpId('abort')" class="field-help">Record a private reason for abandoning this unfinished beat. Published history is preserved.</p><button class="secondary" data-testid="abort-beat" :disabled="locked || !abortReason.trim()" @click="abortBeat">Abandon beat</button></details>
        </details>
      </div>
  </div>
</template>

<style scoped>
.beat-actions { position: sticky; bottom: 0; z-index: 10; display: grid; gap: 12px; margin: 20px -18px -18px; padding: 16px 24px; background: var(--night); box-shadow: inset 0 2px 0 0 var(--night-raised); }
.beat-actions .actions { gap: 12px; }
.beat-next { margin: 0; }
.beat-status { margin: 0; color: var(--dust); font-size: 20px; line-height: 24px; }
.beat-error { margin: 0; }
.beat-more > summary, .beat-abandon > summary { color: var(--dust); }
.beat-more > summary:hover, .beat-abandon > summary:hover { color: var(--candle); }
.beat-more .actions { margin-top: 12px; }
.beat-abandon { margin-top: 12px; }
.beat-reason { color: var(--dust); }
.beat-confirm { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 16px 20px; }
.beat-confirm::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void); clip-path: var(--cut-1); }
.beat-confirm p { flex: 1 1 288px; margin: 0; }
.steer-note { flex: 1 1 256px; }
.beat-facts { position: relative; margin: 16px 0; padding: 16px 20px; }
.beat-facts::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); }
.beat-facts strong { display: block; font-family: var(--font-label); font-size: 16px; line-height: 20px; color: var(--candle); }
.beat-facts ul { margin: 8px 0 12px; padding-left: 24px; }
.player-lines { position: relative; margin: 16px 0; padding: 16px 20px; }
.player-lines::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); }
.player-lines h4 { margin: 0 0 8px; font-family: var(--font-label); font-size: 16px; line-height: 20px; font-weight: normal; text-transform: uppercase; color: var(--dust); }
.player-lines p { margin: 0 0 8px; }
.player-lines strong { color: var(--candle); font-weight: normal; }
.player-line-tag { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; color: var(--dust); }
.player-line-words { color: var(--bone); white-space: pre-wrap; }
</style>
