<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { CommandSchema } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();
const helpId = `${useId()}-beat-steering-help`;
const text = ref('');
const baseline = ref('');
const captured = ref<{ sessionId: string; beatId: string; revision: number } | null>(null);
const error = ref('');
const notice = ref('');
let epoch = 0;
let retry: { key: string; commandId: string } | undefined;
const dirty = computed(() => text.value !== baseline.value);
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the session before saving private direction.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Private direction is available while the session is live or paused.';
  if (!props.snapshot.activeBeat || ['published', 'aborted'].includes(props.snapshot.activeBeat.phase)) return 'Open an active beat to save private direction.';
  return '';
});
const locked = computed(() => props.busy || Boolean(gate.value));
const stale = computed(() => captured.value !== null && (captured.value.sessionId !== props.snapshot.session.id || captured.value.beatId !== props.snapshot.activeBeat?.id || captured.value.revision !== props.snapshot.activeBeat?.revision));
function capture() {
  const beat = props.snapshot.activeBeat;
  if (!beat) return;
  epoch++;
  captured.value = { sessionId: props.snapshot.session.id, beatId: beat.id, revision: beat.revision };
  text.value = beat.steering ?? ''; baseline.value = text.value; error.value = ''; notice.value = ''; retry = undefined;
}
function reload() {
  if (locked.value) return;
  capture(); notice.value = '';
}
watch([() => props.snapshot.session.id, () => props.snapshot.activeBeat?.id, () => props.snapshot.activeBeat?.revision], () => {
  if (!captured.value || !dirty.value) capture();
}, { immediate: true });
function save(clear = false) {
  if (locked.value || stale.value || !captured.value) return;
  error.value = ''; notice.value = '';
  if (clear) text.value = '';
  const candidate = { type: 'set_beat_steering', beatId: captured.value.beatId, expectedBeatRevision: captured.value.revision, text: text.value };
  const key = JSON.stringify(candidate);
  if (retry?.key !== key) retry = { key, commandId: crypto.randomUUID() };
  const parsed = CommandSchema.safeParse({ ...candidate, commandId: retry.commandId });
  if (!parsed.success) { error.value = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Private direction'}: ${issue.message}`).join('\n'); return; }
  const savedEpoch = epoch;
  const savedTarget = captured.value;
  const savedText = text.value.trim();
  const savedNotice = savedText ? 'Private direction saved for the next plan or render.' : 'Private direction cleared.';
  emit('command', parsed.data, () => {
    if (savedEpoch !== epoch) {
      if (captured.value?.sessionId === savedTarget.sessionId && captured.value?.beatId === savedTarget.beatId && !dirty.value && baseline.value === savedText) notice.value = savedNotice;
      return;
    }
    baseline.value = savedText; text.value = savedText; retry = undefined;
    const beat = props.snapshot.activeBeat;
    const current = captured.value;
    if (beat && current && beat.id === current.beatId && beat.revision !== current.revision) capture();
    notice.value = savedNotice;
  });
}
</script>

<template>
  <details class="panel beat-steering" data-testid="beat-steering">
    <summary>Private AI direction</summary>
    <p>Only the director sees this direction; the AI receives it with the next plan or render. Saving does not create canon, reveal secrets, or write player speech automatically.</p>
    <p class="field-help">Saving discards the current generated draft and unsaved script or stakes edits. Before locking, saving direction requires fresh stakes review. After locking, it requires a new script review; existing dice stay fixed.</p>
    <p v-if="gate" class="notice">{{ gate }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <template v-if="captured">
      <p v-if="stale" class="notice">The active beat changed while you were editing. Your unsaved words are preserved. Copy anything you want to keep before loading the saved direction.<button type="button" class="quiet" data-testid="reload-beat-steering" :disabled="locked" @click="reload">Reload saved direction</button></p>
      <label>Direction for this beat<textarea v-model="text" data-testid="beat-steering-text" :aria-describedby="helpId" :disabled="locked" maxlength="3000" rows="4" /></label>
      <p :id="helpId" class="field-help">Give private guidance for this active beat. Save explicitly to use it on the next generation; clearing saves an empty direction. This does not apply to future beats.</p>
      <p v-if="dirty" class="muted">Unsaved private direction</p>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <div class="actions"><button type="button" data-testid="save-beat-steering" :disabled="locked || stale" @click="save()">{{ busy ? 'Saving…' : 'Save private direction' }}</button><button type="button" class="secondary" data-testid="clear-beat-steering" :disabled="locked || stale" @click="save(true)">Clear saved direction</button></div>
    </template>
  </details>
</template>

<style scoped>
.beat-steering { margin-block: 1rem; }
summary { font-weight: 600; }
label { margin-top: 1rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
.error { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
