<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Library, ScenarioDefinition, ScenarioDraftJob, ScenarioGenerationRequest, TemplateRef } from '@rpg/contracts';
import { api } from './api';
import { navigate } from './navigate';
import ErrorNotice from './ErrorNotice.vue';
import ScenarioGenerator from './ScenarioGenerator.vue';
import ShowForm from './ShowForm.vue';

type Chosen = { ref: TemplateRef; definition: ScenarioDefinition };
type Applied = { definition: ScenarioDefinition };

const library = ref<Library | null>(null);
const chosen = ref<Chosen | null>(null);
const savedKey = ref('');
const saving = ref(false);
const error = ref('');
const applyError = ref('');
const generator = ref<InstanceType<typeof ScenarioGenerator> | null>(null);

const key = (item: { id: string; version: number }) => `${item.id}:${item.version}`;
const scenarios = computed(() => library.value?.scenarios ?? []);
const cards = computed(() => library.value?.characters ?? []);

const start = (input: ScenarioGenerationRequest): Promise<ScenarioDraftJob> => { applyError.value = ''; return api.startScenarioDraft(input); };
const poll = (jobId: string): Promise<ScenarioDraftJob> => api.scenarioDraft(jobId);

onMounted(async () => {
  try { library.value = await api.library(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'The library could not be loaded.'; }
});

function chooseSaved(value: string) {
  savedKey.value = value;
  const found = scenarios.value.find(item => key(item) === value);
  chosen.value = found ? { ref: { templateId: found.id, version: found.version }, definition: found.definition } : null;
}

async function useStory(result: Applied) {
  if (saving.value) return;
  saving.value = true;
  applyError.value = '';
  try {
    const saved = await api.saveScenario({ expectedVersion: 0, definition: result.definition });
    if (library.value && !library.value.scenarios.some(item => key(item) === key(saved))) library.value.scenarios.push(saved);
    savedKey.value = key(saved);
    chosen.value = { ref: { templateId: saved.id, version: saved.version }, definition: saved.definition ?? result.definition };
    generator.value?.clearDraft();
  } catch (cause) {
    applyError.value = cause instanceof Error ? cause.message : 'The story could not be saved.';
  } finally {
    saving.value = false;
  }
}

function created(sessionId: string) { navigate(`/sessions/${encodeURIComponent(sessionId)}/lobby`); }
</script>

<template>
  <main class="shell">
    <h1>Make a show</h1>
    <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" />
    <section class="panel">
      <ScenarioGenerator ref="generator" variant="make" :boundaries="[]" premise="" :replaces-unsaved="false" :disabled="saving" :apply-error="applyError" :start="start" :poll="poll" @apply="useStory" @discard="applyError = ''" />
      <label>Use a saved story
        <select data-testid="make-saved-story" :value="savedKey" :disabled="saving" @change="chooseSaved(($event.target as HTMLSelectElement).value)">
          <option value="">Choose a saved story</option>
          <option v-for="item in scenarios" :key="key(item)" :value="key(item)">{{ item.definition.title }}</option>
        </select>
      </label>
    </section>
    <ShowForm v-if="chosen" :scenario="chosen" :cards="cards" @created="created" />
  </main>
</template>
