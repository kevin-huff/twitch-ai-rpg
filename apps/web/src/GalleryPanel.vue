<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import type { GalleryAction, GalleryStatus } from '@rpg/contracts';

const props = defineProps<{ status: GalleryStatus | null; busy: boolean }>();
const emit = defineEmits<{ action: [GalleryAction['action']] }>();

const confirming = ref<'new_link' | 'off' | null>(null);
const urlBox = useTemplateRef<HTMLInputElement>('urlBox');

const picturesText = (n: number) => (n === 1 ? '1 picture' : `${n} pictures`);
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

const statusLine = computed(() => {
  const s = props.status;
  if (!s) return '';
  if (s.state === 'closed') return 'The gallery opens once the show has ended.';
  if (!s.writtenAt) return s.message ? 'Gallery on · not written yet' : 'Writing the gallery…';
  const time = timeFormat.format(new Date(s.writtenAt)).replace(/\s/g, ' ').toLowerCase();
  return `Gallery on · ${picturesText(s.pictures)} · written ${time}`;
});
const pendingLine = computed(() => {
  const n = props.status?.pending ?? 0;
  return n === 1
    ? "1 picture is still being made. It'll be added when it finishes."
    : `${n} pictures are still being made. They'll be added when they finish.`;
});

function selectBox() {
  const box = urlBox.value;
  if (!box) return;
  box.focus();
  box.select();
}
async function copyLink() {
  const url = props.status?.url;
  if (!url) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(url);
  } catch {
    selectBox();
  }
}
function confirmYes() {
  const action = confirming.value;
  confirming.value = null;
  if (action) emit('action', action);
}
</script>

<template>
  <section v-if="status" class="panel gallery-panel" data-testid="gallery-panel">
    <p class="eyebrow">Gallery</p>
    <p v-if="status.state === 'closed'" role="status" class="gallery-status" data-testid="gallery-status">{{ statusLine }}</p>
    <template v-else-if="status.state === 'off'">
      <button type="button" data-testid="gallery-on" :disabled="busy" @click="emit('action', 'on')">Turn on gallery</button>
      <p class="muted gallery-help">Writes a page of every picture from this show that anyone with the link can open.</p>
    </template>
    <template v-else>
      <p role="status" class="gallery-status" data-testid="gallery-status">{{ statusLine }}</p>
      <p v-if="status.pending > 0" class="muted" data-testid="gallery-pending">{{ pendingLine }}</p>
      <p v-if="status.message" class="gallery-failure" data-testid="gallery-message">{{ status.message }}</p>
      <label class="gallery-link-row">Gallery link
        <input ref="urlBox" type="text" readonly data-testid="gallery-url" :value="status.url ?? ''" />
      </label>
      <button type="button" class="secondary" data-testid="gallery-copy" @click="copyLink">Copy link</button>
      <details class="gallery-more" data-testid="gallery-more">
        <summary>More gallery options</summary>
        <button v-if="!status.listed" type="button" class="secondary" data-testid="gallery-list" :disabled="busy" @click="emit('action', 'list')">Add to public list</button>
        <template v-else>
          <p data-testid="gallery-listed">On the public list</p>
          <button type="button" class="secondary" data-testid="gallery-unlist" :disabled="busy" @click="emit('action', 'unlist')">Remove from public list</button>
        </template>
        <p class="muted" data-testid="gallery-list-url">Public list: <a :href="status.listUrl" target="_blank" rel="noopener">{{ status.listUrl }}</a></p>
        <div class="gallery-failure">
          <button type="button" class="secondary" data-testid="gallery-rewrite" :disabled="busy" @click="emit('action', 'rewrite')">Write the gallery again</button>
        </div>
        <div v-if="!confirming" class="gallery-danger">
          <button type="button" class="secondary" data-testid="gallery-new-link" :disabled="busy" @click="confirming = 'new_link'">New link</button>
          <button type="button" class="secondary" data-testid="gallery-off" :disabled="busy" @click="confirming = 'off'">Turn off gallery</button>
        </div>
        <div v-else class="beat-confirm" data-testid="gallery-confirm">
          <p>This stops the link you may have posted in chat.</p>
          <button type="button" class="secondary" data-testid="gallery-confirm-yes" :disabled="busy" @click="confirmYes">{{ confirming === 'new_link' ? 'Yes, make a new link' : 'Yes, turn it off' }}</button>
          <button type="button" class="secondary" data-testid="gallery-keep" @click="confirming = null">Keep it</button>
        </div>
        <p v-if="status.local" class="muted" data-testid="gallery-local">These links only work on this computer until the app is deployed.</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.gallery-link-row { display: grid; gap: 4px; margin-block: 8px; }
.gallery-failure { display: grid; gap: 8px; margin-block: 8px; }
.gallery-more { margin-block: 8px; }
.gallery-more > summary { cursor: pointer; }
.gallery-danger { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 8px; }
</style>
