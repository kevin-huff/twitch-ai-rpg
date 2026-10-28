<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { AiSegment, PublicNpc } from '@rpg/contracts';
import FieldGenerator from './FieldGenerator.vue';

const props = defineProps<{ segments: AiSegment[]; npcs: PublicNpc[]; busy: boolean; contextKey: string; premise?: string; premiseLabel?: string }>();

const rowKeys = new WeakMap<AiSegment, number>();
let nextRowKey = 0;
function rowKey(segment: AiSegment): number {
  let key = rowKeys.get(segment);
  if (key === undefined) { key = ++nextRowKey; rowKeys.set(segment, key); }
  return key;
}
const openKeys = reactive(new Set<number>());
const presentNpcs = computed(() => props.npcs.filter(npc => npc.status === 'present'));

function speakerName(segment: AiSegment): string {
  if (segment.kind === 'narration') return 'Narrator';
  return props.npcs.find(npc => npc.id === segment.speakerNpcId)?.displayName ?? 'NPC';
}
function rowParts(segment: AiSegment): { speaker: string; words: string } {
  return { speaker: `${speakerName(segment)}:`, words: segment.text.trim() ? segment.text : '(empty line)' };
}
function open(segment: AiSegment) { openKeys.add(rowKey(segment)); }
function push(segment: AiSegment) {
  props.segments.push(segment);
  // Read the stored (reactive) item so the row key matches what the template renders.
  openKeys.add(rowKey(props.segments[props.segments.length - 1]!));
}
function addNarration() {
  push({ kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], text: '', delivery: 'neutral' });
}
function onAdd(event: Event) {
  const select = event.target as HTMLSelectElement;
  const value = select.value;
  select.value = '';
  if (value === 'narration') addNarration();
  else if (value) push({ kind: 'npc_dialogue', speakerNpcId: value, recipientCharacterIds: [], text: '', delivery: 'neutral' });
}
function remove(index: number) {
  const removed = props.segments[index];
  props.segments.splice(index, 1);
  if (removed) openKeys.delete(rowKey(removed));
}
defineExpose({ addNarration });
</script>

<template>
  <div class="script-editor">
    <div v-for="(segment, index) in segments" :key="rowKey(segment)" class="segment">
      <button type="button" class="script-line" :data-testid="`script-line-${index}`" @click="open(segment)"><strong class="script-speaker">{{ rowParts(segment).speaker }}</strong> {{ rowParts(segment).words }}</button>
      <div v-if="openKeys.has(rowKey(segment))" class="segment-editor">
        <label v-if="segment.kind === 'npc_dialogue'">Speaker
          <select v-model="segment.speakerNpcId" :data-testid="`script-speaker-${index}`">
            <option v-for="npc in presentNpcs" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option>
          </select>
        </label>
        <label>{{ segment.kind === 'narration' ? 'Narrator' : 'NPC dialogue' }}
          <textarea v-model="segment.text" :data-testid="`script-segment-${index}`" />
        </label>
        <FieldGenerator v-model="segment.text" :field="segment.kind === 'narration' ? 'script.narration' : 'script.npcDialogue'" :context-key="`${contextKey}:${rowKey(segment)}:${segment.speakerNpcId}`" :premise="premise" :premise-label="premiseLabel" :disabled="busy" />
        <button type="button" class="quiet" :disabled="busy" :data-testid="`script-remove-${index}`" @click="remove(index)">Remove</button>
      </div>
    </div>
    <select aria-label="Add a line" data-testid="script-add-line" :disabled="busy" @change="onAdd">
      <option value="">Add a line…</option>
      <option value="narration">Narrator</option>
      <option v-for="npc in presentNpcs" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option>
    </select>
    <p class="field-help">Only saved edits are published.</p>
  </div>
</template>

<style scoped>
.script-line {
  display: block;
  width: 100%;
  text-align: left;
  font-weight: 400;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 8px 12px;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 28px;
  cursor: pointer;
}
.script-line::before { content: none; }
.script-line:hover { background: var(--night-raised); }
.script-speaker { font-weight: 400; color: var(--candle); }
</style>
