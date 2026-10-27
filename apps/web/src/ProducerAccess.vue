<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { ProducerSummary } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import { producerUrl } from './stream';

const helpPrefix = useId();
const nameHelpId = `${helpPrefix}-name-help`;
const linkHelpId = `${helpPrefix}-link-help`;

const producers = ref<ProducerSummary[]>([]);
const label = ref('');
const busy = ref(false);
const error = ref('');
const shown = ref<{ id: string; name: string; url: string } | null>(null);
const confirming = ref<string | null>(null);
const copied = ref(false);
const copyFailed = ref(false);
const linkBox = ref<HTMLInputElement | null>(null);

function describe(err: unknown) { return err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.'; }
let loadSeq = 0;
let mutation = 0;
async function load(quiet = false) {
  const seq = ++loadSeq;
  const started = mutation;
  try { const result = await api.producers(); if (seq === loadSeq && mutation === started) producers.value = result.producers; } catch (err) { if (!quiet) error.value = describe(err); }
}
function refresh() { if (!busy.value) void load(true); }
function upsert(item: ProducerSummary) {
  const index = producers.value.findIndex(p => p.id === item.id);
  if (index >= 0) producers.value.splice(index, 1, item); else producers.value.unshift(item);
}
async function run(task: () => Promise<void>) {
  busy.value = true; error.value = '';
  try { await task(); } catch (err) { error.value = describe(err); } finally { busy.value = false; }
}
function reveal(summary: ProducerSummary, token: string) {
  copied.value = false; copyFailed.value = false;
  shown.value = { id: summary.id, name: summary.label, url: producerUrl(window.location.origin, token) };
}
function create() {
  const name = label.value.trim();
  if (!name) { error.value = 'Enter a name for the producer.'; return; }
  return run(async () => { const result = await api.createProducer(name); upsert(result.producer); mutation++; reveal(result.producer, result.token); label.value = ''; void load(true); await copy(); });
}
function showLink(item: ProducerSummary) {
  return run(async () => { const result = await api.producerLink(item.id); reveal(result.producer, result.token); });
}
function revoke(item: ProducerSummary) {
  return run(async () => {
    const updated = await api.revokeProducer(item.id);
    upsert(updated); mutation++; confirming.value = null;
    if (shown.value?.id === item.id) shown.value = null;
    void load(true);
  });
}
async function copy() {
  if (!shown.value) return;
  copyFailed.value = false;
  try { await navigator.clipboard.writeText(shown.value.url); copied.value = true; } catch {
    copied.value = false; copyFailed.value = true;
    await nextTick();
    linkBox.value?.select();
  }
}
function status(item: ProducerSummary) {
  if (item.revokedAt) return 'Turned off';
  if (new Date(item.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (item.activeSignIns > 0) return 'Signed in now';
  if (item.lastSignedInAt) return `Active · last signed in ${new Date(item.lastSignedInAt).toLocaleString()}`;
  return 'Active · not used yet';
}
const isActive = (item: ProducerSummary) => status(item).startsWith('Active') || status(item) === 'Signed in now';
const expiry = (item: ProducerSummary) => new Date(item.expiresAt).toLocaleDateString();

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  window.addEventListener('focus', refresh);
  timer = setInterval(refresh, 30000);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh);
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <section class="producer-access" aria-labelledby="producer-access-heading">
    <h3 id="producer-access-heading">Producer access</h3>
    <p class="muted">A producer can run every show you own, edit the library and manage invitations. Only you can create or end producer access.</p>
    <p><a :href="identityPath('/help#producers')">How producer access works</a></p>
    <p v-if="error" role="alert" class="producer-error">{{ error }}</p>
    <label>Producer name<input v-model="label" :aria-describedby="nameHelpId" maxlength="80" @keydown.enter.prevent="create"></label>
    <p :id="nameHelpId" class="field-help">Shown in this list and to the producer after they sign in.</p>
    <button type="button" :disabled="busy" @click="create">Create producer link</button>
    <div v-if="shown" class="producer-link">
      <input ref="linkBox" :aria-label="`Producer link for ${shown.name}`" :aria-describedby="linkHelpId" :value="shown.url" readonly @focus="($event.target as HTMLInputElement).select()">
      <p :id="linkHelpId" class="field-help">Anyone with this link can run your shows until you turn it off. Send it privately.</p>
      <button type="button" class="secondary" @click="copy">Copy link</button>
      <span data-testid="producer-copied" aria-live="polite">{{ copyFailed ? 'Copy did not work. Select the link and copy it by hand.' : copied ? 'Copied. Send it privately. It signs them in.' : '' }}</span>
    </div>
    <ul v-if="producers.length" class="producer-list">
      <li v-for="item in producers" :key="item.id">
        <strong>{{ item.label }}</strong>
        <span class="muted"> · {{ status(item) }} · expires {{ expiry(item) }}</span>
        <template v-if="isActive(item)">
          <button type="button" class="secondary" :disabled="busy" @click="showLink(item)">Show link</button>
          <button v-if="confirming !== item.id" type="button" class="quiet" :disabled="busy" @click="confirming = item.id">Turn off</button>
          <span v-else class="producer-confirm">
            <span>Turn off {{ item.label }}'s access? They are signed out of every tab right away.</span>
            <button type="button" :disabled="busy" @click="revoke(item)">Turn off</button>
            <button type="button" class="secondary" @click="confirming = null">Keep access</button>
          </span>
        </template>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.producer-access { margin-top: 2rem; display: grid; gap: .5rem; }
.producer-access h3 { margin: 0; }
.producer-error { color: var(--gold); margin: 0; }
.producer-link { display: grid; gap: .4rem; }
.producer-list { list-style: none; padding: 0; display: grid; gap: .6rem; }
.producer-list li { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.producer-confirm { display: inline-flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
</style>
