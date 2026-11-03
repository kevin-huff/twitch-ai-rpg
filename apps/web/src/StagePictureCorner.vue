<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { pictureUrl, displayedPicture, shownScenePicture } from './pictures';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const failedImages = ref<Set<string>>(new Set());
function imageFailed(id: string) {
  failedImages.value = new Set(failedImages.value).add(id);
}
const shownImageKey = computed(() => {
  const ids = [props.snapshot.picturesEnabled === true ? props.snapshot.pinnedPicture?.imageId ?? null : null, shownScenePicture(props.snapshot)?.imageId ?? null];
  return ids.filter((id): id is string => !!id).join('|');
});
// A failed picture is remembered only while it stays shown; a fresh show gets one new try.
watch(shownImageKey, key => {
  const shown = new Set(key ? key.split('|') : []);
  const kept = [...failedImages.value].filter(id => shown.has(id));
  if (kept.length !== failedImages.value.size) failedImages.value = new Set(kept);
});
const sessionScope = computed(() => ({ kind: 'session' as const, sessionId: props.snapshot.session.id }));
const corner = computed(() => displayedPicture(props.snapshot, failedImages.value));
const cornerId = computed(() => corner.value?.imageId ?? null);
const cornerAlt = computed(() => corner.value?.pinned ? corner.value.label ?? props.snapshot.session.scene.title : props.snapshot.session.scene.title);
const cornerSrc = computed(() => cornerId.value ? pictureUrl(sessionScope.value, cornerId.value) : null);
</script>

<template>
  <img
    v-if="cornerSrc" class="scene-corner" :class="{ 'fit-whole': corner?.pinned && corner.kind === 'portrait' }" :src="cornerSrc" :alt="cornerAlt"
    @error="imageFailed(cornerId!)"
  >
</template>

<style scoped>
.scene-corner {
  position: absolute; left: 96px; top: 184px; width: 336px; height: 192px; padding: 12px; box-sizing: border-box; object-fit: cover;
  border: 0; border-radius: 0; background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
  pointer-events: none;
}

.scene-corner.fit-whole { object-fit: contain; background: var(--void); }
</style>
