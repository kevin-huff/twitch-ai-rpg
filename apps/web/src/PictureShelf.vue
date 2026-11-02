<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { DirectorSnapshot, ShelfPicture } from '@rpg/contracts';
import { api } from './api';
import { pictureUrl } from './pictures';

const props = defineProps<{ sessionId: string; snapshot: DirectorSnapshot; busy: boolean }>();

const open = ref(false);
const pictures = ref<ShelfPicture[] | null>(null);
const error = ref('');
const loading = ref(false);
const acting = ref(false);
const actionError = ref('');
const actionNotice = ref('');
const broken = ref<ReadonlySet<string>>(new Set());
let inFlight = false;
let again = false;
let alive = true;
onUnmounted(() => { alive = false; });

async function load() {
  if (inFlight) { again = true; return; }
  inFlight = true;
  loading.value = true;
  try {
    const result = await api.pictures(props.sessionId);
    if (!alive) return;
    pictures.value = result.pictures;
    error.value = '';
  } catch (cause) {
    if (!alive) return;
    error.value = cause instanceof Error && cause.message ? cause.message : 'The pictures could not be loaded.';
  } finally {
    inFlight = false;
    loading.value = false;
    if (again && alive && open.value) { again = false; void load(); }
    else again = false;
  }
}

const locked = computed(() => props.busy || acting.value || props.snapshot.session?.status === 'ended');
const canPin = (item: ShelfPicture) => item.status === 'ready' && !item.held && !item.pinned;

async function act(run: () => Promise<unknown>, notice: string) {
  if (locked.value) return;
  acting.value = true;
  actionError.value = '';
  actionNotice.value = '';
  try {
    await run();
    if (!alive) return;
    actionNotice.value = notice;
    await load();
  } catch (cause) {
    if (!alive) return;
    actionError.value = cause instanceof Error && cause.message ? cause.message : 'That did not work. Try again.';
  } finally {
    acting.value = false;
  }
}
const pin = (item: ShelfPicture) => act(() => api.pinPicture(props.sessionId, item.imageId), '');
const redraw = (item: ShelfPicture) => act(() => api.drawBeatPicture(props.sessionId, item.beatId!), 'Drawing again. The new picture goes on the shelf.');

function toggled(event: Event) {
  const wasOpen = open.value;
  open.value = (event.target as HTMLDetailsElement).open;
  if (open.value && !wasOpen) void load();
}
watch(() => props.snapshot.eventSeq, () => { if (open.value) void load(); });

const scenePictures = computed(() => (pictures.value ?? []).filter(item => item.kind !== 'portrait'));
const portraits = computed(() => (pictures.value ?? []).filter(item => item.kind === 'portrait'));

const thumbnail = (item: ShelfPicture) => (item.status === 'ready' && !broken.value.has(item.imageId) ? pictureUrl({ kind: 'session', sessionId: props.sessionId }, item.imageId) : null);
const markBroken = (imageId: string) => { broken.value = new Set([...broken.value, imageId]); };
const statusWords = (item: ShelfPicture) => {
  if (item.status === 'making') return 'Being drawn…';
  if (item.status === 'failed') return 'Could not be drawn.';
  return item.held ? 'Shown when you publish the beat.' : '';
};
</script>

<template>
  <details class="panel picture-shelf" data-testid="picture-shelf" @toggle="toggled">
    <summary>Picture shelf</summary>
    <p v-if="error" class="notice error" role="alert" data-testid="shelf-error">{{ error }}</p>
    <p v-if="actionError" class="notice error" role="alert" data-testid="shelf-action-error">{{ actionError }}</p>
    <p v-if="actionNotice" class="notice" role="status" data-testid="shelf-notice">{{ actionNotice }}</p>
    <p v-if="pictures === null && loading && !error" class="muted" role="status" data-testid="shelf-loading">Loading pictures…</p>
    <template v-if="pictures !== null">
      <p v-if="!pictures.length" class="muted" data-testid="shelf-empty">No pictures yet.</p>
      <template v-for="group in [{ key: 'scenes', title: 'Scene pictures', items: scenePictures }, { key: 'portraits', title: 'Portraits', items: portraits }]" :key="group.key">
        <section v-if="group.items.length" class="shelf-group" :data-testid="`shelf-group-${group.key}`">
          <h3>{{ group.title }}</h3>
          <ul class="shelf-grid">
            <li v-for="item in group.items" :key="item.imageId" class="shelf-item" :class="{ 'is-portrait': item.kind === 'portrait' }" :data-testid="`shelf-picture-${item.imageId}`">
              <img v-if="thumbnail(item)" class="shelf-thumb" :src="thumbnail(item)!" :alt="item.label" loading="lazy" @error="markBroken(item.imageId)" />
              <div v-else class="shelf-thumb shelf-thumb-empty" aria-hidden="true"></div>
              <p class="shelf-label">{{ item.label }}</p>
              <p v-if="item.scene" class="muted shelf-scene">{{ item.scene }}</p>
              <p v-if="statusWords(item)" class="shelf-status" :data-testid="`shelf-status-${item.imageId}`">{{ statusWords(item) }}</p>
              <p v-if="item.status === 'failed' && item.message" class="muted shelf-message">{{ item.message }}</p>
              <p v-if="item.onStream || item.pinned" class="shelf-tags">
                <span v-if="item.onStream" class="shelf-tag" data-testid="shelf-tag-stream">On stream</span>
                <span v-if="item.pinned" class="shelf-tag" data-testid="shelf-tag-pinned">Pinned</span>
              </p>
              <div v-if="canPin(item) || item.beatId" class="shelf-actions">
                <button v-if="canPin(item)" type="button" class="secondary" :disabled="locked" :data-testid="`shelf-pin-${item.imageId}`" @click="pin(item)">Show on stream</button>
                <button v-if="item.beatId" type="button" class="secondary" :disabled="locked" :data-testid="`shelf-redraw-${item.imageId}`" @click="redraw(item)">Draw again</button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </details>
</template>

<style scoped>
.picture-shelf > p { margin-top: 20px; }
.shelf-group { min-width: 0; margin-top: 20px; }
.shelf-group h3 { margin: 0 0 12px; }
.shelf-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.shelf-item { min-width: 0; }
.shelf-item p { margin: 8px 0 0; overflow-wrap: anywhere; }
.shelf-thumb { display: block; box-sizing: border-box; width: 100%; padding: 2px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); aspect-ratio: 1344 / 768; object-fit: cover; }
.shelf-item.is-portrait .shelf-thumb { aspect-ratio: 1 / 1; object-fit: contain; }
.shelf-thumb-empty { min-height: 48px; }
.shelf-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.shelf-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.shelf-tag { font-family: var(--font-label); color: var(--bone); background: var(--night-raised); box-shadow: var(--frame-good); clip-path: var(--cut-1); padding: 4px 8px; }
</style>
