<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { PictureIdResponse, PortraitDetails } from '@rpg/contracts';
import { portraitAlt } from './pictures';
import { initials } from './stage-format';

const props = defineProps<{
  name: string;
  portraitId?: string | null;
  details: PortraitDetails;
  contextKey: string | number;
  disabled?: boolean;
  imageUrl: (id: string) => string;
  generate: (details: PortraitDetails) => Promise<PictureIdResponse>;
}>();
const emit = defineEmits<{ use: [imageId: string]; remove: [] }>();

const helpId = useId();
const FAILED_MESSAGE = 'The portrait could not be made. Press Try again.';
const CONTEXT_MESSAGE = 'Something on this page changed, so that portrait was set aside. Press Create portrait again.';
const NEEDS_LOOK = 'Write the Appearance first.';

const pending = ref(false);
const resultId = ref<string | null>(null);
const error = ref('');
const contextChanged = ref(false);
const failedImage = ref('');
const previewFailed = ref(false);
let generation = 0;
let disposed = false;

const hasSubject = computed(() => props.details.appearance.trim().length > 0 || props.details.role.trim().length > 0);
const canCreate = computed(() => !props.disabled && !pending.value && hasSubject.value);
const currentSrc = computed(() => (props.portraitId && failedImage.value !== props.portraitId ? props.imageUrl(props.portraitId) : null));
const previewSrc = computed(() => (resultId.value && !previewFailed.value ? props.imageUrl(resultId.value) : null));
const mark = computed(() => initials(props.name) || '?');
const mainLabel = computed(() => (pending.value ? 'Making the portrait...' : error.value ? 'Try again' : 'Create portrait'));

function invalidate() {
  generation++;
  pending.value = false; resultId.value = null; previewFailed.value = false; error.value = ''; contextChanged.value = false;
}
async function request() {
  if (!canCreate.value) return;
  const requestGeneration = ++generation;
  pending.value = true; resultId.value = null; previewFailed.value = false; error.value = ''; contextChanged.value = false;
  try {
    const response = await props.generate({ ...props.details });
    if (requestGeneration !== generation || disposed) return;
    resultId.value = response.imageId;
  } catch (cause) {
    if (requestGeneration !== generation || disposed) return;
    error.value = cause instanceof Error && cause.message ? cause.message : FAILED_MESSAGE;
  } finally {
    if (requestGeneration === generation && !disposed) pending.value = false;
  }
}
function useResult() {
  const id = resultId.value;
  if (!id || pending.value || props.disabled) return;
  invalidate();
  emit('use', id);
}
function cancel() { invalidate(); }
function remove() {
  if (props.disabled || pending.value) return;
  invalidate();
  emit('remove');
}

watch(() => props.contextKey, () => {
  const active = pending.value || resultId.value !== null;
  invalidate();
  if (active) contextChanged.value = true;
}, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; invalidate(); });
</script>

<template>
  <div class="portrait-generator" :aria-busy="pending">
    <div class="portrait-generator-current">
      <img v-if="currentSrc" class="portrait-generator-image" data-testid="portrait-current" :src="currentSrc" :alt="portraitAlt(name)" width="96" height="96" @error="failedImage = portraitId ?? ''">
      <span v-else class="portrait-generator-image portrait-generator-placeholder" data-testid="portrait-placeholder" aria-hidden="true">{{ mark }}</span>
      <div class="portrait-generator-actions">
        <button v-if="!resultId" type="button" data-testid="portrait-create" class="secondary" :disabled="!canCreate" :aria-describedby="hasSubject ? helpId : `${helpId} ${helpId}-needs`" @click="request">{{ mainLabel }}</button>
        <button v-if="portraitId" type="button" data-testid="portrait-remove" class="quiet" :disabled="disabled || pending" @click="remove">Remove portrait</button>
      </div>
    </div>
    <p :id="helpId" class="field-help">Press Create portrait to draw this character from the Appearance, Specialty and Pronouns boxes. The name and the secret never go to the picture service. The portrait goes on the card when you press Use this portrait, and it is saved with the rest of the card.</p>
    <p v-if="!hasSubject" :id="`${helpId}-needs`" class="field-help" data-testid="portrait-needs-look">{{ NEEDS_LOOK }}</p>
    <p v-if="contextChanged" class="notice" role="alert">{{ CONTEXT_MESSAGE }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div v-if="resultId" class="portrait-generator-result">
      <img v-if="previewSrc" class="portrait-generator-preview" data-testid="portrait-preview" :src="previewSrc" :alt="portraitAlt(name)" width="160" height="160" @error="previewFailed = true">
      <span v-else class="portrait-generator-preview portrait-generator-placeholder" aria-hidden="true">{{ mark }}</span>
      <div class="portrait-generator-actions">
        <button type="button" data-testid="portrait-use" :disabled="disabled || pending" @click="useResult">Use this portrait</button>
        <button type="button" data-testid="portrait-retry" class="secondary" :disabled="!canCreate" @click="request">Try again</button>
        <button type="button" data-testid="portrait-cancel" class="quiet" :disabled="disabled" @click="cancel">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.portrait-generator { margin-bottom: 1rem; }
.portrait-generator-current, .portrait-generator-result { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; }
.portrait-generator-result { margin-top: .6rem; padding: 1rem; border: 1px solid var(--line); border-left: 3px solid var(--teal); border-radius: 8px; background: var(--panel); max-width: 100%; box-sizing: border-box; }
.portrait-generator-image { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); flex: 0 0 auto; }
.portrait-generator-preview { width: 160px; height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); flex: 0 0 auto; }
.portrait-generator-placeholder { display: grid; place-items: center; box-sizing: border-box; background: #343c31; color: #e3c58e; font-family: Georgia, serif; font-size: 1.6rem; }
.portrait-generator-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
</style>
