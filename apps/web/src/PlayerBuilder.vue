<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CharacterBuilderDraftSchema, CharacterCardDefinitionSchema } from '@rpg/contracts';
import type { CharacterBuilderDraft, CharacterBuilderSnapshot, FieldGenerationCharacterContext, FieldGenerationRequest, PortraitDetails } from '@rpg/contracts';
import { api } from './api';
import { selectIdentity } from './identity';
import { pictureUrl } from './pictures';
import CharacterForm from './CharacterForm.vue';
import { withDescription } from './card-description';
import ErrorNotice from './ErrorNotice.vue';

const snapshot = ref<CharacterBuilderSnapshot | null>(null);
const form = ref<CharacterBuilderDraft | null>(null);
const description = ref('');
const baseline = ref('');
const busy = ref(false);
const error = ref('');
const status = ref('');
const conflict = ref(false);
const cardNote = computed(() => snapshot.value?.instructions?.trim() ? "The director's instructions are sent too." : undefined);
const dirty = computed(() => form.value !== null && (JSON.stringify(form.value) !== baseline.value || description.value.trim() !== ''));
const submitted = computed(() => Boolean(snapshot.value?.submittedTemplate));
let retryCommand: { key: string; commandId: string } | undefined;

function accept(next: CharacterBuilderSnapshot) {
  snapshot.value = next;
  form.value = JSON.parse(JSON.stringify(next.draft));
  description.value = '';
  baseline.value = JSON.stringify(form.value);
  conflict.value = false;
  retryCommand = undefined;
}
function report(reason: unknown) {
  error.value = reason instanceof Error ? reason.message : 'The request failed. Your unfinished words are still here.';
  if (typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409) conflict.value = true;
}
onMounted(async () => {
  busy.value = true;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const hasToken = hash.has('token');
  const tokens = hash.getAll('token');
  if (window.location.hash) window.history.replaceState(window.history.state, '', hasToken ? '/build-character' : `${window.location.pathname}${window.location.search}`);
  try {
    if (hasToken) {
      if (tokens.length !== 1 || !tokens[0]) throw new Error('This character link is incomplete. Ask the director for your private link.');
      const result = await api.accessCharacterBuilder(tokens[0]);
      selectIdentity(result.identityId);
      accept(result.builder);
    } else accept(await api.characterBuilder());
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
});
async function reload() {
  if (busy.value) return;
  busy.value = true; error.value = ''; status.value = '';
  try { accept(await api.characterBuilder()); status.value = 'Saved draft loaded.'; }
  catch (reason) { report(reason); }
  finally { busy.value = false; }
}
async function generate(input: FieldGenerationRequest) {
  if (!snapshot.value || busy.value || submitted.value || conflict.value || input.characterContext?.kind !== 'character') throw new Error('This character draft is unavailable for generation.');
  const { id, revision } = snapshot.value;
  try {
    return await api.generateCharacterBuilderField({
      expectedRevision: revision, field: input.field, seed: input.seed, characterContext: input.characterContext,
    });
  } catch (reason) {
    if (snapshot.value?.id === id && snapshot.value.revision === revision && !submitted.value
      && typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409) report(reason);
    throw reason;
  }
}
async function generateCard(input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }) {
  if (!snapshot.value || busy.value || submitted.value || conflict.value || input.current.kind !== 'character') throw new Error('This character draft is unavailable for generation.');
  const { id, revision } = snapshot.value;
  try {
    return await api.generateBuilderCard({ expectedRevision: revision, prompt: input.prompt, keepFilled: input.keepFilled, current: input.current });
  } catch (reason) {
    if (snapshot.value?.id === id && snapshot.value.revision === revision && !submitted.value
      && typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409) report(reason);
    throw reason;
  }
}
async function generatePortrait(details: PortraitDetails) {
  if (!snapshot.value || busy.value || submitted.value || conflict.value) throw new Error('This character draft is unavailable for generation.');
  const { id, revision } = snapshot.value;
  try {
    return await api.createBuilderPortrait({ expectedRevision: revision, details });
  } catch (reason) {
    if (snapshot.value?.id === id && snapshot.value.revision === revision && !submitted.value
      && typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409) report(reason);
    throw reason;
  }
}
const portraitUrl = (imageId: string) => pictureUrl({ kind: 'builder' }, imageId);
async function save(submit: boolean) {
  if (!form.value || !snapshot.value || busy.value || submitted.value || conflict.value) return;
  error.value = ''; status.value = '';
  const draft = { ...withDescription(form.value as never, description.value) as CharacterBuilderDraft, possessions: Array.from(form.value.possessions, value => value ?? '') };
  const parsed = submit
    ? CharacterCardDefinitionSchema.safeParse({ ...draft, possessions: draft.possessions.filter(value => value.trim()) })
    : CharacterBuilderDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    error.value = [
      `Review these fields. Nothing has been ${submit ? 'submitted' : 'saved'}.`,
      ...issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Character draft'}: ${issue.message}`),
      ...(issues.length > 3 ? ['Correct these fields, then try again to check the remaining fields.'] : []),
      ...(submit && issues.some(issue => issue.path[0] === 'traits' || issue.path[0] === 'displayName') ? ['Submission needs a character name and traits assigned exactly +2, +1, +1, and +0.'] : []),
    ].join('\n');
    return;
  }
  const value = parsed.data;
  const key = JSON.stringify({ submit, expectedRevision: snapshot.value.revision, draft: value });
  if (retryCommand?.key !== key) retryCommand = { key, commandId: crypto.randomUUID() };
  const input = { commandId: retryCommand.commandId, expectedRevision: snapshot.value.revision, draft: value };
  busy.value = true;
  try {
    accept(await (submit ? api.submitCharacterBuilder(input) : api.saveCharacterBuilder(input)));
    status.value = submit ? 'Submitted to the director' : 'Progress saved. You can return using your private link.';
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
async function close() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    await api.logoutCharacterBuilder();
    snapshot.value = null; form.value = null;
    window.history.replaceState(window.history.state, '', '/build-character');
    status.value = 'Private builder closed. Use your private link to return.';
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="panel player-builder">
    <p class="eyebrow">Your private character</p><h1>Build your character</h1>
    <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
    <p v-if="busy && !snapshot" role="status">Opening your private builder…</p>
    <p v-if="status" role="status">{{ status }}</p>
    <template v-if="snapshot && form">
      <h2>{{ snapshot.label }}</h2>
      <p v-if="snapshot.instructions" class="builder-instructions">{{ snapshot.instructions }}</p>
      <p class="muted">This link opens only your character draft. Keep it private. It expires {{ new Date(snapshot.expiresAt).toLocaleString() }}.</p>
      <template v-if="submitted"><h2>Submitted to the director</h2><p>The director will review your reusable card before use in a show. Your draft is now read-only.</p><p>Available in the director’s character library · version {{ snapshot.submittedTemplate!.version }}</p></template>
      <template v-else><p>Save progress whenever you like, even with unfinished fields. Return using this same private link.</p><p v-if="conflict" class="notice">The saved draft changed. Your unsaved words are preserved. Copy any words you want to keep before loading the saved draft.<button type="button" data-testid="reload-builder-draft" :disabled="busy" @click="reload">Reload saved draft</button></p></template>
      <CharacterForm v-model="form" v-model:description="description" :disabled="busy || submitted" :generation-enabled="!submitted && !conflict" :generation-context="`${snapshot.id}:${snapshot.revision}`" :instructions="snapshot.instructions" :generate="generate" :generate-card="generateCard" :card-generation-note="cardNote" :pictures-enabled="snapshot.picturesEnabled === true" :generate-portrait="generatePortrait" :portrait-url="portraitUrl" />
      <template v-if="!submitted"><p id="builder-submit-help">Submitting sends the current form to the director as one reusable card. You cannot edit this draft after submitting.</p><div class="builder-actions"><button type="button" class="secondary" data-testid="save-builder-draft" :disabled="busy || conflict" @click="save(false)">Save progress</button><button type="button" data-testid="submit-builder-card" aria-describedby="builder-submit-help" :disabled="busy || conflict" @click="save(true)">Submit to director</button></div><p v-if="dirty" class="muted">Unsaved changes</p></template>
      <button type="button" class="quiet" :disabled="busy || dirty" @click="close">Close private builder</button>
      <p v-if="dirty" class="field-help">Save your progress before closing the private builder.</p>
    </template>
    <p v-else-if="!busy && !status" class="muted">Open the private character link from your director to begin or return to your draft.</p>
  </section>
</template>

<style scoped>
.player-builder { max-width: 1080px; margin: 40px auto; }
.builder-instructions { white-space: pre-wrap; overflow-wrap: anywhere; }
.builder-actions { display: flex; flex-wrap: wrap; gap: 16px; }
</style>
