<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from './api';

const FALLBACK = 'The AI could not help this time. Your words are unchanged.';
const props = defineProps<{ sessionId: string; idea: string; recipientNpcIds: string[]; canSend: boolean }>();
const emit = defineEmits<{ use: [text: string] }>();

const pending = ref(false);
const suggestion = ref<string | null>(null);
const failure = ref<string | null>(null);
let requestId = 0;

const canAsk = computed(() => props.idea.trim().length > 0 && props.canSend && !pending.value);

const ask = async () => {
  if (!canAsk.value) return;
  const mine = ++requestId;
  pending.value = true;
  failure.value = null;
  try {
    const reply = await api.lineAssist(props.sessionId, { idea: props.idea, recipientNpcIds: props.recipientNpcIds });
    if (mine !== requestId) return;
    suggestion.value = reply.text;
  } catch (error) {
    if (mine !== requestId) return;
    suggestion.value = null;
    const message = error instanceof Error ? error.message.trim() : '';
    failure.value = message || FALLBACK;
  } finally {
    if (mine === requestId) pending.value = false;
  }
};

const close = () => {
  requestId += 1;
  pending.value = false;
  suggestion.value = null;
  failure.value = null;
};

const use = () => {
  if (suggestion.value === null) return;
  const text = suggestion.value;
  close();
  emit('use', text);
};

watch(() => props.sessionId, close);
watch(() => props.idea, idea => { if (idea.trim() === '') close(); });
</script>

<template>
  <div class="line-assist" data-testid="line-assist">
    <button type="button" class="secondary line-assist-ask" :disabled="!canAsk" @click="ask">{{ pending ? 'Writing…' : 'Help me say it' }}</button>
    <section v-if="suggestion !== null" class="line-assist-window" data-testid="line-assist-suggestion" aria-label="Suggested line">
      <p class="line-assist-text">{{ suggestion }}</p>
      <div class="line-assist-actions">
        <button type="button" data-testid="line-assist-use" @click="use">Use this</button>
        <button type="button" class="secondary" data-testid="line-assist-retry" :disabled="!canAsk" @click="ask">Try again</button>
        <button type="button" class="quiet" data-testid="line-assist-keep" @click="close">Keep mine</button>
      </div>
    </section>
    <p v-if="failure" role="status" class="line-assist-failure" data-testid="line-assist-failure">{{ failure }}</p>
  </div>
</template>

<style scoped>
.line-assist { display: grid; gap: 12px; min-width: 0; justify-items: start; }
.line-assist-window { position: relative; isolation: isolate; width: 100%; box-sizing: border-box; padding: 16px; display: grid; gap: 12px; min-width: 0; }
.line-assist-window::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.line-assist-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--bone); }
.line-assist-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.line-assist-failure { margin: 0; color: var(--bone); overflow-wrap: anywhere; }
</style>
