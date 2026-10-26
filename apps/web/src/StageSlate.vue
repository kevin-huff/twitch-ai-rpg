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
.stage-slate { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; text-align: center; color: #f4efe2; }
.slate-panel { display: grid; gap: 24px; max-width: 1500px; padding: 24px; }
.slate-panel p { margin: 0; }
.slate-show { font-size: 44px; color: var(--muted, #b9b4a4); }
.slate-title { font-family: Georgia, 'Times New Roman', serif; font-size: 96px; line-height: 1.1; color: var(--gold, #ddba76); }
.slate-message { font-size: 44px; line-height: 1.3; }
.slate-description {
  display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.compact .slate-panel { background: rgba(14, 18, 16, 0.82); border-radius: 16px; padding: 32px 48px; gap: 16px; }
.compact .slate-show { font-size: 32px; }
.compact .slate-title { font-size: 56px; }
.compact .slate-message { font-size: 32px; }
</style>
