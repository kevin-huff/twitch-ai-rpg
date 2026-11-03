<script setup lang="ts">
import { computed } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const correction = computed(() => {
  const all = props.snapshot.corrections ?? [];
  let newest: (typeof all)[number] | null = null;
  for (const item of all) {
    if (!newest || item.stateRevision > newest.stateRevision
      || (item.stateRevision === newest.stateRevision && Date.parse(item.recordedAt) >= Date.parse(newest.recordedAt))) newest = item;
  }
  return newest;
});
</script>

<template>
  <section v-if="correction" class="correction" aria-label="Published corrections">
    <span class="correction-tag">Correction</span>
    <span class="correction-text" data-testid="published-correction">{{ correction.publicText }}</span>
  </section>
</template>

<style scoped>
.correction {
  position: absolute; left: 0; top: 0; width: 1728px; height: 88px; box-sizing: border-box; display: flex; gap: 16px; align-items: flex-start; overflow: hidden;
  padding: 16px 20px; background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.correction-tag { flex: 0 0 auto; font-family: var(--font-label); font-size: 24px; line-height: 28px; font-weight: 400; text-transform: uppercase; color: var(--candle); }
.correction-text { flex: 1 1 0; min-width: 0; font-family: var(--font-body); font-size: 24px; line-height: 28px; font-weight: 400; color: var(--bone); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
</style>
