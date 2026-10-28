<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { PICTURE_MODELS } from '@rpg/contracts';
import type { PictureSettings } from '@rpg/contracts';
import FieldGenerator from './FieldGenerator.vue';

const props = defineProps<{ settings: PictureSettings | null; premise?: string; premiseLabel: string; disabled: boolean }>();
const emit = defineEmits<{ save: [PictureSettings] }>();

const QUICK_PICKS = [
  { label: 'Painterly', text: 'Painterly digital illustration, rich color, cinematic lighting' },
  { label: 'Comic book ink', text: 'Bold black-ink comic book art, flat bright colors, heavy outlines, halftone shading' },
  { label: 'Watercolor storybook', text: 'Soft watercolor storybook illustration, loose washes, warm paper texture' },
  { label: 'Anime', text: 'Clean anime illustration, crisp line art, vivid cel shading' },
  { label: 'Dark fantasy oil painting', text: 'Dark fantasy oil painting, heavy brushstrokes, deep shadows, warm candlelight' },
  { label: 'Cinematic photo', text: 'Cinematic film still, photorealistic, shallow depth of field, moody lighting' },
  { label: 'Pixel art', text: 'Detailed 16-bit pixel art, limited palette, crisp pixels' },
  { label: 'Film noir', text: 'Black-and-white film noir illustration, high contrast, hard shadows' },
] as const;

const helpPrefix = useId();
const style = ref(props.settings?.style ?? '');
const model = ref(props.settings?.model ?? '');
const received = ref<PictureSettings | null>(props.settings);
// What this tab is saving; the server answers with its tidied style (single spaces, no closing period, the scenario's style for a blank box).
const sent = ref<PictureSettings | null>(null);
const tidyStyle = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

watch(() => props.settings, next => {
  const last = received.value;
  const untouched = last === null || (style.value === last.style && model.value === last.model);
  const savedHere = sent.value !== null && last !== null && next !== null && (next.style !== last.style || next.model !== last.model)
    && style.value.trim() === sent.value.style && model.value === sent.value.model;
  received.value = next;
  if (next && (untouched || savedHere)) {
    style.value = next.style;
    model.value = next.model;
    sent.value = null;
  }
});
// A save that failed, or that changed nothing, leaves the box as typed.
watch(() => props.disabled, (disabled, was) => { if (was && !disabled) sent.value = null; });

const unlisted = computed(() => (model.value && !PICTURE_MODELS.some(entry => entry.id === model.value) ? model.value : (props.settings && !PICTURE_MODELS.some(entry => entry.id === props.settings!.model) ? props.settings.model : null)));
const description = computed(() => PICTURE_MODELS.find(entry => entry.id === model.value)?.description ?? '');
const changed = computed(() => received.value !== null && (tidyStyle(style.value) !== received.value.style || model.value !== received.value.model));
const canSave = computed(() => !props.disabled && changed.value);

function save() {
  if (!canSave.value) return;
  sent.value = { style: style.value.trim(), model: model.value };
  emit('save', sent.value);
}
</script>

<template>
  <details v-if="settings" class="picture-settings" data-testid="picture-settings">
    <summary>Picture settings</summary>
    <div class="generated-field">
      <label><span class="field-label">Art style</span><input v-model="style" data-testid="picture-style" maxlength="300" :disabled="disabled" :aria-describedby="`${helpPrefix}-style`"></label>
      <p :id="`${helpPrefix}-style`" class="field-help">One look for every picture in this show: art style, colors and light, in a short phrase. Leave it blank to use the scenario's style.</p>
      <div class="actions picture-style-picks">
        <button v-for="(pick, index) in QUICK_PICKS" :key="pick.label" type="button" class="quiet" :data-testid="`picture-style-pick-${index}`" :disabled="disabled" @click="style = pick.text">{{ pick.label }}</button>
      </div>
      <FieldGenerator class="field-ai" field="scenario.pictureStyle" v-model="style" context-key="picture-settings" :premise="premise" :premise-label="premiseLabel" :disabled="disabled" />
    </div>
    <label><span class="field-label">Picture model</span>
      <select v-model="model" data-testid="picture-model" :disabled="disabled" :aria-describedby="`${helpPrefix}-model`">
        <option v-if="unlisted" :value="unlisted">{{ unlisted }} (server default)</option>
        <option v-for="entry in PICTURE_MODELS" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
      </select>
    </label>
    <p :id="`${helpPrefix}-model`" class="field-help" data-testid="picture-model-description">{{ description }}</p>
    <p class="muted picture-settings-flux">Pictures of a beat use FLUX 3 Klein when anyone in them has a portrait, because it is the only model that can draw your cast from their portraits.</p>
    <div class="actions">
      <button type="button" class="secondary" data-testid="picture-settings-save" :disabled="!canSave" @click="save">Save picture settings</button>
    </div>
  </details>
</template>

<style scoped>
.picture-settings { margin: 0 0 16px; }
.picture-settings summary { cursor: pointer; font-size: 20px; }
.picture-style-picks { margin: 8px 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.picture-settings-flux { font-size: 20px; line-height: 24px; margin: 8px 0; }
</style>
