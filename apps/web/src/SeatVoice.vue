<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Command, PlayerSnapshot, VoiceOption } from '@rpg/contracts';
import VoicePicker from './VoicePicker.vue';
import { loadVoices, voiceName } from './voices';

const props = defineProps<{ snapshot: PlayerSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command] }>();

const voices = ref<VoiceOption[]>([]);
const reason = ref<string | undefined>(undefined);
const loaded = ref(false);
const open = ref(false);
const details = ref<HTMLDetailsElement | null>(null);
let loading = false;

const own = computed(() => props.snapshot.ownCharacter);
const visible = computed(() => props.snapshot.session.status !== 'ended' && !!own.value);
const current = computed<string | null>(() => own.value?.voiceProfileId ?? null);
const chosenName = computed(() => (loaded.value ? voiceName(current.value, voices.value, 'The narrator') : ''));

const onToggle = async (event: Event) => {
  open.value = (event.target as HTMLDetailsElement).open;
  if (!open.value || loading) return;
  loading = true;
  try {
    const list = await loadVoices();
    voices.value = list.voices;
    reason.value = list.reason;
    loaded.value = true;
  } finally {
    loading = false;
  }
};

const choose = (voiceProfileId: string | null) => {
  emit('command', { type: 'set_voice', commandId: crypto.randomUUID(), voiceProfileId } as Command);
  if (details.value) details.value.open = false;
  open.value = false;
};
</script>

<template>
  <details v-if="visible" ref="details" class="seat-voice" data-testid="seat-voice" @toggle="onToggle">
    <summary>Your voice<span v-if="chosenName" class="seat-voice-name" data-testid="seat-voice-name"> · {{ chosenName }}</span></summary>
    <p class="muted">Your Say lines play in this voice. The narrator reads what you do.</p>
    <VoicePicker v-if="loaded && open" :model-value="current" :voices="voices" narrator-label="The narrator reads my lines" :disabled="busy" :reason="reason" @update:model-value="choose" />
  </details>
</template>

<style scoped>
.seat-voice-name { color: var(--candle); }
</style>
