<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CommandSchema, STRAIN_MAX } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();

const confirming = ref(false);
const revision = ref(props.snapshot.session.stateRevision);
const savedNotice = ref('');
const staleNotice = ref(false);
const saving = ref(false);
const error = ref('');

const strained = computed(() => props.snapshot.characters.filter(character => character.strain > 0));
const roundOpen = computed(() => ['collecting', 'stakes_review'].includes(props.snapshot.activeBeat?.phase ?? ''));
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the show from Cast & lobby first.';
  if (props.snapshot.session.status === 'ended') return 'The show has ended.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Open a conversation or an action round first.';
  if (props.snapshot.activeBeat && ['locked', 'draft_review'].includes(props.snapshot.activeBeat.phase)) return 'Publish or abandon this round first.';
  return '';
});
const locked = computed(() => props.busy || Boolean(gate.value));
const canAsk = computed(() => !locked.value && strained.value.length > 0);
const restLabel = computed(() => (saving.value ? 'Saving…' : 'Rest everyone'));
const confirmLabel = computed(() => (saving.value ? 'Saving…' : 'Yes, rest everyone'));

watch(() => props.snapshot.session.stateRevision, current => {
  if (confirming.value && !saving.value && current !== revision.value) { confirming.value = false; staleNotice.value = true; }
});
watch(() => props.busy, busy => { if (!busy) saving.value = false; });

function ask() {
  if (!canAsk.value) return;
  savedNotice.value = '';
  staleNotice.value = false;
  error.value = '';
  revision.value = props.snapshot.session.stateRevision;
  confirming.value = true;
}
function keep() { confirming.value = false; }
function confirm() {
  if (!confirming.value || locked.value) return;
  const parsed = CommandSchema.safeParse({ type: 'rest', commandId: crypto.randomUUID(), expectedStateRevision: revision.value });
  if (!parsed.success) { error.value = 'Check the strain and try again.'; return; }
  error.value = '';
  saving.value = true;
  const wasOpen = roundOpen.value;
  emit('command', parsed.data, () => { saving.value = false; confirming.value = false; staleNotice.value = false; savedNotice.value = wasOpen ? 'Rest saved. Strain went down. The round went back to taking lines. Press Plan to plan it again.' : 'Rest saved. Strain went down.'; });
}
</script>

<template>
  <details class="panel rest-controls" data-testid="rest-controls">
    <summary>Rest</summary>
    <p class="muted">Let every character catch their breath. Rest sets everyone's strain back to 0. Lines players sent stay where they are.</p>
    <p v-if="savedNotice" class="notice" role="status" data-testid="rest-saved">{{ savedNotice }}</p>
    <p v-if="roundOpen" class="notice" data-testid="rest-round-open">A round is open. Saving this sends it back to taking lines and throws away its plan, even one the AI is still making. Press Plan to plan it again. That is another AI call.</p>
    <p v-if="gate" class="notice" data-testid="rest-gate">{{ gate }}</p>
    <p v-if="staleNotice" class="notice" data-testid="rest-stale">The show changed while you were choosing. Check the strain, then press Rest everyone again.</p>
    <div v-for="character in snapshot.characters" :key="character.id" class="rest-row" :data-testid="`rest-row-${character.id}`">
      <p v-if="character.strain > 0" class="rest-strain">{{ character.displayName }}: {{ character.strain }} of {{ STRAIN_MAX }}</p>
      <p v-else class="muted" :data-testid="`rest-none-${character.id}`">{{ character.displayName }} has no strain.</p>
    </div>
    <p v-if="!gate && !strained.length" class="muted" data-testid="rest-nobody">Nobody has strain to rest.</p>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <div v-if="confirming" class="notice" data-testid="rest-confirmation">
      <p>Rest everyone? Every character's strain goes back to 0.</p>
      <div class="actions">
        <button type="button" data-testid="rest-confirm" :disabled="locked" @click="confirm">{{ confirmLabel }}</button>
        <button type="button" class="secondary" data-testid="rest-keep" @click="keep">Keep strain</button>
      </div>
    </div>
    <div v-else class="actions"><button type="button" data-testid="save-rest" :disabled="!canAsk" @click="ask">{{ restLabel }}</button></div>
  </details>
</template>

<style scoped>
.rest-controls > p { margin-top: 20px; }
.rest-row { min-width: 0; margin-block: 12px; }
.rest-row p { margin: 0; overflow-wrap: anywhere; }
</style>
