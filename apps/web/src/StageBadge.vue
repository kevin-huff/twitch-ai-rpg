<script setup lang="ts">
import { computed } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { AI_BADGE, statusLabel } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const status = computed(() => statusLabel(props.snapshot.session.status, props.connected));
</script>

<template>
  <div class="top-right">
    <span class="ai-badge">{{ AI_BADGE }}</span>
    <span class="state-chip" :class="{ off: !connected || snapshot.session.status !== 'live' }">{{ status }}</span>
  </div>
</template>

<style scoped>
.top-right { position: absolute; right: 96px; top: 60px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.ai-badge {
  display: block; width: 336px; padding: 16px 20px; box-sizing: border-box; border: 0; border-radius: 0;
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--bone);
  background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.state-chip {
  display: block; height: 44px; padding: 8px 16px; box-sizing: border-box; border: 0; border-radius: 0; white-space: nowrap;
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--bone);
  background: var(--night-raised); box-shadow: inset 0 0 0 4px var(--void), inset 0 0 0 8px var(--herb); clip-path: var(--cut-1);
}
.state-chip.off { box-shadow: inset 0 0 0 4px var(--void), inset 0 0 0 8px var(--candle); }
</style>
