<script lang="ts">
export function strainWord(value: number, max: number): 'Fresh' | 'Worn' | 'Spent' {
  if (value >= max) return 'Spent';
  if (value >= max / 2) return 'Worn';
  return 'Fresh';
}
</script>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: number; max: number; label?: string; words?: boolean }>(), {
  label: 'Strain',
  words: false,
});

const top = computed(() => Math.max(1, Math.round(Number.isFinite(props.max) ? props.max : 1)));
const now = computed(() => Math.min(top.value, Math.max(0, Math.round(Number.isFinite(props.value) ? props.value : 0))));
const word = computed(() => strainWord(now.value, top.value));
const spent = computed(() => now.value >= top.value);
const text = computed(() =>
  props.words ? word.value : `${props.label} ${now.value} of ${top.value}${spent.value ? ' · Spent' : ''}`,
);
const valueText = computed(() =>
  props.words ? `${word.value}, ${now.value} of ${top.value}` : `${props.label} ${now.value} of ${top.value}`,
);
</script>

<template>
  <div
    class="strain-meter"
    data-testid="strain-meter"
    role="meter"
    aria-valuemin="0"
    :aria-valuemax="top"
    :aria-valuenow="now"
    :aria-label="label"
    :aria-valuetext="valueText"
  >
    <span class="notches" aria-hidden="true" :style="{ gridTemplateColumns: `repeat(${top}, 1fr)` }">
      <span v-for="n in top" :key="n" class="notch" :class="{ filled: n <= now }"></span>
    </span>
    <span class="strain-text" data-testid="strain-meter-text">{{ text }}</span>
  </div>
</template>

<style scoped>
.strain-meter { display: grid; gap: 4px; min-width: 0; }
.notches { display: grid; gap: 2px; min-width: 0; padding: 2px; background: var(--night); box-shadow: var(--frame-slot); }
.notch { display: block; height: 8px; min-width: 0; background: var(--night-raised); }
.notch.filled { background: var(--candle); }
.strain-text { font-family: var(--font-label); font-size: 16px; line-height: 20px; color: var(--bone); min-width: 0; }
</style>
