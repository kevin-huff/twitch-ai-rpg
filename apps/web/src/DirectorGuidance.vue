<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { EMPTY_GUIDANCE, canSpeakInScene } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: DirectorSnapshot }>();
const emit = defineEmits<{ command: [command: Command, done: (error?: string) => void] }>();

const helpPrefix = useId();
const noteHelpId = `${helpPrefix}-note-help`;
const castHelpId = (id: string) => `${helpPrefix}-cast-${id}`;
const guidance = computed(() => props.snapshot.guidance ?? EMPTY_GUIDANCE);
const npcs = computed(() => props.snapshot.npcDetails ?? []);
const locationId = computed(() => props.snapshot.session.scene.locationId);
const here = computed(() => npcs.value.filter(npc => canSpeakInScene(npc, locationId.value)));
const hereIds = computed(() => new Set(here.value.map(npc => npc.id)));
const away = computed(() => guidance.value.aiCastNpcIds
  .filter(id => !hereIds.value.has(id))
  .map(id => ({ id, name: npcs.value.find(npc => npc.id === id)?.displayName ?? 'Unknown character' })));
const tickedHere = computed(() => here.value.filter(npc => guidance.value.aiCastNpcIds.includes(npc.id)));
const castLine = computed(() => tickedHere.value.length
  ? 'The AI can give lines to the ticked characters who are here, plus anyone the players talk to.'
  : 'Nobody ticked: the AI gives lines to the characters the players talk to, or else to two characters, those in the room first.');

const pending = ref(false);
const error = ref('');
const noteStatus = ref('');
const noteText = ref(guidance.value.standingNote);
watch(() => guidance.value.standingNote, (next, previous) => { if (noteText.value === previous) noteText.value = next; });

function save(fields: { aiCastNpcIds: string[] } | { standingNote: string }, onSaved?: () => void, onFailed?: () => void) {
  if (pending.value) return;
  pending.value = true;
  error.value = '';
  emit('command', { type: 'set_guidance', commandId: crypto.randomUUID(), ...fields } as Command, message => {
    pending.value = false;
    if (message) { error.value = message; onFailed?.(); return; }
    onSaved?.();
  });
}
function toggle(id: string, box: HTMLInputElement) {
  const current = guidance.value.aiCastNpcIds;
  const ticked = box.checked;
  if (pending.value) { box.checked = current.includes(id); return; }
  save({ aiCastNpcIds: ticked ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id) }, undefined, () => { box.checked = guidance.value.aiCastNpcIds.includes(id); });
}
function saveNote() {
  const text = noteText.value.trim();
  noteStatus.value = '';
  save({ standingNote: text }, () => { noteStatus.value = text ? 'Standing note saved. The AI reads it on every plan and script until you clear it.' : 'Standing note cleared.'; });
}
function clearNote() {
  noteStatus.value = '';
  save({ standingNote: '' }, () => { noteText.value = ''; noteStatus.value = 'Standing note cleared.'; });
}
</script>

<template>
  <section class="director-guidance" data-testid="director-guidance" aria-label="Guidance for the AI">
    <fieldset class="guidance-cast">
      <legend>On stage for the AI</legend>
      <p v-if="!here.length && !away.length" class="muted" data-testid="ai-cast-empty">No non-player characters can speak in this scene.</p>
      <div v-for="npc in here" :key="npc.id"><label class="check"><input type="checkbox" :data-testid="`ai-cast-${npc.id}`" :aria-describedby="castHelpId(npc.id)" :checked="guidance.aiCastNpcIds.includes(npc.id)" :disabled="pending" @change="toggle(npc.id, $event.target as HTMLInputElement)" />{{ npc.displayName }}</label><p :id="castHelpId(npc.id)" class="field-help">When ticked, the AI can give this character lines in every beat until you untick them.</p></div>
      <div v-for="item in away" :key="item.id"><label class="check"><input type="checkbox" :data-testid="`ai-cast-away-${item.id}`" :aria-describedby="castHelpId(item.id)" checked :disabled="pending" @change="toggle(item.id, $event.target as HTMLInputElement)" />{{ item.name }} (not here)</label><p :id="castHelpId(item.id)" class="field-help">Still ticked, but this character cannot speak in this scene, so the AI leaves them out until they can. Untick to stop choosing them.</p></div>
      <p class="field-help" data-testid="ai-cast-help">{{ castLine }}</p>
    </fieldset>
    <div class="guidance-note">
      <label>Standing note<textarea v-model="noteText" data-testid="standing-note-text" maxlength="3000" rows="3" :aria-describedby="noteHelpId" /></label>
      <p :id="noteHelpId" class="field-help">Only you see this. It stays on for every beat until you clear it. Saving keeps the current plan, dice and script.</p>
      <div class="actions">
        <button type="button" class="secondary" data-testid="save-standing-note" :disabled="pending" @click="saveNote">Save standing note</button>
        <button type="button" class="secondary" data-testid="clear-standing-note" :disabled="pending" @click="clearNote">Clear standing note</button>
      </div>
      <p v-if="noteStatus" class="field-help" data-testid="standing-note-status" role="status">{{ noteStatus }}</p>
    </div>
    <p v-if="error" class="notice error" data-testid="guidance-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.director-guidance { display: grid; gap: 20px; margin: 20px 0; }
.guidance-cast { min-width: 0; margin: 0; padding: 0; border: 0; }
.guidance-cast legend { padding: 0; margin-bottom: 8px; }
.guidance-note { display: grid; gap: 8px; min-width: 0; }
.guidance-note textarea { width: 100%; box-sizing: border-box; }
.director-guidance .actions { flex-wrap: wrap; gap: 12px; }
.director-guidance p { margin: 0; }
</style>
