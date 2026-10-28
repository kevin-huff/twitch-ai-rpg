<script lang="ts">
import { ref } from 'vue';

// One sample plays at a time across every picker on the page. The element is made when Play is first pressed.
const playingId = ref<string | null>(null);
let audio: HTMLAudioElement | null = null;

const stopSample = () => {
  playingId.value = null;
  if (audio) audio.pause();
};

const startSample = (id: string, url: string) => {
  stopSample();
  if (!audio) {
    audio = new Audio();
    audio.preload = 'none';
    audio.addEventListener('ended', stopSample);
    audio.addEventListener('error', stopSample);
  }
  audio.src = url;
  playingId.value = id;
  try {
    const started = audio.play();
    if (started && typeof started.catch === 'function') {
      started.catch(() => {
        if (playingId.value === id) playingId.value = null;
      });
    }
  } catch {
    if (playingId.value === id) playingId.value = null;
  }
};
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import type { VoiceOption } from '@rpg/contracts';

const props = defineProps<{
  modelValue: string | null;
  voices: VoiceOption[];
  narratorLabel: string;
  disabled?: boolean;
  reason?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const narratorChosen = computed(() => props.modelValue === null || !props.modelValue.startsWith('eleven:'));

const toggleSample = (voice: VoiceOption) => {
  if (!voice.previewUrl) return;
  if (playingId.value === voice.id) stopSample();
  else startSample(voice.id, voice.previewUrl);
};

onBeforeUnmount(() => {
  if (playingId.value !== null && props.voices.some(voice => voice.id === playingId.value)) stopSample();
});
</script>

<template>
  <div class="voice-picker" data-testid="voice-picker">
    <p v-if="reason" class="muted voice-reason" data-testid="voice-reason">{{ reason }}</p>
    <div class="voice-scroll" role="group" aria-label="Voices" tabindex="0" data-testid="voice-list">
    <ul class="voice-list">
      <li class="voice-row" data-testid="voice-narrator">
        <button type="button" class="secondary voice-choose" :aria-pressed="narratorChosen ? 'true' : 'false'" :disabled="disabled" @click="emit('update:modelValue', null)">
          <span class="voice-name">{{ narratorLabel }}</span>
          <span v-if="narratorChosen" class="voice-chosen">Chosen</span>
        </button>
      </li>
      <li v-for="voice in voices" :key="voice.id" class="voice-row" data-testid="voice-option">
        <button type="button" class="secondary voice-choose" :aria-pressed="modelValue === voice.id ? 'true' : 'false'" :disabled="disabled" @click="emit('update:modelValue', voice.id)">
          <span class="voice-name">{{ voice.name }}</span>
          <span v-if="voice.summary" class="voice-summary">{{ voice.summary }}</span>
          <span v-if="voice.tuned || modelValue === voice.id" class="voice-marks">
            <span v-if="voice.tuned" class="voice-tuned">Tuned for v4</span>
            <span v-if="modelValue === voice.id" class="voice-chosen">Chosen</span>
          </span>
        </button>
        <button v-if="voice.previewUrl" type="button" class="quiet voice-sample" :aria-label="`${playingId === voice.id ? 'Stop sample' : 'Play sample'}: ${voice.name}`" @click="toggleSample(voice)">{{ playingId === voice.id ? 'Stop sample' : 'Play sample' }}</button>
      </li>
    </ul>
    </div>
  </div>
</template>

<style scoped>
.voice-picker { display: grid; gap: 12px; min-width: 0; }
.voice-reason { margin: 0; overflow-wrap: anywhere; }
.voice-scroll { max-height: 480px; overflow-y: auto; overscroll-behavior: contain; padding: 8px; background: var(--night); box-shadow: var(--frame-slot); min-width: 0; }
.voice-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.voice-row { display: flex; align-items: stretch; flex-wrap: wrap; gap: 8px; min-width: 0; }
.voice-choose { flex: 1 1 200px; min-width: 0; flex-direction: column; align-items: flex-start; justify-content: flex-start; text-align: left; gap: 4px; }
.voice-choose[aria-pressed='true']::before { box-shadow: var(--frame-good); }
.voice-sample { flex: 0 0 auto; align-self: center; }
.voice-name, .voice-summary { display: block; max-width: 100%; overflow-wrap: anywhere; }
.voice-name { color: var(--bone); }
.voice-summary { color: var(--dust); }
.voice-marks { display: flex; flex-wrap: wrap; gap: 8px; }
.voice-tuned, .voice-chosen { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; }
.voice-tuned { color: var(--mana); }
.voice-chosen { color: var(--herb); }
</style>
