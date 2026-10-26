<script setup lang="ts">
import { computed } from 'vue';
import { identityPath } from './identity';
import { STEP_LABELS, STEP_ORDER, type StepId } from './beat-step';

const props = defineProps<{ step: StepId; next: string; reason: string | null }>();
const currentIndex = computed(() => STEP_ORDER.indexOf(props.step));
const helpHref = identityPath('/help#running-a-show');
</script>

<template>
  <div class="beat-stepper">
    <ol aria-label="Beat steps">
      <li v-for="(id, index) in STEP_ORDER" :key="id" :class="{ done: index < currentIndex, current: index === currentIndex }" :aria-current="index === currentIndex ? 'step' : undefined">
        <span class="step-label">{{ STEP_LABELS[id] }}</span>
        <span v-if="index < currentIndex" class="step-done">Done</span>
      </li>
    </ol>
    <p class="step-next" aria-live="polite"><strong>{{ next }}</strong><span v-if="reason" class="step-reason">{{ ' ' + reason }}</span></p>
    <a class="step-help" :href="helpHref">How a beat works</a>
  </div>
</template>

<style scoped>
.beat-stepper { display: grid; gap: 8px; margin-bottom: 12px; }
ol { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
li { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 0.85rem; }
li.done { color: var(--teal); }
li.current { border-color: var(--gold); color: var(--gold); font-weight: 700; }
.step-done { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.step-next { margin: 0; }
.step-reason { color: var(--muted); }
.step-help { font-size: 0.85rem; }
</style>
