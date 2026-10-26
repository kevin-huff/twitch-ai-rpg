<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, toRaw, useId, watch } from 'vue';
import type { ActionContract, AiSegment } from '@rpg/contracts';
import { ActionContractSchema } from '@rpg/contracts';
import { useTable } from './table';
import DraftAudioPanel from './DraftAudioPanel.vue';
import FieldGenerator from './FieldGenerator.vue';
import BeatStepper from './BeatStepper.vue';
import { STEP_LABELS, beatStep } from './beat-step';

const STAGE_GOAL_CHARS = 90;
const STAGE_OUTCOME_CHARS = 110;
function stageLength(text: string, limit: number) {
  const count = text.length;
  return count > limit
    ? { over: true, text: `Too long for the stage: it fits about ${limit} characters and this has ${count}. Shorten it so viewers can read all of it.` }
    : { over: false, text: `On stage: ${count} of ${limit} characters` };
}

const props = defineProps<{ selected: string[] }>();
const selected = computed(() => props.selected);

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const { sessionId, stage, snapshot, error, notice, busy, director, work, send, onSnapshot, nameOf, phaseName, effectLabel } = useTable();

const beat = computed(() => director.value?.activeBeat ?? null);
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
const paused = computed(() => snapshot.value?.session.status === 'paused');
const continuityPending = computed(() => {
  const draft = beat.value?.draft;
  if (!draft || beat.value?.approvedContinuity?.length) return 0;
  return draft.continuity.length;
});
const stepInput = computed(() => ({ beat: beat.value, selectedCount: selected.value.length, contractsDirty: contractsDirty.value, scriptDirty: scriptDirty.value, rendering: rendering.value, paused: paused.value, continuityPending: continuityPending.value }));
const quickLock = computed(() => beatStep(stepInput.value).step === 'stakes' && reviewClassification.value === 'ordinary' && beat.value?.classification !== 'needs_action');
const step = computed(() => beatStep(quickLock.value ? { ...stepInput.value, quickLock: true } : stepInput.value));
const idle = computed(() => !beat.value || ['published', 'aborted'].includes(beat.value.phase));
const showPlan = computed(() => !idle.value && ['collecting', 'stakes_review'].includes(beat.value!.phase));
const showStakes = computed(() => !idle.value && (beat.value!.phase === 'stakes_review' || (beat.value!.phase === 'collecting' && beat.value!.selectedSubmissionIds.length > 0 && Boolean(beat.value!.lastError))));
const showScript = computed(() => !idle.value && ['locked', 'draft_review'].includes(beat.value!.phase));
type PrimaryAction = 'open' | 'plan' | 'approve' | 'quick' | 'lock' | 'render' | 'save' | 'continuity' | 'publish';
const primary = computed<PrimaryAction | null>(() => {
  switch (step.value.step) {
    case 'open': return 'open';
    case 'select': case 'plan': return 'plan';
    case 'stakes': return quickLock.value ? 'quick' : 'approve';
    case 'lock': return 'lock';
    case 'draft': return beat.value?.draft ? null : 'render';
    case 'review': return scriptDirty.value ? 'save' : continuityPending.value ? 'continuity' : null;
    case 'publish': return 'publish';
  }
  return null;
});
const buttonClass = (action: PrimaryAction) => primary.value === action ? undefined : 'secondary';
const recordingReady = ref(false);
const root = ref<HTMLElement | null>(null);
const actionsBar = ref<HTMLElement | null>(null);
const emit = defineEmits<{ step: [name: string] }>();
watch(() => STEP_LABELS[step.value.step], name => emit('step', name), { immediate: true });
function focusPrimary() {
  root.value?.scrollIntoView?.({ block: 'start' });
  const gold = Array.from(actionsBar.value?.querySelectorAll<HTMLButtonElement>('.beat-actions button') ?? []).find(button => !button.disabled && !button.classList.contains('secondary') && !button.classList.contains('quiet'));
  if (gold) { gold.focus(); return; }
  const audio = actionsBar.value?.ownerDocument.querySelector<HTMLButtonElement>('[data-testid="publish-draft-audio"]');
  if (audio && !audio.disabled && root.value?.contains(audio)) { audio.focus(); return; }
  actionsBar.value?.focus();
}
defineExpose({ focusPrimary });
const confirmRegenerate = ref(false);
const pendingPublish = ref<{ audioPreparationId?: string } | null>(null);
watch(() => `${beat.value?.id}:${beat.value?.revision}`, () => { confirmRegenerate.value = false; pendingPublish.value = null; });
watch(contracts, value => { contractJson.value = JSON.stringify(value, null, 2); }, { deep: true });
let editorRevision = '';

function applyEditorReset(next: NonNullable<typeof snapshot.value>) {
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
  }
}
if (snapshot.value) applyEditorReset(toRaw(snapshot.value));
const stopListening = onSnapshot(applyEditorReset);
onUnmounted(stopListening);

function beatMeta() {
  if (!beat.value) throw new Error('There is no active beat.');
  return { commandId: crypto.randomUUID(), beatId: beat.value.id, expectedBeatRevision: beat.value.revision };
}

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
function lockAndDraft() {
  if (paused.value || !quickLock.value) return;
  return work(async () => {
    await send({ type: 'approve_stakes', ...beatMeta(), classification: 'ordinary', contracts: [] });
    if (error.value) return;
    await send({ type: 'lock_beat', ...beatMeta() });
    if (error.value) return;
    await send({ type: 'render_beat', ...beatMeta() });
  });
}
function abortBeat() { return work(async () => { await send({ type: 'abort_beat', ...beatMeta(), reason: abortReason.value.trim() }); abortReason.value = ''; }); }
function useContractJson() {
  try { contracts.value = JSON.parse(contractJson.value).map((item: unknown) => ActionContractSchema.parse(item)); error.value = ''; notice.value = 'Contract edits loaded. Review and approve to save.'; }
  catch { error.value = 'The contract data is not valid. Keep all contract fields and supported typed effects.'; }
}
function lock() { return work(() => send({ type: 'lock_beat', ...beatMeta() })); }
function render() {
  if (paused.value) return;
  if (beat.value?.draft) { confirmRegenerate.value = true; return; }
  return runRender();
}
function runRender() { return work(() => send({ type: 'render_beat', ...beatMeta() })); }
function confirmRender() { confirmRegenerate.value = false; return runRender(); }
function saveScript() { return work(() => send({ type: 'edit_script', ...beatMeta(), segments: JSON.parse(JSON.stringify(script.value)) })); }
function addNarration() { script.value.push({ kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], text: '', delivery: 'neutral' }); }
function addNpc() {
  const npc = snapshot.value?.npcs.find(item => item.status === 'present');
  if (npc) script.value.push({ kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], text: '', delivery: 'neutral' });
}
function approveContinuity() { return work(() => send({ type: 'approve_continuity', ...beatMeta(), updates: beat.value?.draft?.continuity ?? [] })); }
function publish(audioPreparationId?: string) {
  if (scriptDirty.value || rendering.value || paused.value) return;
  if (continuityPending.value > 0) { pendingPublish.value = audioPreparationId ? { audioPreparationId } : {}; return; }
  return runPublish(audioPreparationId);
}
function publishAnyway() {
  const pending = pendingPublish.value;
  if (!pending || scriptDirty.value || rendering.value || paused.value) return;
  pendingPublish.value = null;
  return runPublish(pending.audioPreparationId);
}
function runPublish(audioPreparationId?: string) {
  return work(() => send({ type: 'publish_beat', ...beatMeta(), expectedStateRevision: snapshot.value!.session.stateRevision, draftRevision: beat.value!.draftRevision, textOnly: !audioPreparationId, ...(audioPreparationId ? { audioPreparationId } : {}) }));
}
</script>


<template>
  <div v-if="director && snapshot" ref="root" class="panel beat-panel"><div class="panel-heading"><h2>{{ beat ? phaseName(beat.phase) : 'Direct the next beat' }}</h2><span v-if="beat" class="status">{{ beat.kind }}</span></div>
      <BeatStepper :step="step.step" :next="step.next" :reason="step.reason" />
      <template v-if="idle || !beat"><p class="muted">Keep the exchange short, or bring the cast together for a consequential action.</p></template>
      <template v-else>
        <p v-if="beat.lastError" class="notice error" role="alert">{{ beat.lastError }} Your accepted input and any dice are preserved.</p>
        <template v-if="showStakes"><label>How should this input resolve?<select :aria-describedby="helpId('classification')" v-model="reviewClassification" data-testid="stakes-classification" @change="ensureContracts"><option value="ordinary" :disabled="beat.classification === 'needs_action'">Ordinary conversation · no mechanical consequences</option><option value="action">Action · review the agreed goal and consequences</option></select></label><p :id="helpId('classification')" class="field-help">Choose ordinary conversation or an action that needs an agreed goal and consequences.</p><p v-if="beat.phase === 'collecting'" class="notice">Planning failed. You can review manual stakes below, retry planning, or abandon this beat with a reason.</p><p v-if="beat.classification === 'needs_action'" class="notice">This exchange has consequences. Review the action stakes before locking.</p><p v-if="reviewClassification === 'ordinary'" class="notice">Ordinary conversation. No check or mechanical effects.</p>
          <article v-for="contract in reviewClassification === 'action' ? contracts : []" :key="contract.id" class="contract"><h3>{{ nameOf(contract.actorCharacterId) }}</h3><label>Ruling<select :aria-describedby="helpId('contract', contract.id, 'ruling')" v-model="contract.ruling" data-testid="contract-ruling"><option value="check">Check · uncertain and consequential</option><option value="no_check">No check · achievable without uncertainty</option><option value="blocked">Blocked · explain the missing requirement</option></select></label><p :id="helpId('contract', contract.id, 'ruling')" class="field-help">Choose a check for uncertainty, no check for automatic success, or blocked for a missing requirement.</p><label>Agreed goal<textarea :aria-describedby="helpId('contract', contract.id, 'intent')" v-model="contract.intent" rows="2" /></label><p :id="helpId('contract', contract.id, 'intent')" class="field-help">State the result the character is trying to achieve.</p><p class="stage-length" :class="{ over: stageLength(contract.intent, STAGE_GOAL_CHARS).over }" data-testid="stage-length-goal">{{ stageLength(contract.intent, STAGE_GOAL_CHARS).text }}</p><label>Approach<textarea :aria-describedby="helpId('contract', contract.id, 'approach')" v-model="contract.approach" rows="2" /></label><p :id="helpId('contract', contract.id, 'approach')" class="field-help">Describe how the character will attempt the agreed goal.</p><div class="contract-grid"><div><label>Trait<select :aria-describedby="helpId('contract', contract.id, 'trait')" v-model="contract.trait"><option v-for="trait in ['force', 'finesse', 'wits', 'presence']" :key="trait">{{ trait }}</option></select></label><p :id="helpId('contract', contract.id, 'trait')" class="field-help">Choose the character trait whose modifier is added to the check.</p></div><div><label>Risk<select :aria-describedby="helpId('contract', contract.id, 'risk')" v-model="contract.risk"><option>low</option><option>normal</option><option>high</option></select></label><p :id="helpId('contract', contract.id, 'risk')" class="field-help">Describe the severity of the consequences; risk does not change the dice modifier.</p></div></div><p v-if="contract.helperCharacterIds.length"><small>Helpers: {{ contract.helperCharacterIds.map(nameOf).join(', ') }} · Edge +{{ contract.edge }}</small></p><div v-for="band in (['clean', 'costly', 'setback'] as const)" :key="band" class="branch"><label>{{ band === 'clean' ? '10+ · Clean success' : band === 'costly' ? '7–9 · Success with a cost' : '6 or less · Setback' }}<textarea :aria-describedby="helpId('contract', contract.id, 'outcome', band)" v-model="contract.outcomes[band].publicText" :data-testid="`outcome-${band}`" rows="2" placeholder="Write the agreed outcome and consequences" /></label><p :id="helpId('contract', contract.id, 'outcome', band)" class="field-help">Describe the public result for this roll band. Mechanical effects are configured separately.</p><p class="stage-length" :class="{ over: stageLength(contract.outcomes[band].publicText, STAGE_OUTCOME_CHARS).over }" :data-testid="`stage-length-${band}`">{{ stageLength(contract.outcomes[band].publicText, STAGE_OUTCOME_CHARS).text }}</p><small v-for="(effect, index) in contract.outcomes[band].effects" :key="index" style="display: block">{{ effectLabel(effect) }}</small></div></article>
          <details v-if="reviewClassification === 'action' && contracts.length"><summary>Edit typed effects, helpers & dependencies</summary><p class="muted"><small>Use the complete contract data. The server validates effects, actors, dependencies, and available traits before approval.</small></p><label>Contract data<textarea :aria-describedby="helpId('contract-data')" v-model="contractJson" rows="14" spellcheck="false" /></label><p :id="helpId('contract-data')" class="field-help">Advanced contract data includes effects, helpers, and dependencies. Load contract edits before approving stakes.</p><button class="secondary" @click="useContractJson">Load contract edits</button></details>
        </template>
        <template v-if="showScript"><div v-if="beat.resolution?.rolls.length" class="rolls"><div v-for="roll in beat.resolution.rolls" :key="roll.id" class="roll"><strong>{{ roll.total }}</strong>{{ roll.faces.join(' + ') }} + {{ roll.traitModifier }}<span v-if="roll.edge"> + 1 Edge</span><small>{{ nameOf(roll.actorCharacterId) }} · {{ roll.band === 'costly' ? 'Success with a cost' : roll.band }}</small></div></div><p class="muted"><small>Input and results are fixed. Retrying narration keeps the same dice.</small></p>
          <div v-for="(segment, index) in script" :key="scriptRowKey(segment)" class="segment"><template v-if="segment.kind === 'npc_dialogue'"><label>Speaker<select :aria-describedby="helpId('script', scriptRowKey(segment), 'speaker')" v-model="segment.speakerNpcId"><option v-for="npc in snapshot.npcs.filter(item => item.status === 'present')" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option></select></label><p :id="helpId('script', scriptRowKey(segment), 'speaker')" class="field-help">Choose the present non-player character whose name and voice will deliver this dialogue.</p></template><label>{{ segment.kind === 'narration' ? 'Narrator' : 'NPC dialogue' }}<textarea :aria-describedby="helpId('script', scriptRowKey(segment), 'text')" v-model="segment.text" :data-testid="`script-segment-${index}`" /></label><p :id="helpId('script', scriptRowKey(segment), 'text')" class="field-help">Edit this unpublished narration or dialogue. Save script edits before publishing the beat.</p><FieldGenerator v-if="segment.kind === 'narration' || segment.kind === 'npc_dialogue'" v-model="segment.text" :field="segment.kind === 'narration' ? 'script.narration' : 'script.npcDialogue'" :context-key="`${scriptContext}:${scriptRowKey(segment)}:${segment.speakerNpcId}`" :premise="director.session.brief?.premise" :premise-label="`Session scenario: ${director.session.title}`" :disabled="busy" /><button class="quiet" :disabled="busy" @click="script.splice(index, 1)">Remove segment</button></div>
          <div class="actions script-tools"><button class="secondary" :disabled="busy" @click="addNarration">Add manual narration</button><button class="secondary" :disabled="busy" @click="addNpc">Add NPC dialogue</button></div>
          <div v-if="beat.draft" style="margin-top: 1.5rem"><p v-if="beat.draft.directorSummary" class="private-note">{{ beat.draft.directorSummary }}</p><details v-if="beat.draft.continuity.length"><summary>Review {{ beat.draft.continuity.length }} proposed continuity updates</summary><p v-for="(update, index) in beat.draft.continuity" :key="index" class="private-note">{{ update.kind === 'npc_knowledge' ? `${snapshot.npcs.find(npc => npc.id === update.npcId)?.displayName} learns (${update.category}): ${update.statement}` : `World fact: ${update.text}` }}</p></details><div v-if="beat.resolution?.effects.length" class="notice"><strong>Changes on publication</strong><p v-for="(effect, index) in beat.resolution.effects" :key="index" style="margin: .25rem 0">{{ effectLabel(effect) }}</p></div><p class="muted"><small>Player quotes are inserted verbatim from locked submissions. Only saved script edits will be published.</small></p><DraftAudioPanel :session-id="sessionId" :beat-id="beat.id" :beat-revision="beat.revision" :draft-revision="beat.draftRevision" :generation="beat.generation" :dirty="scriptDirty" :busy="busy" :rendering="rendering" :paused="paused" :highlight="continuityPending === 0" @recording-ready="recordingReady = $event" @publish="publish" /></div>
        </template>
        <details><summary>Abandon this beat</summary><p class="muted"><small>This records the reason and closes the current beat. Published history is preserved.</small></p><label>Reason for abandoning this beat<textarea :aria-describedby="helpId('abort')" v-model="abortReason" data-testid="abort-reason" maxlength="6000" rows="2" /></label><p :id="helpId('abort')" class="field-help">Record a private reason for abandoning this unfinished beat. Published history is preserved.</p><button class="secondary" data-testid="abort-beat" :disabled="busy || !abortReason.trim()" @click="abortBeat">Abort beat</button></details>
      </template>
      <div ref="actionsBar" class="beat-actions" role="region" tabindex="-1" aria-label="Beat actions">
        <p class="beat-next"><strong class="beat-step-name">{{ STEP_LABELS[step.step] }}</strong> {{ step.next }}<span v-if="step.reason" class="beat-reason">{{ ' ' + step.reason }}</span></p>
        <div v-if="beat?.draft && showScript && continuityPending > 0" class="beat-confirm beat-continuity"><p>{{ continuityPending }} continuity updates are not approved. Characters will not remember them unless you approve.</p><button :class="buttonClass('continuity')" :disabled="busy || scriptDirty || paused" @click="approveContinuity">Approve continuity updates</button><small v-if="scriptDirty" class="muted">Save your script edits before approving continuity.</small></div>
        <div v-if="confirmRegenerate && beat?.draft && showScript" class="beat-confirm"><p>Replace the current draft? Saved script edits are discarded; the dice stay the same.</p><button class="secondary" :disabled="busy || paused" @click="confirmRender">Yes, regenerate</button><button class="secondary" @click="confirmRegenerate = false">Keep draft</button></div>
        <div v-if="pendingPublish && beat?.draft && showScript" class="beat-confirm"><p>Publish without the {{ continuityPending }} continuity updates?</p><button class="secondary" :disabled="busy || scriptDirty || rendering || paused" @click="publishAnyway">Publish anyway</button><button class="secondary" @click="pendingPublish = null">Go back</button></div>
        <div class="actions">
          <template v-if="idle"><button :class="buttonClass('open')" :disabled="busy || paused" data-testid="open-conversation" @click="openBeat('conversation')">Open conversation</button><button class="secondary" :disabled="busy || paused" data-testid="open-action" @click="openBeat('action')">Open action round</button></template>
          <template v-if="showPlan"><button :class="buttonClass('plan')" :disabled="busy || paused || !selected.length" data-testid="plan" @click="plan">{{ busy ? 'Working…' : 'Plan selected input' }}</button><small>{{ selected.length }} selected</small></template>
          <template v-if="showStakes && beat"><button v-if="quickLock" :disabled="busy || paused" data-testid="lock-and-draft" @click="lockAndDraft">Lock and draft</button><button :class="buttonClass('approve')" :disabled="busy || paused" data-testid="approve-stakes" @click="approveStakes">Approve stakes</button><button :class="buttonClass('lock')" :disabled="busy || paused || !beat.stakesApproved || contractsDirty" data-testid="lock" @click="lock">Lock input{{ contracts.some(item => item.ruling === 'check') ? ' & roll' : '' }}</button></template>
          <template v-if="showScript && beat"><button :class="beat.draft ? 'secondary' : buttonClass('render')" :disabled="busy || paused" data-testid="render" @click="render">{{ beat.draft ? 'Regenerate script' : 'Draft the scene' }}</button><button v-if="script.length" :class="buttonClass('save')" :disabled="busy || script.some(segment => !segment.text.trim())" @click="saveScript">Save script edits</button><button v-if="beat.draft" :class="recordingReady ? 'secondary' : buttonClass('publish')" :disabled="busy || scriptDirty || rendering || paused" data-testid="publish" @click="publish()">Publish text-only beat</button></template>
        </div>
      </div>
  </div>
</template>

<style scoped>
.beat-actions { position: sticky; bottom: 0; z-index: 10; display: grid; gap: .6rem; margin: 1.2rem -1.5rem -1.5rem; padding: .9rem 1.5rem; background: var(--panel); border-top: 1px solid var(--line); border-radius: 0 0 9px 9px; }
.beat-actions .actions { gap: .6rem; }
.beat-next { margin: 0; }
.beat-step-name { display: inline-block; margin-right: .4rem; padding: .1rem .55rem; border: 1px solid var(--gold); border-radius: 999px; color: var(--gold); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
.beat-reason { color: var(--muted); }
.beat-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; padding: .6rem .8rem; border: 1px solid var(--gold); border-radius: 6px; }
.beat-confirm p { flex: 1 1 18rem; margin: 0; }
.script-tools { margin-top: .8rem; }
.stage-length { margin: .2rem 0 .6rem; color: var(--muted); font-size: .8rem; }
.stage-length.over { color: var(--gold); }
</style>
