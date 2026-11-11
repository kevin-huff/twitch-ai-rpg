<script lang="ts">
export type NarrationState = { status: 'idle' | 'playing' | 'paused' | 'stopped' | 'complete'; beatId: string | null; audioHere: boolean; pending: boolean; error?: string };
export type NarrationControl = 'pause' | 'resume' | 'stop';
</script>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ state: NarrationState | null; beatNumber: number | null }>();
const emit = defineEmits<{ control: [type: NarrationControl] }>();

const sentence = computed(() => {
  const current = props.state;
  if (!current) return '';
  const where = props.beatNumber === null ? '' : `: beat ${props.beatNumber}`;
  const playing = `Narration playing${where}.`;
  const paused = `Narration paused${where}.`;
  if (!current.audioHere) {
    const none = 'No page is playing the show audio.';
    if (current.status === 'playing') return `${none} ${playing}`;
    if (current.status === 'paused') return `${none} ${paused}`;
    return none;
  }
  if (current.status === 'playing') return playing;
  if (current.status === 'paused') return paused;
  if (current.status === 'complete') return `Narration finished${where}.`;
  if (current.status === 'stopped') return `Narration stopped${where}.`;
  return 'No narration is playing.';
});
</script>

<template>
  <div v-if="state" class="actions narration-line" data-testid="narration-line">
    <p class="narration-line-text" data-testid="narration-line-text" aria-live="polite">{{ sentence }}</p>
    <button v-if="state.status === 'playing'" type="button" class="secondary" data-testid="narration-pause" :disabled="state.pending" @click="emit('control', 'pause')">Pause narration</button>
    <button v-if="state.status === 'paused'" type="button" class="secondary" data-testid="narration-resume" :disabled="state.pending || !state.audioHere" @click="emit('control', 'resume')">Resume narration</button>
    <button v-if="state.status === 'playing' || state.status === 'paused'" type="button" class="secondary" data-testid="narration-stop" :disabled="state.pending" @click="emit('control', 'stop')">Stop narration</button>
    <p v-if="state.error" class="narration-line-error" role="alert" data-testid="narration-line-error">{{ state.error }}</p>
  </div>
</template>

<style scoped>
.narration-line { flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; }
.narration-line-text { margin: 0; flex: 1 1 240px; min-width: 0; }
.narration-line-error { margin: 0; flex: 1 1 100%; min-width: 0; padding-left: 12px; border-left: 4px solid var(--heart); overflow-wrap: anywhere; }
</style>
