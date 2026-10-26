<script setup lang="ts">
import { computed, useId } from 'vue';
import type { DirectorSnapshot, Submission } from '@rpg/contracts';

const props = defineProps<{ snapshot: DirectorSnapshot; modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const helpPrefix = useId();
const helpId = (id: string) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(['queue', id]))}`;

const pending = computed(() => props.snapshot.submissions.filter(item => ['queued', 'selected'].includes(item.status)));
const inCharacter = computed(() => pending.value.filter(item => item.kind !== 'ooc'));
const questions = computed(() => pending.value.filter(item => item.kind === 'ooc'));
const activeBeatId = computed(() => props.snapshot.activeBeat?.id ?? null);
const phaseAllows = computed(() => ['collecting', 'stakes_review'].includes(props.snapshot.activeBeat?.phase ?? 'collecting'));
const canSelect = (item: Submission) => item.kind !== 'ooc' && phaseAllows.value;
const selectable = computed(() => pending.value.filter(canSelect));

const nameOf = (id: string) => props.snapshot.characters.find(character => character.id === id)?.displayName ?? 'Player';
const recipient = (item: Submission) => {
  const names = (item.recipientNpcIds ?? []).map(id => (props.snapshot.npcs ?? []).find(npc => npc.id === id)?.displayName).filter((name): name is string => Boolean(name));
  return names.length ? names.join(' and ') : 'the party';
};
const helpText = (item: Submission) => {
  if (item.kind === 'ooc') return 'Question for the director · cannot be planned';
  if (item.kind === 'act') return `Action from ${nameOf(item.characterId)} · ${item.status}`;
  return `Exact dialogue to ${recipient(item)} · ${item.status}`;
};
const leftover = (item: Submission) => Boolean(item.contextBeatId && item.contextBeatId !== activeBeatId.value);

const selectAll = () => emit('update:modelValue', selectable.value.map(item => item.id));
const clear = () => emit('update:modelValue', []);
const toggle = (id: string, checked: boolean) => {
  const rest = props.modelValue.filter(value => value !== id);
  emit('update:modelValue', checked ? [...rest, id] : rest);
};
</script>

<template>
  <section class="panel">
    <div class="panel-heading"><h2>At the table</h2><span class="status">{{ pending.length }} queued</span></div>
    <div v-if="!pending.length" class="empty">No pending submissions. Invite your cast to speak or act.</div>
    <template v-else>
      <p class="muted queue-hint"><small>Tick the lines to plan. Questions and pause requests cannot become dialogue.</small></p>
      <div class="queue-tools">
        <button type="button" class="quiet" :disabled="!selectable.length" @click="selectAll">Select all lines</button>
        <button type="button" class="quiet" :disabled="!modelValue.length" @click="clear">Clear</button>
      </div>
    </template>
    <div v-for="item in inCharacter" :key="item.id" class="queue-item">
      <label class="check"><input type="checkbox" :aria-describedby="helpId(item.id)" :checked="modelValue.includes(item.id)" :disabled="!canSelect(item)" @change="toggle(item.id, ($event.target as HTMLInputElement).checked)"><strong>{{ nameOf(item.characterId) }}</strong></label>
      <p :id="helpId(item.id)" class="field-help">{{ helpText(item) }}</p>
      <span v-if="leftover(item)" class="queue-tag">From an earlier exchange</span>
      <p>{{ item.kind === 'act' ? item.intent : item.text }}</p>
      <small v-if="item.kind === 'act' && item.approach?.trim() && item.approach.trim() !== item.intent?.trim()">{{ item.approach }}</small>
      <p v-if="item.stageDirection" class="stage-direction">{{ item.stageDirection }}</p>
    </div>
    <template v-if="questions.length">
      <h3 class="queue-group">Questions and pause requests</h3>
      <div v-for="item in questions" :key="item.id" class="queue-item">
        <label class="check"><input type="checkbox" :aria-describedby="helpId(item.id)" :checked="modelValue.includes(item.id)" :disabled="!canSelect(item)" @change="toggle(item.id, ($event.target as HTMLInputElement).checked)"><strong>{{ nameOf(item.characterId) }}</strong></label>
        <p :id="helpId(item.id)" class="field-help">{{ helpText(item) }}</p>
        <span v-if="leftover(item)" class="queue-tag">From an earlier exchange</span>
        <p>{{ item.text }}</p>
        <p v-if="item.stageDirection" class="stage-direction">{{ item.stageDirection }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.queue-hint { margin: 0 0 .4rem; }
.queue-tools { display: flex; gap: .4rem; margin-bottom: .5rem; }
.queue-group { margin: .9rem 0 .4rem; font-size: .95rem; color: var(--muted); }
.queue-tag { display: inline-block; font-size: .75rem; color: var(--teal); border: 1px solid var(--line); border-radius: 999px; padding: .05rem .5rem; }
.stage-direction { color: var(--muted); font-style: italic; margin: .2rem 0 0; }
</style>
