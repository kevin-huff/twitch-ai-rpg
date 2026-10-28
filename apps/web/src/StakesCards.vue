<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ActionContract, Beat } from '@rpg/contracts';
import { ActionContractSchema } from '@rpg/contracts';
import { useTable } from './table';

const STAGE_GOAL_CHARS = 90;
const STAGE_OUTCOME_CHARS = 110;
const BANDS = ['clean', 'costly', 'setback'] as const;
const BAND_LABELS = { clean: '10 or more: Clean success', costly: '7 to 9: Success with a cost', setback: '6 or less: Setback' } as const;
const CRITICAL_LABEL = 'Double 1s: Critical failure';
const TRAITS = ['force', 'finesse', 'wits', 'presence'] as const;

const props = defineProps<{ beat: Beat; contracts: ActionContract[]; classification: 'ordinary' | 'action'; busy: boolean }>();
const emit = defineEmits<{ 'update:classification': [value: 'ordinary' | 'action'] }>();

const { director, nameOf, effectLabel } = useTable();

const ordinaryEditing = ref(false);
const editing = ref<string[]>([]);
const contractJson = ref('');
const jsonError = ref('');
const jsonLoaded = ref('');
watch(() => props.contracts, value => { contractJson.value = JSON.stringify(value, null, 2); }, { deep: true, immediate: true });

const showSelect = computed(() => ordinaryEditing.value || editing.value.length > 0);
const isEditing = (id: string) => editing.value.includes(id);
function toggleEdit(id: string) {
  editing.value = isEditing(id) ? editing.value.filter(item => item !== id) : [...editing.value, id];
}
function overLimit(text: string, limit: number) {
  return text.length > limit ? `Too long for the stage: it fits about ${limit} characters and this has ${text.length}. Shorten it so viewers can read all of it.` : '';
}
function traitValue(contract: ActionContract) {
  const traits = director.value?.characterDetails.find(item => item.id === contract.actorCharacterId)?.traits;
  const value = traits?.[contract.trait];
  return value === undefined ? '' : ` (+${value})`;
}
function rollWords(contract: ActionContract) {
  if (contract.ruling === 'no_check') return 'No roll: it simply works.';
  if (contract.ruling === 'blocked') return 'Blocked: it can\'t happen yet.';
  const trait = contract.trait.charAt(0).toUpperCase() + contract.trait.slice(1);
  return `Roll: two dice + ${trait}${traitValue(contract)}${contract.edge === 1 ? ' + 1 edge' : ''}`;
}
function setCritical(contract: ActionContract, text: string) {
  if (contract.outcomes.critical) contract.outcomes.critical.publicText = text;
  else contract.outcomes.critical = { publicText: text, effects: [] };
}
function onCriticalInput(contract: ActionContract, event: Event) {
  setCritical(contract, (event.target as HTMLTextAreaElement).value);
}
function changeClassification(event: Event) {
  emit('update:classification', (event.target as HTMLSelectElement).value as 'ordinary' | 'action');
}
function loadJson() {
  try {
    const parsed = (JSON.parse(contractJson.value) as unknown[]).map(item => ActionContractSchema.parse(item));
    props.contracts.splice(0, props.contracts.length, ...parsed);
    jsonError.value = '';
    jsonLoaded.value = 'Contract edits loaded. Review and approve to save.';
  } catch {
    jsonLoaded.value = '';
    jsonError.value = 'The contract data is not valid. Keep all contract fields and supported typed effects.';
  }
}
</script>

<template>
  <section class="stakes-cards" data-testid="stakes-cards">
    <h3>What's at risk</h3>
    <p v-if="beat.phase === 'collecting'" class="notice">Planning failed. You can review manual stakes below, retry planning, or abandon this beat with a reason.</p>
    <p v-if="beat.classification === 'needs_action'" class="notice">This exchange has consequences. Review the action stakes before locking.</p>
    <div v-if="classification === 'ordinary'" class="stakes-ordinary">
      <p>Ordinary conversation: no dice, and nothing changes.</p>
      <button class="quiet" data-testid="stakes-ordinary-edit" :disabled="busy" @click="ordinaryEditing = !ordinaryEditing">Edit</button>
    </div>
    <label v-if="showSelect">How should this input resolve?
      <select :value="classification" data-testid="stakes-classification" @change="changeClassification">
        <option value="ordinary" :disabled="beat.classification === 'needs_action'">Ordinary conversation · no mechanical consequences</option>
        <option value="action">Action · review the agreed goal and consequences</option>
      </select>
    </label>
    <template v-if="classification === 'action'">
      <article v-for="contract in contracts" :key="contract.id" class="contract stakes-card" :data-testid="`stakes-card-${contract.id}`">
        <div class="stakes-card-head">
          <h4>{{ nameOf(contract.actorCharacterId) }}</h4>
          <button class="quiet" :data-testid="`stakes-edit-${contract.id}`" :disabled="busy" @click="toggleEdit(contract.id)">{{ isEditing(contract.id) ? 'Done' : 'Edit' }}</button>
        </div>
        <template v-if="!isEditing(contract.id)">
          <p><strong>Goal:</strong> {{ contract.intent }}</p>
          <p><strong>Approach:</strong> {{ contract.approach }}</p>
          <p v-if="contract.helperCharacterIds.length" class="muted"><small>Helpers: {{ contract.helperCharacterIds.map(nameOf).join(', ') }}</small></p>
          <p class="roll-words">{{ rollWords(contract) }}</p>
          <ul class="outcomes">
            <li v-for="band in BANDS" :key="band"><strong>{{ BAND_LABELS[band] }}</strong> {{ contract.outcomes[band].publicText }}<small v-for="(effect, index) in contract.outcomes[band].effects" :key="index" style="display: block">{{ effectLabel(effect) }}</small></li>
            <li v-if="contract.outcomes.critical" data-testid="outcome-critical-read"><strong>{{ CRITICAL_LABEL }}</strong> {{ contract.outcomes.critical.publicText }}<small v-for="(effect, index) in contract.outcomes.critical.effects" :key="index" style="display: block">{{ effectLabel(effect) }}</small></li>
          </ul>
        </template>
        <template v-else>
          <label>Ruling
            <select v-model="contract.ruling" data-testid="contract-ruling">
              <option value="check">Check · uncertain and consequential</option>
              <option value="no_check">No check · achievable without uncertainty</option>
              <option value="blocked">Blocked · explain the missing requirement</option>
            </select>
          </label>
          <label>Agreed goal<textarea v-model="contract.intent" rows="2" /></label>
          <p v-if="overLimit(contract.intent, STAGE_GOAL_CHARS)" class="stage-length over" data-testid="stage-length-goal">{{ overLimit(contract.intent, STAGE_GOAL_CHARS) }}</p>
          <label>Approach<textarea v-model="contract.approach" rows="2" /></label>
          <div class="contract-grid">
            <label>Trait<select v-model="contract.trait"><option v-for="trait in TRAITS" :key="trait">{{ trait }}</option></select></label>
            <label>Risk<select v-model="contract.risk"><option>low</option><option>normal</option><option>high</option></select></label>
          </div>
          <p v-if="contract.helperCharacterIds.length"><small>Helpers: {{ contract.helperCharacterIds.map(nameOf).join(', ') }} · Edge +{{ contract.edge }}</small></p>
          <div v-for="band in BANDS" :key="band" class="branch">
            <label>{{ BAND_LABELS[band] }}<textarea v-model="contract.outcomes[band].publicText" :data-testid="`outcome-${band}`" rows="2" placeholder="Write the agreed outcome and consequences" /></label>
            <p v-if="overLimit(contract.outcomes[band].publicText, STAGE_OUTCOME_CHARS)" class="stage-length over" :data-testid="`stage-length-${band}`">{{ overLimit(contract.outcomes[band].publicText, STAGE_OUTCOME_CHARS) }}</p>
            <small v-for="(effect, index) in contract.outcomes[band].effects" :key="index" style="display: block">{{ effectLabel(effect) }}</small>
          </div>
          <div class="branch">
            <label>{{ CRITICAL_LABEL }}<textarea :value="contract.outcomes.critical?.publicText ?? ''" data-testid="outcome-critical" rows="2" placeholder="Write what happens on double 1s" @input="onCriticalInput(contract, $event)" /></label>
            <p v-if="overLimit(contract.outcomes.critical?.publicText ?? '', STAGE_OUTCOME_CHARS)" class="stage-length over" data-testid="stage-length-critical">{{ overLimit(contract.outcomes.critical?.publicText ?? '', STAGE_OUTCOME_CHARS) }}</p>
            <small v-for="(effect, index) in contract.outcomes.critical?.effects ?? []" :key="index" style="display: block">{{ effectLabel(effect) }}</small>
          </div>
        </template>
      </article>
      <details v-if="editing.length && contracts.length" class="contract-json">
        <summary>Edit typed effects, helpers & dependencies</summary>
        <label>Contract data<textarea v-model="contractJson" rows="14" spellcheck="false" data-testid="contract-data" /></label>
        <button class="secondary" data-testid="load-contract-edits" @click="loadJson">Load contract edits</button>
        <p v-if="jsonError" class="notice error" role="alert" data-testid="contract-json-error">{{ jsonError }}</p>
        <p v-if="jsonLoaded" class="muted" data-testid="contract-json-loaded">{{ jsonLoaded }}</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.stakes-ordinary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.stakes-ordinary p { margin: 0; }
.stakes-card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.stakes-card-head h4 { margin: 0; }
.outcomes { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 8px; }
/* Jersey 20 has one weight, so a label stands apart from its text by colour instead of bold. */
p > strong, .outcomes strong { color: var(--candle); }
.roll-words { margin: 8px 0; font-weight: 400; }
.stage-length { margin: 4px 0 12px; color: var(--dust); font-size: 20px; line-height: 24px; }
.stage-length.over { color: var(--candle); }
</style>
