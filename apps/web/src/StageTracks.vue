<script setup lang="ts">
import { computed } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { slateKind } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const slate = computed(() => slateKind(props.snapshot));
const tracks = computed(() => props.snapshot.tracks.filter(track => track.enabled).slice(0, 2));

function kindWord(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
</script>

<template>
  <div v-if="tracks.length && !slate" class="rail">
    <div v-for="item in tracks" :key="item.id" class="rail-item" :data-kind="item.kind">
      <div class="rail-head"><span class="rail-label">{{ item.label }}</span><span class="rail-count">{{ item.current }}/{{ item.max }}</span></div>
      <div class="pips" :aria-label="`${item.label}: ${item.current} of ${item.max}`"><i v-for="pip in item.max" :key="pip" :class="{ filled: pip <= item.current }"></i></div>
      <span class="rail-kind">{{ kindWord(item.kind) }}</span>
    </div>
  </div>
</template>

<style scoped>
.pips {
  display: flex; gap: 4px; padding: 4px; box-sizing: border-box; height: 24px; background: var(--night-raised);
  box-shadow: var(--canvas-frame-slot); clip-path: var(--cut-1);
}
.pips i { display: block; flex: 1 1 0; min-width: 0; height: 16px; background: var(--night); }
.pips i.filled { background: var(--herb); }

.rail { position: absolute; left: 1472px; top: 240px; width: 352px; height: 304px; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; overflow: hidden; }
.rail-item {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; padding: 16px 20px; box-sizing: border-box;
  border: 0; border-radius: 0; background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.rail-head { min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.rail-label {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--bone);
}
.rail-count { flex: 0 0 auto; font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--bone); }
.rail-item[data-kind="danger"] .pips i.filled, .rail-item[data-kind="countdown"] .pips i.filled { background: var(--heart); }
.rail-kind { font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--dust); }
</style>
