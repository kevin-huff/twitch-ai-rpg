<script setup lang="ts">
import { computed } from 'vue';
import type { PublicActionContract, SessionSnapshot } from '@rpg/contracts';
import { bandLabel, bandSymbol, rollBreakdown, slateKind, sortRolls } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const latest = computed(() => props.snapshot.history[props.snapshot.history.length - 1] ?? null);
const unknownCharacter = computed(() => !!props.characterId && !props.snapshot.characters.some(character => character.id === props.characterId));
const rolls = computed(() => {
  if (!latest.value || slateKind(props.snapshot) || unknownCharacter.value) return [];
  const sorted = sortRolls(latest.value.rolls, props.snapshot.characters);
  return props.characterId ? sorted.filter(roll => roll.actorCharacterId === props.characterId) : sorted;
});
const held = computed(() => {
  if (props.snapshot.role === 'director') return false;
  const found = (props.snapshot.activeBeat as { stakes?: PublicActionContract[] } | null)?.stakes;
  return Array.isArray(found) && found.length > 0;
});

function nameOf(characterId: string): string {
  return props.snapshot.characters.find(character => character.id === characterId)?.displayName ?? 'Someone';
}
</script>

<template>
  <div v-if="rolls.length" class="dice" :class="{ 'dice-held': held, 'dice-dense': rolls.length > 4, 'dice-rows': rolls.length > 6 }">
    <div v-for="roll in rolls" :key="roll.id" class="roll" :data-band="roll.band">
      <span class="roll-total">{{ roll.total }}</span>
      <span class="roll-text">
        <span class="roll-head">
          <span class="roll-who">{{ nameOf(roll.actorCharacterId) }}</span>
          <span class="roll-sum">{{ rollBreakdown(roll) }}</span>
        </span>
        <span class="roll-band"><span class="roll-symbol">{{ bandSymbol(roll.band) }}</span> <span class="roll-result">{{ bandLabel(roll.band) }}</span></span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.dice { position: absolute; left: 240px; top: 762px; width: 1440px; height: 68px; display: flex; justify-content: center; gap: 16px; }
.dice.dice-held { visibility: hidden; }
.roll {
  display: flex; align-items: stretch; gap: 8px; flex: 1 1 0; height: 68px; min-width: 0; margin: 0; padding: 0;
  border: 0; border-radius: 0; background: none; box-shadow: none; clip-path: none; color: var(--bone);
}
.roll-total {
  display: grid; place-items: center; flex: 0 0 auto; width: 68px; margin: 0; padding: 0 0 8px; box-sizing: border-box;
  font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--bone);
  background: var(--night-raised); box-shadow: inset 0 0 0 4px var(--void), inset 0 -12px 0 0 var(--night); clip-path: var(--cut-2);
}
.roll-text {
  display: grid; align-content: center; flex: 1 1 0; min-width: 0; padding: 0 12px; box-sizing: border-box;
  font-family: var(--font-body); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--bone);
  background: var(--night); box-shadow: var(--canvas-frame-slot); clip-path: var(--cut-1);
}
.roll-text > span { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin: 0; white-space: nowrap; }
.roll-who { flex: 0 1 auto; min-width: 0; color: var(--candle); overflow: hidden; text-overflow: ellipsis; }
.roll-sum { flex: 0 100000 auto; min-width: 0; color: var(--dust); overflow: hidden; text-overflow: ellipsis; }
.roll-band { gap: 8px; color: var(--bone); }
.roll-symbol, .roll-result { flex: 0 0 auto; }
.roll[data-band="clean"] .roll-band { color: var(--herb); }
.roll[data-band="costly"] .roll-band { color: var(--candle); }
.roll[data-band="setback"] .roll-symbol { padding: 0 4px; color: var(--void); background: var(--heart); clip-path: var(--cut-1); }
.roll[data-band="critical"] .roll-total { box-shadow: inset 0 0 0 4px var(--void), inset 0 0 0 8px var(--heart), inset 0 -12px 0 0 var(--night); }
.roll[data-band="critical"] .roll-text { background: var(--heart); }
.roll[data-band="critical"] .roll-who, .roll[data-band="critical"] .roll-sum, .roll[data-band="critical"] .roll-band { color: var(--void); }
.dice-dense { gap: 8px; }
.dice-dense .roll { gap: 4px; }
.dice-dense .roll-total { width: 52px; }
.dice-dense .roll-text { padding: 0 8px; }
.dice-dense .roll-sum, .dice-dense .roll-symbol { display: none; }
.roll:first-child:nth-last-child(n+6) .roll-total, .roll:first-child:nth-last-child(n+6) ~ .roll .roll-total { width: 44px; }
.roll:first-child:nth-last-child(n+6) .roll-text, .roll:first-child:nth-last-child(n+6) ~ .roll .roll-text { padding: 0; box-shadow: none; }
.roll:first-child:nth-last-child(n+6)[data-band="critical"] .roll-text, .roll:first-child:nth-last-child(n+6) ~ .roll[data-band="critical"] .roll-text { padding: 0 4px; }
/* Past six rolls the dice take a second row, growing up into the clear strip above. */
.dice-rows { top: 686px; height: 144px; flex-wrap: wrap; align-content: space-between; }
.dice-rows .roll { flex: 0 0 calc((100% - 40px) / 6); }
</style>
