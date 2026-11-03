<script setup lang="ts">
import { computed } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import StageBadge from './StageBadge.vue';
import StageCaptions from './StageCaptions.vue';
import StageDice from './StageDice.vue';
import StageParty from './StageParty.vue';
import StagePictureCorner from './StagePictureCorner.vue';
import StageSlate from './StageSlate.vue';
import StageStakes from './StageStakes.vue';
import StageTracks from './StageTracks.vue';
import { slateKind } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null }>();

const slate = computed(() => slateKind(props.snapshot));
</script>

<template>
  <div class="overlay" data-layout="overlay">
    <StageParty :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
    <StagePictureCorner :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
    <StageBadge :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />

    <template v-if="!slate">
      <StageTracks :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
      <StageStakes :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
      <StageDice :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
      <StageCaptions :snapshot="snapshot" :connected="connected" :active-segment-id="activeSegmentId" />
    </template>
    <div v-else class="slate-spot">
      <StageSlate compact :kind="slate" :show-title="snapshot.session.title" :scene-title="snapshot.session.scene.title" :scene-description="snapshot.session.scene.description" />
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute; inset: 0; pointer-events: none; color: var(--bone);
  font-family: var(--font-body); font-weight: 400;
}
.overlay p { margin: 0; }

.slate-spot { position: absolute; left: 240px; top: 764px; width: 1440px; height: 256px; overflow: hidden; }
</style>
