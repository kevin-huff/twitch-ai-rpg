<script setup lang="ts">
import { computed } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const facts = computed(() => [...(props.snapshot.facts ?? [])].reverse());
</script>

<template>
  <section v-if="facts.length" class="facts" data-testid="public-facts">
    <p class="label">Known to the party</p>
    <div class="facts-body">
      <p v-for="fact in facts" :key="fact.id" class="fact">{{ fact.text }}</p>
    </div>
  </section>
</template>

<style scoped>
.facts { position: absolute; left: 0; top: 0; width: 464px; max-height: 345px; box-sizing: border-box; min-height: 0; overflow: hidden; padding: 16px 20px; background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1); display: flex; flex-direction: column; }
.facts-body { flex: 0 1 auto; min-height: 0; overflow: hidden; }
.fact { font-family: var(--font-body); font-size: 24px; line-height: 28px; font-weight: 400; color: var(--bone); margin: 0 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.label { font-family: var(--font-label); font-size: 24px; line-height: 28px; font-weight: 400; text-transform: uppercase; letter-spacing: 0; color: var(--candle); margin: 0 0 8px; }
</style>
