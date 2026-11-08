<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { STRAIN_MAX, type SessionSnapshot } from '@rpg/contracts';
import { pictureUrl, portraitAlt, portraitIdFor } from './pictures';
import { initials } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const chips = computed(() => props.characterId
  ? props.snapshot.characters.filter(character => character.id === props.characterId)
  : props.snapshot.characters);

function flagText(character: { strain: number; condition?: 'down' | 'dead' }): string | null {
  if (character.condition === 'dead') return 'Dead';
  if (character.condition === 'down') return 'Down';
  return character.strain >= STRAIN_MAX ? 'Needs help' : null;
}

const failedImages = ref<Set<string>>(new Set());
function imageFailed(id: string) {
  failedImages.value = new Set(failedImages.value).add(id);
}
const shownImageKey = computed(() => props.snapshot.characters
  .map(character => portraitIdFor(props.snapshot, character.id))
  .filter((id): id is string => !!id)
  .join('|'));
// A failed picture is remembered only while it stays shown; a fresh show gets one new try.
watch(shownImageKey, key => {
  const shown = new Set(key ? key.split('|') : []);
  const kept = [...failedImages.value].filter(id => shown.has(id));
  if (kept.length !== failedImages.value.size) failedImages.value = new Set(kept);
});
const sessionScope = computed(() => ({ kind: 'session' as const, sessionId: props.snapshot.session.id }));
function chipPortrait(characterId: string): string | null {
  const id = portraitIdFor(props.snapshot, characterId);
  return id && !failedImages.value.has(id) ? pictureUrl(sessionScope.value, id) : null;
}
</script>

<template>
  <div v-if="chips.length" class="cast-chips" aria-label="Cast">
    <div v-for="character in chips" :key="character.id" class="chip" :data-condition="character.condition ?? 'up'">
      <img
        v-if="chipPortrait(character.id)" class="chip-portrait" :src="chipPortrait(character.id)!" :alt="portraitAlt(character.displayName)"
        @error="imageFailed(portraitIdFor(snapshot, character.id)!)"
      >
      <span v-else class="initials" aria-hidden="true">{{ initials(character.displayName) }}</span>
      <span class="chip-name">{{ character.displayName }}</span>
      <span class="strain" :aria-label="`Strain ${character.strain} of ${STRAIN_MAX}`"><i v-for="pip in STRAIN_MAX" :key="pip" :class="{ filled: pip <= character.strain }"></i></span>
      <span v-if="flagText(character)" class="chip-flag">{{ flagText(character) }}</span>
    </div>
  </div>
</template>

<style scoped>
.cast-chips { position: absolute; left: 96px; top: 60px; width: 1344px; height: 76px; display: flex; gap: 16px; overflow: hidden; pointer-events: none; }
.chip {
  display: grid; grid-template-columns: 60px auto auto; grid-template-rows: 40px 28px; justify-content: start; align-content: center;
  flex: 0 1 auto; min-width: 0; height: 76px; padding: 0 12px; box-sizing: border-box; overflow: hidden; white-space: nowrap;
  border: 0; border-radius: 0; background: var(--night); box-shadow: var(--canvas-frame-slot); clip-path: var(--cut-1);
}
.initials, .chip-portrait { grid-column: 1; grid-row: 1 / span 2; align-self: center; width: 60px; height: 60px; box-sizing: border-box; clip-path: var(--cut-1); }
.initials {
  display: grid; place-items: center; background: var(--night-raised); box-shadow: var(--canvas-frame-slot); color: var(--candle);
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px;
}
.chip-portrait { display: block; padding: 4px; object-fit: cover; background: var(--night-raised); box-shadow: var(--canvas-frame-slot); }
.chip-name {
  grid-column: 2 / -1; grid-row: 1; min-width: 0; margin-left: 12px; overflow: hidden; text-overflow: ellipsis;
  font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--candle);
}
.strain {
  display: flex; gap: 4px; padding: 4px; box-sizing: border-box; height: 24px; background: var(--night-raised);
  box-shadow: var(--canvas-frame-slot); clip-path: var(--cut-1);
  grid-column: 2; grid-row: 2; align-self: center; width: 100px; margin-left: 12px;
}
.strain i { display: block; flex: 1 1 0; min-width: 0; height: 16px; background: var(--night); }
.strain i.filled { background: var(--heart); }
.chip-flag {
  grid-column: 3; grid-row: 2; align-self: center; margin-left: 8px; height: 28px; padding: 0 8px; box-sizing: border-box;
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--void);
  background: var(--heart); clip-path: var(--cut-1);
}
</style>
