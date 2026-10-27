<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import type { StreamAudio, StreamLayout, StreamLinkSummary } from '@rpg/contracts';
import { streamUrl } from './stream';

const props = withDefaults(defineProps<{
  link: StreamLinkSummary; token: string; title: string; compact?: boolean; canTurnOff?: boolean; busy?: boolean; testid?: string;
}>(), { compact: false, canTurnOff: true, busy: false, testid: undefined });
const emit = defineEmits<{ 'turn-off': [] }>();

const prefix = useId();
const sound = ref<StreamAudio | null>(null);
const audio = computed<StreamAudio>(() => sound.value ?? (props.link.canPresent ? 'present' : 'listen'));
const confirming = ref(false);
const note = ref<'' | 'copied' | 'failed'>('');
const fallback = ref<HTMLInputElement | null>(null);
const fallbackUrl = ref('');

const addressOf = (layout: StreamLayout) => streamUrl(window.location.origin, props.token, { layout, audio: audio.value });
const overlayUrl = computed(() => addressOf('overlay'));
const sceneUrl = computed(() => addressOf('scene'));
const soundLine = computed(() => audio.value === 'present'
  ? 'This link carries the show audio.'
  : audio.value === 'listen'
    ? 'This link plays the narration only where it is opened.'
    : 'This link has no sound.');

async function copy(url: string) {
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

function preview(layout: StreamLayout) {
  window.open(streamUrl(window.location.origin, props.token, { layout, audio: 'off', checker: layout === 'overlay' }), '_blank', 'noopener');
}

function setSound(value: string) {
  sound.value = value === 'present' && props.link.canPresent ? 'present' : value === 'off' ? 'off' : 'listen';
  note.value = ''; fallbackUrl.value = '';
}

function turnOff() { emit('turn-off'); confirming.value = false; }
</script>

<template>
  <article class="stream-card" :data-testid="testid">
    <strong class="stream-card-title">{{ title }}</strong>
    <div class="copy-row">
      <button type="button" class="secondary" data-testid="copy-overlay" :data-url="overlayUrl" @click="copy(overlayUrl)">Copy overlay link</button>
      <p class="field-help">Captions, cast and dice over your own camera, on a see-through background.</p>
    </div>
    <div class="copy-row">
      <button type="button" class="secondary" data-testid="copy-scene" :data-url="sceneUrl" @click="copy(sceneUrl)">Copy full-scene link</button>
      <p class="field-help">The whole show as one 1920×1080 picture.</p>
    </div>
    <p class="copy-note" aria-live="polite">
      <template v-if="note === 'copied'">Copied</template>
      <template v-else-if="note === 'failed'">Copy failed. Select the link and copy it.</template>
    </p>
    <input v-if="note === 'failed'" ref="fallback" class="copy-fallback" data-testid="copy-fallback" readonly aria-label="Link address" :value="fallbackUrl" @focus="($event.target as HTMLInputElement).select()" />
    <p class="field-help" data-testid="sound-line">{{ soundLine }}</p>
    <template v-if="!compact">
      <div class="preview-row">
        <button type="button" class="secondary" data-testid="preview-overlay" @click="preview('overlay')">Preview (silent) overlay</button>
        <button type="button" class="secondary" data-testid="preview-scene" @click="preview('scene')">Preview (silent) full scene</button>
      </div>
      <details data-testid="sound-options">
        <summary>Sound options</summary>
        <label>Sound
          <select data-testid="sound-select" :value="audio" @change="setSound(($event.target as HTMLSelectElement).value)">
            <option v-if="link.canPresent" value="present">Show audio</option>
            <option value="listen">Listen only</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p class="field-help">If this computer also plays the story, turn this link's sound off or you'll hear it twice.</p>
      </details>
      <details data-testid="obs-steps">
        <summary>How to add this in OBS</summary>
        <ol>
          <li>In OBS, open Sources, press +, and choose Browser.</li>
          <li>Paste the link into URL.</li>
          <li>Set Width to 1920 and Height to 1080.</li>
          <li>Untick Shutdown source when not visible and Refresh browser when scene becomes active.</li>
          <li v-if="link.canPresent">Tick Control audio via OBS.</li>
        </ol>
      </details>
      <div v-if="canTurnOff" class="turn-off">
        <button v-if="!confirming" type="button" class="quiet" data-testid="turn-off" :disabled="busy" @click="confirming = true">Turn off</button>
        <div v-else class="confirm" :aria-labelledby="`${prefix}-confirm`">
          <p :id="`${prefix}-confirm`">Turn off this link? OBS sources using it switch to a holding screen within seconds.</p>
          <button type="button" data-testid="turn-off-confirm" :disabled="busy" @click="turnOff">Turn off</button>
          <button type="button" class="secondary" data-testid="turn-off-keep" :disabled="busy" @click="confirming = false">Keep link</button>
        </div>
      </div>
    </template>
  </article>
</template>

<style scoped>
.stream-card { border: 1px solid var(--line); border-radius: 6px; padding: 1rem; display: grid; gap: .5rem; }
.copy-row { display: grid; gap: .2rem; justify-items: start; }
.copy-row p, .field-help { margin: 0; }
.preview-row, .confirm { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
.confirm p { flex-basis: 100%; margin: 0; }
.copy-note { margin: 0; color: var(--teal); font-size: .85rem; min-height: 0; }
.copy-note:empty { display: none; }
.copy-fallback { width: 100%; max-width: 32rem; }
details label { display: grid; gap: .25rem; max-width: 20rem; margin-top: .5rem; }
ol { margin: .5rem 0 0; padding-left: 1.25rem; }
</style>
