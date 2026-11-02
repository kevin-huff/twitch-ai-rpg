<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { CommandSchema, STRAIN_MAX } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();

// Placeholder until Kevin decides the size of a rest: each character starts at 2, never above their strain.
const DEFAULT_REST = 2;
const revision = ref(props.snapshot.session.stateRevision);
const amounts = ref<Record<string, number | string>>({});
const edited = ref(false);
const savedNotice = ref('');
const error = ref('');

const strained = computed(() => props.snapshot.characters.filter(character => character.strain > 0));
const strainKey = computed(() => JSON.stringify(props.snapshot.characters.map(character => [character.id, character.strain])));
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the show from Cast & lobby first.';
  if (props.snapshot.session.status === 'ended') return 'The show has ended.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Open a conversation or an action round first.';
  if (props.snapshot.activeBeat && props.snapshot.activeBeat.phase !== 'collecting') return 'Publish or abandon this round first.';
  return '';
});
const locked = computed(() => props.busy || Boolean(gate.value));
const stale = computed(() => edited.value && revision.value !== props.snapshot.session.stateRevision);

function build() {
  revision.value = props.snapshot.session.stateRevision;
  amounts.value = Object.fromEntries(strained.value.map(character => [character.id, Math.min(DEFAULT_REST, character.strain)]));
  edited.value = false;
  error.value = '';
}
build();
watch([() => props.snapshot.session.stateRevision, strainKey], () => { if (!edited.value) build(); });

const valid = (id: string, strain: number) => {
  const value = amounts.value[id];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= strain;
};
const allValid = computed(() => strained.value.every(character => valid(character.id, character.strain)));
const total = computed(() => strained.value.reduce((sum, character) => sum + (valid(character.id, character.strain) ? Number(amounts.value[character.id]) : 0), 0));
const canSave = computed(() => !locked.value && !stale.value && allValid.value && total.value > 0);

function touch() { edited.value = true; savedNotice.value = ''; }
function save() {
  if (!canSave.value) return;
  const rests = strained.value.filter(character => Number(amounts.value[character.id]) >= 1).map(character => ({ characterId: character.id, amount: Number(amounts.value[character.id]) }));
  const parsed = CommandSchema.safeParse({ type: 'rest', commandId: crypto.randomUUID(), expectedStateRevision: revision.value, rests });
  if (!parsed.success) { error.value = 'Check each number before resting.'; return; }
  error.value = '';
  emit('command', parsed.data, () => { build(); savedNotice.value = 'Rest saved. Strain went down.'; });
}
</script>

<template>
  <details class="panel rest-controls" data-testid="rest-controls">
    <summary>Rest</summary>
    <p class="muted">Lower strain for characters who stop to catch their breath. Lines players sent stay where they are.</p>
    <p v-if="savedNotice" class="notice" role="status" data-testid="rest-saved">{{ savedNotice }}</p>
    <p v-if="gate" class="notice" data-testid="rest-gate">{{ gate }}</p>
    <p v-if="stale" class="notice" data-testid="rest-stale">Strain changed since you started. Press Start over to load the new numbers.<button type="button" class="quiet" data-testid="rest-reset" :disabled="locked" @click="build">Start over</button></p>
    <form @submit.prevent="save">
      <fieldset :disabled="locked">
        <div v-for="character in snapshot.characters" :key="character.id" class="rest-row" :data-testid="`rest-row-${character.id}`">
          <template v-if="character.strain > 0">
            <p class="rest-strain">{{ character.displayName }}: {{ character.strain }} of {{ STRAIN_MAX }}</p>
            <label>{{ character.displayName }}: strain to take off<input v-model.number="amounts[character.id]" type="number" inputmode="numeric" min="0" :max="character.strain" step="1" :data-testid="`rest-amount-${character.id}`" :aria-describedby="helpId('rest', character.id)" @input="touch"></label>
            <p class="field-help" :id="helpId('rest', character.id)">How much strain {{ character.displayName }} loses, from 0 to {{ character.strain }}. 0 means {{ character.displayName }} does not rest.</p>
          </template>
          <p v-else class="muted" :data-testid="`rest-none-${character.id}`">{{ character.displayName }} has no strain.</p>
        </div>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <button type="submit" data-testid="save-rest" :disabled="!canSave">{{ busy ? 'Saving…' : 'Rest' }}</button>
      </fieldset>
    </form>
  </details>
</template>

<style scoped>
.rest-controls > p, form { margin-top: 20px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.rest-row { min-width: 0; margin-block: 20px; }
.rest-strain { margin: 0 0 8px; overflow-wrap: anywhere; }
.rest-row input { max-width: 100%; }
</style>
