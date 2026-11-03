<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import type { PublicCharacter } from '@rpg/contracts';

const props = withDefaults(defineProps<{
  testid: string; title: string; copyLabel: string;
  url: (who: string | null) => string; previewUrl?: (who: string | null) => string;
  size?: string; tagged?: boolean; characters?: PublicCharacter[]; defaultWho?: string | null;
}>(), { previewUrl: undefined, size: undefined, tagged: false, characters: () => [], defaultWho: null });

const prefix = useId();
const knownId = (value: string | null | undefined) => (value && props.characters.some(character => character.id === value) ? value : '');
const who = ref(knownId(props.defaultWho));
const note = ref<'' | 'copied' | 'failed'>('');
const fallback = ref<HTMLInputElement | null>(null);
const fallbackUrl = ref('');

const picked = computed(() => props.characters.find(character => character.id === who.value) ?? null);
const whoValue = computed(() => (picked.value ? picked.value.id : null));
const address = computed(() => props.url(whoValue.value));
const tag = computed(() => (picked.value ? `Just for ${picked.value.displayName}` : 'Shared'));

async function copy() {
  const url = address.value;
  let done = false;
  try { await navigator.clipboard.writeText(url); done = true; }
  catch { done = false; }
  fallbackUrl.value = done ? '' : url;
  note.value = done ? 'copied' : 'failed';
  if (!done) {
    await nextTick();
    fallback.value?.select();
    try { done = document.execCommand('copy') === true; } catch { done = false; }
    if (done) { fallbackUrl.value = ''; note.value = 'copied'; }
  }
}

function preview() {
  if (props.previewUrl) window.open(props.previewUrl(whoValue.value), '_blank', 'noopener');
}

function pick(value: string) {
  who.value = knownId(value);
  note.value = ''; fallbackUrl.value = '';
}
</script>

<template>
  <article class="kit-link" :data-testid="testid">
    <div class="kit-head">
      <strong class="kit-title">{{ title }}</strong>
      <span v-if="tagged" class="kit-tag" data-testid="kit-tag">{{ tag }}</span>
      <span v-if="size" class="kit-size" data-testid="kit-size">{{ size }}</span>
    </div>
    <div class="kit-text"><slot /></div>
    <template v-if="characters.length">
      <label class="kit-who-label">Who it shows
        <select class="kit-who" data-testid="kit-who" :value="who" :aria-describedby="`${prefix}-who-help`" @change="pick(($event.target as HTMLSelectElement).value)">
          <option value="">Everyone</option>
          <option v-for="character in characters" :key="character.id" :value="character.id">{{ character.displayName }}</option>
        </select>
      </label>
      <p :id="`${prefix}-who-help`" class="field-help">Pick one person to make a link that shows only them, or leave it on Everyone.</p>
    </template>
    <div class="kit-actions">
      <button v-if="previewUrl" type="button" class="secondary" data-testid="kit-preview" @click="preview">Preview (silent)</button>
      <button type="button" class="secondary" data-testid="kit-copy" :data-url="address" @click="copy">{{ copyLabel }}</button>
    </div>
    <p class="kit-note" aria-live="polite">
      <template v-if="note === 'copied'">Copied</template>
      <template v-else-if="note === 'failed'">Copy failed. Select the link and copy it.</template>
    </p>
    <template v-if="note === 'failed'">
      <input ref="fallback" class="kit-fallback" data-testid="kit-copy-fallback" readonly aria-label="Link address" :aria-describedby="`${prefix}-fallback-help`" :value="fallbackUrl" @focus="($event.target as HTMLInputElement).select()" />
      <p :id="`${prefix}-fallback-help`" class="field-help">This is the link. Select it and copy it by hand.</p>
    </template>
  </article>
</template>

<style scoped>
.kit-link { position: relative; padding: 16px; display: grid; gap: 10px; align-content: start; min-width: 0; }
.kit-link::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.kit-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; }
.kit-title { font-size: 24px; line-height: 28px; }
.kit-tag, .kit-size { font-size: 20px; line-height: 24px; color: var(--dust); }
.kit-tag { color: var(--herb); }
.kit-text, .kit-text :deep(p), .field-help, .kit-note { margin: 0; overflow-wrap: anywhere; }
.kit-who-label { display: grid; gap: 4px; max-width: 400px; }
.kit-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.kit-note { color: var(--herb); font-size: 20px; line-height: 24px; }
.kit-note:empty { display: none; }
.kit-fallback { width: 100%; max-width: 640px; }
</style>
