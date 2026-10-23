<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { CommandSchema } from '@rpg/contracts';
import type { Command, CorrectionChange, DirectorSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();
type Kind = CorrectionChange['kind'];
type KnowledgeUpdate = Extract<CorrectionChange, { kind: 'fact_replace' }>['knowledgeUpdates'][number];
type DraftChange = { key: number; kind: Kind; targetId: string; text: string; value: number | string; knowledgeUpdates: KnowledgeUpdate[] };
const prefix = useId();
const helpId = (...parts: (string | number)[]) => `${prefix}-correction-${encodeURIComponent(JSON.stringify(parts))}`;
const baseline = ref<DirectorSnapshot | null>(null);
const beatId = ref('');
const publicText = ref('');
const reason = ref('');
const acknowledged = ref(false);
const changes = ref<DraftChange[]>([]);
const error = ref('');
const savedNotice = ref('');
let epoch = 0;
let nextKey = 0;
let retry: { key: string; commandId: string } | undefined;
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the session before recording corrections.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Corrections are available while the session is live or paused.';
  if (props.snapshot.activeBeat) return 'Finish or abandon the current beat before recording a correction.';
  if (!props.snapshot.history.length) return 'Publish a beat before recording a correction.';
  return '';
});
const locked = computed(() => props.busy || Boolean(gate.value));
const stale = computed(() => baseline.value !== null && (baseline.value.session.id !== props.snapshot.session.id || baseline.value.session.stateRevision !== props.snapshot.session.stateRevision));
function begin() {
  if (locked.value) return;
  epoch++; baseline.value = JSON.parse(JSON.stringify(props.snapshot));
  beatId.value = props.snapshot.history.at(-1)?.id ?? '';
  publicText.value = ''; reason.value = ''; acknowledged.value = false; changes.value = []; error.value = ''; savedNotice.value = ''; retry = undefined;
}
function options(kind: Kind) {
  if (kind === 'fact_replace') return baseline.value?.facts.map(fact => ({ id: fact.id, label: fact.text, value: 0, max: 0 })) ?? [];
  if (kind === 'strain_set') return baseline.value?.characters.map(character => ({ id: character.id, label: character.displayName, value: character.strain, max: 4 })) ?? [];
  return baseline.value?.tracks.map(track => ({ id: track.id, label: track.label, value: track.current, max: track.max })) ?? [];
}
function used(kind: Kind, targetId: string, except?: DraftChange) { return changes.value.some(change => change !== except && change.kind === kind && change.targetId === targetId); }
function available(kind: Kind) { return options(kind).find(option => !used(kind, option.id)); }
function original(change: DraftChange) { return options(change.kind).find(option => option.id === change.targetId); }
function before(change: DraftChange) { return change.kind === 'fact_replace' ? original(change)?.label ?? '' : original(change)?.value ?? ''; }
function loadTarget(change: DraftChange) {
  const target = original(change);
  change.text = change.kind === 'fact_replace' ? target?.label ?? '' : '';
  change.value = target?.value ?? 0;
  change.knowledgeUpdates = change.kind === 'fact_replace' && target ? (baseline.value?.npcDetails ?? []).flatMap(npc => npc.knowledge.filter(memory => memory.category === 'fact' && memory.statement === target.label).map(memory => ({ npcId: npc.id, knowledgeId: memory.id, mode: 'correct' as const }))) : [];
}
function add(kind: Kind) {
  const target = available(kind);
  if (locked.value || !baseline.value || !target || changes.value.length >= 10) return;
  const change: DraftChange = { key: nextKey++, kind, targetId: target.id, text: '', value: 0, knowledgeUpdates: [] };
  loadTarget(change); changes.value.push(change);
}
function remove(index: number) { if (!locked.value) changes.value.splice(index, 1); }
function npcName(id: string) { return baseline.value?.npcDetails.find(npc => npc.id === id)?.displayName ?? 'Character'; }
function cancel() { if (!props.busy) { epoch++; baseline.value = null; error.value = ''; } }
function save() {
  if (locked.value || stale.value || !baseline.value) return;
  error.value = '';
  if (!acknowledged.value) { error.value = 'Acknowledge that queued in-character dialogue and actions will be cancelled before saving.'; return; }
  if (!baseline.value.history.some(beat => beat.id === beatId.value)) { error.value = 'Choose a published beat for this correction.'; return; }
  for (const change of changes.value) {
    const target = original(change);
    if (!target) { error.value = 'Choose an existing public fact, character, or track for each change.'; return; }
    if (used(change.kind, change.targetId, change)) { error.value = 'Choose each correction target only once.'; return; }
    if (change.kind === 'fact_replace') {
      if (change.text.trim() === target.label) { error.value = 'This fact is unchanged. Edit it or remove this change to publish only a clarification.'; return; }
    } else {
      if (typeof change.value !== 'number' || !Number.isInteger(change.value) || change.value < 0 || change.value > target.max) { error.value = `${target.label} needs a whole number from 0 to ${target.max}.`; return; }
      if (change.value === target.value) { error.value = `${target.label} is unchanged. Edit it or remove this change.`; return; }
    }
  }
  const candidate = {
    type: 'record_correction', expectedStateRevision: baseline.value.session.stateRevision,
    publishedBeatId: beatId.value, publicText: publicText.value, reason: reason.value, discardQueuedInput: true,
    changes: changes.value.map(change => change.kind === 'fact_replace'
      ? { kind: change.kind, factId: change.targetId, text: change.text, knowledgeUpdates: change.knowledgeUpdates }
      : change.kind === 'strain_set' ? { kind: change.kind, characterId: change.targetId, value: change.value }
      : { kind: change.kind, trackId: change.targetId, value: change.value }),
  };
  const key = JSON.stringify(candidate);
  if (retry?.key !== key) retry = { key, commandId: crypto.randomUUID() };
  const parsed = CommandSchema.safeParse({ ...candidate, commandId: retry.commandId });
  if (!parsed.success) { error.value = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Correction'}: ${issue.message}`).join('\n'); return; }
  const savedEpoch = epoch;
  emit('command', parsed.data, () => {
    if (savedEpoch !== epoch) return;
    baseline.value = null; acknowledged.value = false; retry = undefined;
    savedNotice.value = 'Correction published. Earlier narration and dice remain unchanged.';
  });
}
</script>

<template>
  <details class="panel correction-controls" data-testid="correction-controls">
    <summary>Corrections</summary>
    <p>Append a public clarification to a published beat, with optional corrections to current facts, strain, or tracks. Earlier narration, dice, and recordings remain unchanged.</p>
    <p v-if="gate" class="notice">{{ gate }}</p>
    <p v-if="savedNotice" class="notice" role="status">{{ savedNotice }}</p>
    <button v-if="!baseline" type="button" class="secondary" data-testid="begin-correction" :disabled="locked" @click="begin">Record a correction</button>
    <form v-else novalidate @submit.prevent="save">
      <p v-if="stale" class="notice">The table changed while you were editing. Your unsaved words are preserved. Copy anything you want to keep before reloading.<button type="button" class="quiet" data-testid="reload-correction" :disabled="locked" @click="begin">Discard changes and reload</button></p>
      <fieldset :disabled="locked">
        <label>Published beat<select v-model="beatId" data-testid="correction-beat" :aria-describedby="helpId('beat')"><option v-for="beat in baseline.history" :key="beat.id" :value="beat.id">Beat {{ beat.beatNumber }} · {{ beat.kind }}</option></select></label>
        <p :id="helpId('beat')" class="field-help">Choose any published beat, including an older one. The correction applies to the current saved state.</p>
        <label>Public correction<textarea v-model="publicText" data-testid="correction-public-text" maxlength="3000" rows="4" :aria-describedby="helpId('public')" /></label>
        <p :id="helpId('public')" class="field-help">This note appears to players and the stage. Include only what they should know.</p>
        <section class="public-preview" aria-label="Public correction preview"><h3>Public preview</h3><p data-testid="correction-public-preview">{{ publicText.trim() || 'Your public correction will appear here.' }}</p></section>
        <h3>Current state changes · optional</h3>
        <p class="field-help">A clarification can have no state changes. Setting a track does not fire completion effects or reroll dice. Private reasons and character-memory decisions are not published in the correction note.</p>
        <section v-for="(change, index) in changes" :key="change.key" class="correction-change">
          <h4>{{ change.kind === 'fact_replace' ? 'Replace public fact' : change.kind === 'strain_set' ? 'Set character strain' : 'Set track value' }}</h4>
          <label>{{ change.kind === 'fact_replace' ? 'Public fact' : change.kind === 'strain_set' ? 'Character' : 'Public track' }}<select v-model="change.targetId" :data-testid="`correction-target-${index}`" :aria-describedby="helpId('target', change.key)" @change="loadTarget(change)"><option v-for="option in options(change.kind)" :key="option.id" :value="option.id" :disabled="used(change.kind, option.id, change)">{{ option.label }}</option></select></label>
          <p :id="helpId('target', change.key)" class="field-help">Choose an existing target. Each target can be corrected only once in this correction.</p>
          <template v-if="change.kind === 'fact_replace'">
            <label>Corrected fact<textarea v-model="change.text" :data-testid="`correction-fact-text-${index}`" :aria-describedby="helpId('text', change.key)" maxlength="6000" rows="3" /></label>
            <p :id="helpId('text', change.key)" class="field-help">Replaces this public fact. Review what each character already knows below.</p>
            <div v-for="(knowledge, memoryIndex) in change.knowledgeUpdates" :key="`${knowledge.npcId}:${knowledge.knowledgeId}`">
              <label>{{ npcName(knowledge.npcId) }} · existing fact memory<select v-model="knowledge.mode" :data-testid="`correction-knowledge-${index}-${memoryIndex}`" :aria-describedby="helpId('knowledge', change.key, memoryIndex)"><option value="correct">Update known fact</option><option value="retain_belief">Keep old as belief</option></select></label>
              <p :id="helpId('knowledge', change.key, memoryIndex)" class="field-help">This existing factual memory exactly matches the old fact. Update it or preserve the old words as a belief; no new knowledge is added.</p>
            </div>
            <div :data-testid="`correction-memory-preview-${index}`" class="private-preview"><strong>Private memory review</strong><p v-for="knowledge in change.knowledgeUpdates" :key="`${knowledge.npcId}:${knowledge.knowledgeId}`">{{ npcName(knowledge.npcId) }}: {{ before(change) }} (fact) → {{ knowledge.mode === 'correct' ? `${change.text.trim()} (fact)` : `${before(change)} (belief)` }}</p><p v-if="!change.knowledgeUpdates.length">No existing factual memories exactly match this fact. No character knowledge will be added.</p></div>
          </template>
          <template v-else>
            <label>Corrected value<input v-model.number="change.value" type="number" min="0" :max="original(change)?.max" step="1" :data-testid="`correction-value-${index}`" :aria-describedby="helpId('value', change.key)"></label>
            <p :id="helpId('value', change.key)" class="field-help">Set the current value from 0 to {{ original(change)?.max }}. This does not change any earlier roll or outcome.</p>
          </template>
          <p :data-testid="`correction-change-preview-${index}`" class="change-preview">{{ before(change) }} → {{ change.kind === 'fact_replace' ? change.text.trim() : change.value }}</p>
          <button type="button" class="quiet" :data-testid="`remove-correction-${index}`" @click="remove(index)">Remove change {{ index + 1 }}</button>
        </section>
        <div class="actions"><button type="button" class="secondary" data-testid="add-correction-fact" :disabled="changes.length >= 10 || !available('fact_replace')" @click="add('fact_replace')">Correct a fact</button><button type="button" class="secondary" data-testid="add-correction-strain" :disabled="changes.length >= 10 || !available('strain_set')" @click="add('strain_set')">Correct strain</button><button type="button" class="secondary" data-testid="add-correction-track" :disabled="changes.length >= 10 || !available('track_set')" @click="add('track_set')">Correct a track</button></div>
        <label>Private reason<textarea v-model="reason" data-testid="correction-reason" maxlength="1000" rows="2" :aria-describedby="helpId('reason')" /></label>
        <p :id="helpId('reason')" class="field-help">A required private audit note explaining why you made this correction. It is not shown to players or the stage.</p>
        <label class="check"><input v-model="acknowledged" data-testid="correction-discard-input" type="checkbox" :aria-describedby="helpId('discard')">Cancel queued or selected in-character dialogue and actions for this correction.</label>
        <p :id="helpId('discard')" class="field-help">Players must submit in-character input again for the corrected situation. Out-of-character questions stay.</p>
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <div class="actions"><button type="button" data-testid="save-correction" :disabled="locked || stale" @click="save">{{ busy ? 'Saving…' : 'Publish correction' }}</button><button type="button" class="quiet" @click="cancel">Cancel correction</button></div>
      </fieldset>
    </form>
  </details>
</template>

<style scoped>
.correction-controls { margin-block: 1rem; }
summary { font-weight: 600; }
fieldset { min-width: 0; border: 0; margin: 0; padding: 0; }
fieldset > label, .correction-change > label { margin-top: 1rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-block: 1rem; }
.public-preview, .private-preview, .correction-change { border: 1px solid var(--line); padding: 1rem; margin-block: 1rem; border-radius: 8px; }
.public-preview p, .private-preview p, .change-preview, .error { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
