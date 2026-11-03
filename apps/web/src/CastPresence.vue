<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { CommandSchema } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';

const helpPrefix = useId();
const helpId = (npcId: string) => `${helpPrefix}-help-${encodeURIComponent(npcId)}`;

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();

const open = ref(false);
const revision = ref(0);
const baseline = ref<string[]>([]);
const ticked = ref<string[]>([]);
const error = ref('');
const savedNotice = ref('');
const saving = ref(false);

const hereIds = computed(() => props.snapshot.npcDetails
  .filter(npc => npc.status === 'present' && npc.locationId === props.snapshot.session.scene.locationId)
  .map(npc => npc.id));
const hereNames = computed(() => props.snapshot.npcDetails.filter(npc => hereIds.value.includes(npc.id)).map(npc => npc.displayName));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the show from Cast & lobby first.';
  if (props.snapshot.session.status === 'ended') return 'The show has ended.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Open a conversation or an action round first.';
  if (props.snapshot.activeBeat && ['locked', 'draft_review'].includes(props.snapshot.activeBeat.phase)) return 'Publish or abandon this round first.';
  return '';
});
const roundOpen = computed(() => ['collecting', 'stakes_review'].includes(props.snapshot.activeBeat?.phase ?? ''));
const locked = computed(() => props.busy || Boolean(gate.value));
const unchanged = computed(() => sameSet(ticked.value, hereIds.value));
const edited = computed(() => !sameSet(ticked.value, baseline.value));
const stale = computed(() => open.value && revision.value !== props.snapshot.session.stateRevision);
const saveLabel = computed(() => (saving.value ? 'Saving…' : 'Save who is here'));
const canSave = computed(() => !locked.value && !stale.value && !unchanged.value);

function load() {
  revision.value = props.snapshot.session.stateRevision;
  baseline.value = [...hereIds.value];
  ticked.value = [...hereIds.value];
  error.value = '';
}
function begin() {
  if (locked.value) return;
  saving.value = false;
  savedNotice.value = '';
  load();
  open.value = true;
}
function cancel() { open.value = false; error.value = ''; }
watch(() => props.snapshot.session.stateRevision, () => { if (open.value && !edited.value) load(); });
watch(() => props.busy, busy => { if (!busy) saving.value = false; });
function save() {
  if (!canSave.value) return;
  const parsed = CommandSchema.safeParse({ type: 'set_cast', commandId: crypto.randomUUID(), expectedStateRevision: revision.value, presentNpcIds: [...ticked.value] });
  if (!parsed.success) { error.value = parsed.error.issues[0]?.message ?? 'Check who is here and try again.'; return; }
  error.value = '';
  saving.value = true;
  const wasOpen = roundOpen.value;
  emit('command', parsed.data, () => {
    saving.value = false;
    open.value = false;
    savedNotice.value = wasOpen ? 'Saved who is here. The round went back to taking lines. Press Plan to plan it again.' : 'Saved who is here.';
  });
}
</script>

<template>
  <details class="panel cast-presence" data-testid="cast-presence">
    <summary>Who is here</summary>
    <p class="muted">Move characters on or off stage without changing the scene. Lines players sent stay where they are.</p>
    <p v-if="savedNotice" class="notice" role="status">{{ savedNotice }}</p>
    <p v-if="gate" class="notice">{{ gate }}</p>
    <p v-if="roundOpen" class="notice" data-testid="cast-round-open">A round is open. Saving this sends it back to taking lines and throws away its plan, even one the AI is still making. Press Plan to plan it again. That is another AI call.</p>
    <p class="muted" data-testid="cast-here-now">{{ hereNames.length ? `Here now: ${hereNames.join(', ')}` : 'Nobody else is here.' }}</p>
    <div class="actions"><button type="button" class="secondary" data-testid="begin-cast" :disabled="locked" :aria-pressed="open" @click="begin">Change who is here</button></div>
    <form v-if="open" @submit.prevent="save">
      <p v-if="stale" class="notice">The show changed while you were choosing. Press Start over to see who is here now.<button type="button" class="quiet" data-testid="cast-reset" @click="load">Start over</button></p>
      <fieldset :disabled="locked">
        <div v-for="npc in snapshot.npcDetails" :key="npc.id">
          <label class="check"><input v-model="ticked" type="checkbox" :value="npc.id" :data-testid="`here-${npc.id}`" :aria-describedby="helpId(npc.id)">{{ npc.displayName }}</label>
          <p class="field-help" :id="helpId(npc.id)">Ticked means {{ npc.displayName }} is here and players can talk to them. Unticked sends {{ npc.displayName }} offstage.</p>
        </div>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <div class="actions">
          <button type="submit" data-testid="save-cast" :disabled="!canSave">{{ saveLabel }}</button>
          <button type="button" class="secondary" data-testid="cancel-cast" @click="cancel">Cancel</button>
        </div>
      </fieldset>
    </form>
  </details>
</template>

<style scoped>
.cast-presence > summary { font-weight: 400; }
.cast-presence > p, form { margin-top: 20px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
</style>
