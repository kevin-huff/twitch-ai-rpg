<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import type { InviteSummary, PublicCharacter } from '@rpg/contracts';
import { api } from './api';

const props = defineProps<{ sessionId: string; characters: PublicCharacter[] }>();
const prefix = useId();
const fieldId = (key: string) => `${prefix}-${key}`;
const open = ref(false);
const loading = ref(false);
const working = ref(false);
const loadError = ref('');
const actionError = ref('');
const invites = ref<InviteSummary[]>([]);
const tokens = ref<Record<string, string>>({});
const reissuing = ref('');
const signOut = ref(false);
const copied = ref('');
const copyFailed = ref('');
const urlInputs = new Map<string, HTMLInputElement>();

const rows = computed(() => invites.value.filter(item => item.status !== 'replaced'));
const statusWord = (invite: InviteSummary) => ({ waiting: 'Waiting', joined: 'Joined', expired: 'Expired', revoked: 'Revoked', replaced: 'Replaced' })[invite.status];
const seatName = (invite: InviteSummary) => invite.role === 'stage' ? 'Stage' : props.characters.find(item => item.id === invite.characterId)?.displayName ?? 'Player';
const urlOf = (id: string) => tokens.value[id] ? `${window.location.origin}/join/${encodeURIComponent(tokens.value[id])}` : '';

async function load() {
  loading.value = true; loadError.value = '';
  try { invites.value = (await api.invites(props.sessionId)).invites; }
  catch { loadError.value = 'The seats could not be loaded. Try again in a moment.'; }
  finally { loading.value = false; }
}

async function toggle() {
  open.value = !open.value;
  if (open.value && !invites.value.length) await load();
}

async function guard(task: () => Promise<void>, message: string) {
  working.value = true; actionError.value = '';
  try { await task(); } catch { actionError.value = message; } finally { working.value = false; }
}

const reveal = (invite: InviteSummary) => guard(async () => {
  const shown = await api.inviteLink(props.sessionId, invite.id);
  tokens.value = { ...tokens.value, [shown.invite.id]: shown.token };
}, 'This link could not be shown. Try again.');

const startReissue = (invite: InviteSummary) => { reissuing.value = invite.id; signOut.value = false; };
const cancelReissue = () => { reissuing.value = ''; signOut.value = false; };

const reissue = (invite: InviteSummary) => guard(async () => {
  const fresh = await api.reissueInvite(props.sessionId, invite.id, signOut.value);
  tokens.value = { ...tokens.value, [fresh.invite.id]: fresh.token };
  reissuing.value = ''; signOut.value = false;
  await load();
}, 'The link could not be reissued. Try again.');

async function copy(id: string) {
  const url = urlOf(id); if (!url) return;
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; }
  catch {
    const input = urlInputs.get(id);
    if (input) {
      input.select();
      try { ok = document.execCommand('copy') === true; } catch { ok = false; }
    }
  }
  if (ok) { copied.value = id; copyFailed.value = ''; }
  else { copied.value = ''; copyFailed.value = id; }
}
const section = ref<HTMLElement | null>(null);
onMounted(async () => {
  if (window.location.hash !== '#seat-links') return;
  if (!open.value) await toggle();
  await nextTick();
  section.value?.scrollIntoView?.({ block: 'start' });
});
const bindInput = (id: string) => (element: unknown) => { if (element instanceof HTMLInputElement) urlInputs.set(id, element); else urlInputs.delete(id); };
</script>

<template>
  <section id="seat-links" ref="section" class="lobby-section">
    <h3>Seats &amp; invitation links</h3>
    <p>See who has joined, show a waiting link again, or replace a link that went to the wrong person.</p>
    <button class="secondary" type="button" :aria-expanded="open" :aria-controls="fieldId('body')" @click="toggle">{{ open ? 'Hide seats & invitation links' : 'Show seats & invitation links' }}</button>
    <div v-if="open" :id="fieldId('body')" class="links-body">
      <p v-if="loading" class="muted">Loading seats…</p>
      <p v-if="loadError" class="notice error" aria-live="polite">{{ loadError }}</p>
      <p v-if="actionError" class="notice error" aria-live="polite">{{ actionError }}</p>
      <template v-if="!loading && !loadError">
        <p v-if="!rows.length" class="muted">No invitations have been made yet.</p>
        <article v-for="invite in rows" :key="invite.id" class="link-row">
          <div class="link-title"><strong>{{ seatName(invite) }}</strong> <span class="status-word">{{ statusWord(invite) }}</span> <small v-if="invite.signedIn" class="muted">Signed in now</small></div>
          <template v-if="tokens[invite.id]">
            <label>Link address
              <input :ref="bindInput(invite.id)" readonly :value="urlOf(invite.id)" :aria-describedby="fieldId(`${invite.id}-url-help`)" @focus="($event.target as HTMLInputElement).select()" />
            </label>
            <p :id="fieldId(`${invite.id}-url-help`)" class="field-help">Send this address to the player. It opens their seat in the browser.</p>
          </template>
          <div class="actions">
            <button v-if="invite.status === 'waiting' && !tokens[invite.id]" type="button" class="secondary" :disabled="working" @click="reveal(invite)">Show link</button>
            <template v-if="tokens[invite.id]">
              <button type="button" class="secondary" @click="copy(invite.id)">Copy link</button>
              <span class="copied" aria-live="polite">{{ copyFailed === invite.id ? 'Copy failed. Select the link and copy it.' : copied === invite.id ? 'Copied' : '' }}</span>
            </template>
            <button v-if="reissuing !== invite.id" type="button" class="quiet" :disabled="working" @click="startReissue(invite)">Reissue link</button>
          </div>
          <div v-if="reissuing === invite.id" class="confirm">
            <label class="check"><input v-model="signOut" type="checkbox" :aria-describedby="fieldId(`${invite.id}-signout-help`)" />Also sign out whoever is using the old link</label>
            <p :id="fieldId(`${invite.id}-signout-help`)" class="field-help">Use this when a link went to the wrong person or leaked. The player must open the new link.</p>
            <p>The old link stops working. Send the new one to the player.</p>
            <button type="button" :disabled="working" @click="reissue(invite)">Reissue</button>
            <button type="button" class="secondary" @click="cancelReissue">Cancel</button>
          </div>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.lobby-section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.5rem; }
.links-body { margin-top: 1rem; display: grid; gap: 1rem; }
.link-row { border: 1px solid var(--line); border-radius: 6px; padding: 1rem; display: grid; gap: .3rem; }
.link-row label { max-width: 32rem; }
.link-row input[type="text"], .link-row input:not([type]) { width: 100%; }
.status-word { color: var(--teal); font-size: .85rem; margin-left: .5rem; }
.actions, .confirm { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: .4rem; }
.confirm p { flex-basis: 100%; margin: 0; }
.copied { color: var(--teal); font-size: .85rem; }
</style>
