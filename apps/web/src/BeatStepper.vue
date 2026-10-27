<script setup lang="ts">
import { identityPath } from './identity';

defineProps<{ n: number; m: number }>();
const helpHref = identityPath('/help#running-a-show');
</script>

<template>
  <div class="beat-stepper">
    <span class="step-count" data-testid="beat-step-count">Step {{ n }} of {{ m }}</span>
    <a class="step-help" :href="helpHref">How a beat works</a>
  </div>
</template>

<style scoped>
.beat-stepper { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
.step-count { color: var(--muted); font-size: 0.85rem; font-weight: 700; }
.step-help { font-size: 0.85rem; }
</style>
