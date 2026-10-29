<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DirectorSnapshot, PictureSettings as PictureSettingsValue } from '@rpg/contracts';
import { pictureUrl } from './pictures';
import PictureSettings from './PictureSettings.vue';

const props = withDefaults(defineProps<{ snapshot: DirectorSnapshot; busy: boolean; toggling?: boolean }>(), { toggling: false });
defineEmits<{ 'new-picture': []; 'draw-beat': []; 'save-settings': [PictureSettingsValue]; hide: []; show: [] }>();

const FAILED_DEFAULT = 'The picture could not be made. Press Draw the place to try again.';
const FAILED_ENDED = 'The picture could not be made.';
const HIDDEN_SUFFIX = ' The scene stays hidden until you press Show picture.';
const MAKING_HIDDEN_SUFFIX = ' It stays hidden until you press Show picture.';
const NO_BEAT = 'No beat has been published in this scene yet.';

const enabled = computed(() => props.snapshot.picturesEnabled === true);
const status = computed(() => props.snapshot.scenePictureStatus ?? null);
const state = computed(() => status.value?.state ?? 'none');
const making = computed(() => state.value === 'making');
const hidden = computed(() => status.value?.hidden === true);
const imageId = computed(() => status.value?.imageId ?? null);
const hasPicture = computed(() => imageId.value !== null);
const live = computed(() => ['live', 'paused'].includes(props.snapshot.session.status));
const started = computed(() => !props.snapshot.setup || props.snapshot.setup.started);
const notStarted = computed(() => props.snapshot.session.status === 'lobby' || (props.snapshot.setup ? !props.snapshot.setup.started : false));

const broken = ref<string | null>(null);
watch(imageId, () => { broken.value = null; });
const previewSrc = computed(() => (imageId.value && broken.value !== imageId.value ? pictureUrl({ kind: 'session', sessionId: props.snapshot.session.id }, imageId.value) : null));

const action = computed(() => (enabled.value ? props.snapshot.actionPicture ?? null : null));
const actionBroken = ref<string | null>(null);
watch(() => action.value?.imageId ?? null, () => { actionBroken.value = null; });
const actionSrc = computed(() => {
  const id = action.value?.state === 'ready' ? action.value.imageId : null;
  return id && actionBroken.value !== id ? pictureUrl({ kind: 'session', sessionId: props.snapshot.session.id }, id) : null;
});
const actionDrawn = computed(() => action.value?.state === 'making' || action.value?.state === 'ready');
const actionLine = computed(() => {
  if (!action.value) return '';
  if (action.value.state === 'failed') return action.value.message || 'The picture for this action round could not be made. You can still publish the round, and the stream keeps the picture it has now.';
  if (action.value.state === 'ready') {
    return hidden.value
      ? 'The picture for this action round is ready. It stays hidden until you press Show picture.'
      : 'The picture for this action round is ready. Viewers and players see it when you publish the round.';
  }
  return hidden.value
    ? 'Making the picture for this action round. It stays hidden until you press Show picture.'
    : 'Making the picture for this action round. Viewers and players see it when you publish the round.';
});

const line = computed(() => {
  if (!enabled.value) return 'Pictures are off on this server.';
  if (state.value === 'none' && props.snapshot.session.status === 'ended') return 'This scene has no picture.';
  if (state.value === 'none') return notStarted.value ? 'The picture is made when the show starts. Press Draw the place to make it now.' : 'This scene has no picture yet. Press Draw the place to make one.';
  if (state.value === 'making') {
    const base = status.value?.drawing === 'beat' ? 'Drawing the last beat…' : 'Making the picture...';
    return hidden.value ? base + MAKING_HIDDEN_SUFFIX : base;
  }
  if (state.value === 'failed') {
    const base = props.snapshot.session.status === 'ended' ? FAILED_ENDED : (status.value?.message || FAILED_DEFAULT);
    return hidden.value ? base + HIDDEN_SUFFIX : base;
  }
  return hidden.value
    ? 'This picture is hidden. Viewers and players do not see it. Press Show picture to put it back.'
    : 'This picture is on the stream and the player seats.';
});
const canMake = computed(() => !props.busy && props.snapshot.session.status !== 'ended');
const canDrawBeat = computed(() => canMake.value && live.value && started.value && hasBeat.value);
const hasBeat = computed(() => (props.snapshot.lastSceneBeatId ?? null) !== null);
const noBeatReason = computed(() => live.value && started.value && !hasBeat.value);
const settingsDisabled = computed(() => props.busy || props.snapshot.session.status === 'ended');
</script>

<template>
  <section class="panel scene-picture-panel" data-testid="scene-picture-panel">
    <p class="eyebrow">Scene picture</p>
    <img v-if="enabled && previewSrc" class="scene-picture-preview" :src="previewSrc" :alt="snapshot.session.scene.title" @error="broken = imageId" />
    <p role="status" class="scene-picture-status" data-testid="scene-picture-status">{{ line }}</p>
    <div v-if="action" class="action-picture" data-testid="action-picture">
      <img v-if="actionSrc" class="action-picture-preview" data-testid="action-picture-preview" :src="actionSrc" alt="Picture for this action round" @error="actionBroken = action?.imageId ?? null" />
      <p role="status" class="action-picture-status" data-testid="action-picture-status">{{ actionLine }}</p>
    </div>
    <template v-if="enabled">
      <div class="actions">
        <button class="secondary" type="button" data-testid="scene-picture-new" :disabled="!canMake" @click="$emit('new-picture')">Draw the place</button>
        <button class="secondary" type="button" data-testid="scene-picture-beat" :disabled="!canDrawBeat" @click="$emit('draw-beat')">Draw the last beat</button>
        <button v-if="!hidden && (making || hasPicture || actionDrawn)" class="quiet" type="button" data-testid="scene-picture-hide" :disabled="toggling" @click="$emit('hide')">Hide picture</button>
        <button v-if="hidden" class="quiet" type="button" data-testid="scene-picture-show" :disabled="toggling" @click="$emit('show')">Show picture</button>
      </div>
      <p v-if="noBeatReason" class="muted scene-picture-reason" data-testid="scene-picture-beat-reason">{{ NO_BEAT }}</p>
      <p class="muted scene-picture-help">Draw the place makes a new picture of this scene's place. Draw the last beat draws the newest beat in this scene, with everyone who took part. Pictures already on their way keep going. The newest picture takes the old one's place when it is ready.</p>
      <PictureSettings :settings="snapshot.pictureSettings ?? null" :premise="snapshot.session.brief?.premise" :premise-label="`Show scenario: ${snapshot.session.title}`" :disabled="settingsDisabled" @save="$emit('save-settings', $event)" />
    </template>
  </section>
</template>

<style scoped>
.scene-picture-preview { display: block; box-sizing: border-box; width: 100%; padding: 2px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); aspect-ratio: 1344 / 768; object-fit: cover; margin-bottom: 16px; }
.scene-picture-status { margin: 0 0 16px; font-size: 20px; line-height: 24px; overflow-wrap: anywhere; }
.action-picture { margin: 0 0 16px; }
.action-picture-preview { display: block; box-sizing: border-box; max-width: 240px; width: 100%; padding: 2px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); aspect-ratio: 1344 / 768; object-fit: cover; margin-bottom: 8px; }
.action-picture-status { margin: 0; font-size: 20px; line-height: 24px; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.scene-picture-reason { font-size: 20px; line-height: 24px; margin: 8px 0 0; }
.scene-picture-help { font-size: 20px; line-height: 24px; margin: 16px 0 0; }
</style>
