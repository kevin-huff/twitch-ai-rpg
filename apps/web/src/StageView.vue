<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from './api';
import { identityPath } from './identity';
import AudioPanel from './AudioPanel.vue';
import BroadcastAudio from './BroadcastAudio.vue';
import StageFrame from './StageFrame.vue';
import StageOverlay from './StageOverlay.vue';
import StageScene from './StageScene.vue';
import StageSlate from './StageSlate.vue';
import { parseStreamLocation } from './stream';
import { useTable } from './table';

const { snapshot, connected, sessionId, latestHistory, error } = useTable();
const requested = parseStreamLocation(window.location);
const layout = requested.layout;
const inObs = 'obsstudio' in window;
const checker = requested.checker || (layout === 'overlay' && !inObs);
const activeSegmentId = ref<string | null>(null);
const beatId = computed(() => latestHistory.value[0]?.id);
const canOperate = ref(false);
onMounted(async () => {
  if (inObs) return;
  try {
    const viewer = await api.me();
    canOperate.value = viewer.role === 'host' || viewer.role === 'producer';
  } catch { canOperate.value = false; }
});
</script>

<template>
  <div class="stage-view">
    <div class="frame-slot">
      <div class="frame-fill">
        <StageFrame :layout="layout" :checker="checker">
          <template v-if="snapshot">
            <StageOverlay v-if="layout === 'overlay'" :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
            <StageScene v-else :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
          </template>
          <div v-else class="offline" :class="layout">
            <StageSlate kind="offline" show-title="The Story Table" :compact="layout === 'overlay'" />
          </div>
        </StageFrame>
      </div>
    </div>
    <BroadcastAudio v-if="inObs" :session-id="sessionId" :beat-id="beatId" mode="present" @segment="activeSegmentId = $event" />
    <div v-else class="operator-bar">
      <AudioPanel :session-id="sessionId" :beat-id="beatId" :director="false" stage />
      <p class="preview-strip" data-testid="preview-strip">Preview only, not for OBS. For OBS, use a link from Stream this show. <a :href="identityPath(`/sessions/${sessionId}/lobby#stage-links`)">Stream this show</a></p>
      <a v-if="canOperate" class="back-to-director" data-testid="back-to-director" :href="identityPath(`/sessions/${sessionId}/director`)">Back to the director page</a>
      <p v-if="error" class="operator-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.stage-view { position: fixed; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.frame-slot { position: relative; flex: 1; min-height: 0; }
.frame-fill { position: absolute; inset: 0; }
.offline { width: 100%; height: 100%; }
.offline.scene { background: var(--void); }
.operator-bar {
  position: relative; z-index: 0;
  flex: none; max-height: 40vh; overflow: auto; display: grid; gap: 8px; padding: 12px 16px; background: var(--night);
  box-shadow: inset 0 2px 0 0 var(--void), inset 0 4px 0 0 var(--bone);
  font-family: var(--font-body); font-size: 20px; line-height: 24px; color: var(--bone);
}
.operator-bar p { margin: 0; font-size: 20px; line-height: 24px; }
.preview-strip { color: var(--dust); }
.operator-error { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--bone); padding-left: 12px; box-shadow: inset 4px 0 0 0 var(--heart); }
</style>
