<script setup lang="ts">
import { computed, onBeforeUnmount, watch, ref } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { helperCredit, lastChanceCardText, slateKind, stageCards, traitName, wagerOutcomes } from './stage-format';
import type { StageCard } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const cards = computed<StageCard[]>(() => (slateKind(props.snapshot) ? [] : stageCards(props.snapshot, props.characterId)));

function nameOf(characterId: string): string {
  return props.snapshot.characters.find(character => character.id === characterId)?.displayName ?? 'Someone';
}

const SPOTLIGHT_MS = 8000;
const spotlight = ref(0);
const cardKey = computed(() => cards.value.map(card => card.id).join('|'));
const spot = computed(() => cards.value[spotlight.value] ?? cards.value[0] ?? null);
const spotStake = computed(() => (spot.value?.kind === 'stake' ? spot.value.stake : null));
let spotlightTimer: ReturnType<typeof setInterval> | null = null;
function stopSpotlight() {
  if (spotlightTimer !== null) clearInterval(spotlightTimer);
  spotlightTimer = null;
}
watch(cardKey, () => {
  spotlight.value = 0;
  stopSpotlight();
  if (cards.value.length < 2) return;
  spotlightTimer = setInterval(() => {
    spotlight.value = (spotlight.value + 1) % Math.max(1, cards.value.length);
  }, SPOTLIGHT_MS);
}, { immediate: true });
onBeforeUnmount(stopSpotlight);

const stakeDetail = computed(() => {
  const stake = spotStake.value;
  if (!stake) return '';
  const modifier = props.snapshot.characters.find(character => character.id === stake.actorCharacterId)?.traits[stake.trait] ?? 0;
  const parts = stake.ruling === 'check' ? [`${traitName(stake.trait)} +${modifier}`, `${stake.risk} risk`] : [];
  if (stake.helperCharacterIds.length) parts.push(helperCredit(stake, stake.helperCharacterIds.map(nameOf)));
  return parts.join(' · ');
});
</script>

<template>
  <div v-if="spot" class="wager" aria-label="What is at stake">
    <div v-if="spot.kind === 'last-chance'" :key="spot.id" class="wager-body" data-card="last-chance">
      <p class="wager-goal"><strong>{{ nameOf(spot.characterId) }}</strong> · Last chance</p>
      <p class="wager-last">{{ lastChanceCardText(nameOf(spot.characterId), spot.rolled) }}</p>
    </div>
    <div v-else-if="spotStake" :key="spot.id" class="wager-body">
      <p class="wager-goal"><strong>{{ nameOf(spotStake.actorCharacterId) }}</strong> · {{ spotStake.intent }}</p>
      <p v-if="stakeDetail" class="wager-detail">{{ stakeDetail }}</p>
      <div class="wager-outcomes">
        <p v-for="outcome in wagerOutcomes(spotStake)" :key="outcome.label"><span>{{ outcome.label }}</span><em>{{ outcome.text }}</em></p>
      </div>
    </div>
    <span v-if="cards.length > 1" class="wager-marker">{{ spotlight + 1 }} of {{ cards.length }}</span>
  </div>
</template>

<style scoped>
.wager {
  position: absolute; left: 480px; top: 140px; width: 960px; max-height: 612px; padding: 16px 24px; box-sizing: border-box; overflow: hidden;
  border: 0; border-radius: 0; background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.wager p { margin: 0; }
.wager-body { display: grid; gap: 4px; transform-origin: top; max-height: calc(612px - 32px); overflow: hidden; }
.wager-goal {
  font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--bone); overflow-wrap: anywhere;
}
.wager-goal::before { content: ''; float: right; width: 152px; height: 40px; }
.wager-goal strong { font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--candle); }
.wager-detail { font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--dust); overflow-wrap: anywhere; }
.wager-last { font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 40px; color: var(--bone); overflow-wrap: anywhere; }
.wager-outcomes { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: 4px; margin-top: 4px; }
.wager-outcomes p { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.wager-outcomes span {
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--candle); overflow-wrap: anywhere;
}
.wager-outcomes em {
  font-family: var(--font-body); font-size: 24px; font-weight: 400; line-height: 28px; font-style: normal; color: var(--bone);
  min-width: 0; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
}
.wager-marker {
  position: absolute; top: 16px; right: 24px; height: 40px; padding: 4px 16px 8px; box-sizing: border-box;
  font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; color: var(--bone); white-space: nowrap;
  background: var(--night-raised); box-shadow: var(--canvas-frame-chip); clip-path: var(--cut-1);
}
@media (prefers-reduced-motion: no-preference) {
  .wager-body { animation: wager-open 160ms steps(4) both; }
  @keyframes wager-open { from { transform: scaleY(0); } to { transform: scaleY(1); } }
}
</style>
