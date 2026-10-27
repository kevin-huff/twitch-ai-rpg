<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { CharacterBuilderLink, CharacterBuilderSummary } from '@rpg/contracts';
import { api } from './api';
import ErrorNotice from './ErrorNotice.vue';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ 'refresh-library': [] }>();
const prefix = useId();
const helpId = (field: string) => `${prefix}-builder-${field}`;
const opened = ref(false);
const loaded = ref(false);
const busy = ref(false);
const locked = computed(() => busy.value || props.disabled);
const builders = ref<CharacterBuilderSummary[]>([]);
const label = ref('');
const instructions = ref('');
const link = ref<CharacterBuilderLink | null>(null);
const linkUrl = computed(() => link.value ? `${window.location.origin}/build-character#token=${encodeURIComponent(link.value.token)}` : '');
const error = ref('');
let retryCreate: { key: string; commandId: string } | undefined;
const date = (value: string) => new Date(value).toLocaleString();
const active = (builder: CharacterBuilderSummary) => !builder.revokedAt && new Date(builder.expiresAt).getTime() > Date.now();
function report(reason: unknown) { error.value = reason instanceof Error ? reason.message : 'The request failed. Please try again.'; }
function update(builder: CharacterBuilderSummary) {
  const index = builders.value.findIndex(item => item.id === builder.id);
  if (index < 0) builders.value.unshift(builder);
  else builders.value[index] = builder;
}
async function load(refreshLibrary = false) {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api.characterBuilders();
    builders.value = result.builders; loaded.value = true;
    if (refreshLibrary) emit('refresh-library');
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
async function toggle(event: Event) {
  opened.value = (event.target as HTMLDetailsElement).open;
  if (opened.value && !loaded.value) await load();
}
async function create() {
  if (locked.value) return;
  error.value = '';
  if (!label.value.trim()) { error.value = 'Enter a player name or label for this private link.'; return; }
  const value = { label: label.value.trim(), instructions: instructions.value };
  const key = JSON.stringify(value);
  if (retryCreate?.key !== key) retryCreate = { key, commandId: crypto.randomUUID() };
  busy.value = true;
  try {
    const result = await api.createCharacterBuilder({ commandId: retryCreate.commandId, ...value });
    link.value = result; update(result.builder); retryCreate = undefined;
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
async function showLink(builder: CharacterBuilderSummary) {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api.characterBuilderLink(builder.id);
    link.value = result; update(result.builder);
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
async function revoke(builder: CharacterBuilderSummary) {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try {
    update(await api.revokeCharacterBuilder(builder.id, { commandId: crypto.randomUUID() }));
    if (link.value?.builder.id === builder.id) link.value = null;
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <details class="panel builder-invites" @toggle="toggle">
    <summary>Invite players to build characters</summary>
    <div v-if="opened" class="builder-content">
      <p>Use a private character link when a player wants to write their card days before the show. The link lasts 30 days, and the player can save an unfinished draft and submit one card to your library. A player who writes on show day needs no link. Choose Player writes their own character for their seat when you create a custom show.</p>
      <ErrorNotice v-if="error" class="builder-error" :message="error" @dismiss="error = ''" />
      <fieldset :disabled="locked">
        <label>Player name or label<input v-model="label" data-testid="builder-label" maxlength="80" :aria-describedby="helpId('label')"></label>
        <p :id="helpId('label')" class="field-help">Identifies this player’s invitation in your library and on their private builder.</p>
        <label>Character instructions<textarea v-model="instructions" data-testid="builder-instructions" maxlength="4000" rows="3" :aria-describedby="helpId('instructions')" /></label>
        <p :id="helpId('instructions')" class="field-help">These instructions are shared with this player. Include public character guidance; leave out private scenario notes and other characters’ secrets.</p>
        <button type="button" data-testid="create-builder-link" @click="create">Create character link</button>
      </fieldset>
      <div v-if="link" class="private-link">
        <label>Private character link for {{ link.builder.label }}<input :value="linkUrl" data-testid="builder-link" readonly :aria-describedby="helpId('link')" @focus="($event.target as HTMLInputElement).select()"></label>
        <p :id="helpId('link')" class="field-help">Copy and share only with {{ link.builder.label }}. This private reusable link grants access to their own card until {{ date(link.builder.expiresAt) }}. Anyone holding it can open that card.</p>
      </div>
      <button type="button" class="secondary" data-testid="refresh-builder-submissions" :disabled="locked" @click="load(true)">Refresh player submissions</button>
      <p v-if="busy" role="status">Updating character invitations…</p>
      <p v-else-if="loaded && !builders.length" class="muted">No character invitations yet.</p>
      <ul class="builder-list">
        <li v-for="builder in builders" :key="builder.id">
          <strong>{{ builder.label }}</strong>
          <p v-if="builder.revokedAt">Turned off {{ date(builder.revokedAt) }}</p>
          <p v-else-if="!active(builder)">Expired {{ date(builder.expiresAt) }}</p>
          <p v-else>Active · expires {{ date(builder.expiresAt) }}</p>
          <p v-if="builder.submittedTemplate">Submitted {{ builder.submittedAt ? date(builder.submittedAt) : '' }} · version {{ builder.submittedTemplate.version }}</p>
          <p v-else class="muted">Awaiting player submission</p>
          <div v-if="active(builder)" class="builder-actions"><button type="button" class="secondary" :aria-label="`Show link for ${builder.label}`" :disabled="locked" @click="showLink(builder)">Show link</button><button type="button" class="quiet" :aria-label="`Turn off link for ${builder.label}`" :disabled="locked" @click="revoke(builder)">Turn off</button></div>
        </li>
      </ul>
    </div>
  </details>
</template>

<style scoped>
.builder-invites { margin-bottom: 1.5rem; }
.builder-content { padding-top: 1rem; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.builder-error { position: static; width: auto; max-height: none; margin-bottom: 1rem; box-shadow: none; }
.private-link { margin: 1rem 0; }
.builder-list { list-style: none; padding: 0; }
.builder-list li { padding: 1rem 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.builder-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
</style>
