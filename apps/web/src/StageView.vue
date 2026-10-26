<script setup lang="ts">
import { computed, ref } from 'vue';
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
      <p class="operator-note">Operator controls stay below the picture. For OBS, use a stream link from Cast &amp; lobby, Stage &amp; OBS links.</p>
      <p v-if="error" class="operator-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.stage-view { position: fixed; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.frame-slot { position: relative; flex: 1; min-height: 0; }
.frame-fill { position: absolute; inset: 0; }
.offline { width: 100%; height: 100%; }
.offline.scene { background: radial-gradient(ellipse at 18% 0%, #293329 0%, #121815 58%); }
.operator-bar { flex: none; max-height: 40vh; overflow: auto; display: grid; gap: 8px; padding: 12px 16px; background: var(--panel); border-top: 1px solid var(--line); }
.operator-bar p { margin: 0; }
.operator-note { color: var(--muted); }
.operator-error { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
