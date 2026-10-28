<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  kind: 'lobby' | 'paused' | 'ended' | 'waiting' | 'offline';
  showTitle: string;
  sceneTitle?: string;
  sceneDescription?: string;
  compact?: boolean;
}>();

const headline = computed(() => {
  switch (props.kind) {
    case 'lobby': return 'Starting soon';
    case 'paused': return 'We’ll be right back';
    case 'ended': return 'Thanks for watching';
    case 'offline': return 'The story continues shortly';
    default: return props.sceneTitle || props.showTitle;
  }
});
const showsScene = computed(() => props.kind === 'paused' && !!props.sceneTitle);
</script>

<template>
  <div class="stage-slate" :class="[`slate-${kind}`, { compact }]" :data-kind="kind">
    <div class="slate-panel">
      <p v-if="kind !== 'waiting'" class="slate-show">{{ showTitle }}</p>
      <p class="slate-title">{{ headline }}</p>
      <p v-if="showsScene" class="slate-message">{{ sceneTitle }}</p>
      <p v-if="kind === 'waiting' && sceneDescription" class="slate-message slate-description">{{ sceneDescription }}</p>
    </div>
  </div>
</template>

<style scoped>
.stage-slate { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; text-align: center; font-family: var(--font-body); font-size: 40px; line-height: 48px; color: var(--bone); text-transform: none; }
.slate-panel {
  display: grid; gap: 8px; width: 100%; padding: 32px 48px; background: var(--night);
  box-shadow: inset 0 4px 0 0 var(--void), inset 0 8px 0 0 var(--bone), inset 0 12px 0 0 var(--void),
    inset 0 -4px 0 0 var(--void), inset 0 -8px 0 0 var(--bone), inset 0 -12px 0 0 var(--void);
}
.stage-slate .slate-panel p { margin: 0; font-weight: 400; letter-spacing: 0; }
.stage-slate .slate-show { font-family: var(--font-label); font-size: 24px; line-height: 32px; text-transform: uppercase; color: var(--candle); }
.stage-slate .slate-title { font-family: var(--font-display); font-size: 96px; line-height: 104px; color: var(--bone); text-shadow: 4px 4px 0 var(--void); }
.stage-slate .slate-message { font-family: var(--font-body); font-size: 40px; line-height: 48px; color: var(--bone); }
.stage-slate .slate-description {
  display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.stage-slate.compact .slate-panel { padding: 16px 48px; gap: 4px; }
.stage-slate.compact .slate-title { font-size: 48px; line-height: 56px; }
.stage-slate.compact .slate-description { line-height: 40px; }
</style>
