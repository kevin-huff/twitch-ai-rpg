<script setup lang="ts">
import { computed } from 'vue';
import type { PublicBeat, PublicCharacter } from '@rpg/contracts';
import { wagerOutcomes } from './stage-format';

const props = defineProps<{ beat: PublicBeat | null; characterId: string; characters: PublicCharacter[] }>();

const nameOf = (id: string) => props.characters.find(character => character.id === id)?.displayName ?? 'Someone';
const own = computed(() => props.beat?.stakes.filter(stake => stake.actorCharacterId === props.characterId) ?? []);
const helping = computed(() => props.beat?.stakes.filter(stake => stake.actorCharacterId !== props.characterId && stake.helperCharacterIds.includes(props.characterId)) ?? []);
const visible = computed(() => {
  const beat = props.beat;
  if (!beat || beat.stakesApproved !== true) return false;
  if (beat.phase !== 'stakes_review' && beat.phase !== 'locked' && beat.phase !== 'draft_review') return false;
  return own.value.length > 0 || helping.value.length > 0;
});
const showsDice = computed(() => own.value.some(stake => stake.ruling === 'check'));
</script>

<template>
  <section v-if="visible" class="panel seat-stakes" data-testid="seat-stakes">
    <p class="eyebrow">What is at stake for you</p>
    <div v-for="stake in own" :key="stake.id" class="seat-stake" data-testid="seat-stake">
      <p class="seat-stake-goal">{{ stake.intent }}</p>
      <dl class="seat-stake-rows">
        <div v-for="row in wagerOutcomes(stake)" :key="row.label" class="seat-stake-row"><dt>{{ row.label }}</dt><dd>{{ row.text }}</dd></div>
      </dl>
    </div>
    <p v-for="stake in helping" :key="stake.id" class="seat-stakes-helping" data-testid="seat-stakes-helping">You are helping {{ nameOf(stake.actorCharacterId) }} with this: {{ stake.intent }}</p>
    <p v-if="showsDice" class="seat-stakes-dice" data-testid="seat-stakes-dice">How the dice work: two dice plus your trait. 10 or more is a clean success, 7 to 9 a success with a cost, 6 or less a setback, and double 1s a critical failure.</p>
  </section>
</template>

<style scoped>
.seat-stakes { overflow-wrap: anywhere; }
.seat-stakes p, .seat-stakes dl, .seat-stakes dd { margin: 0; }
.seat-stake + .seat-stake, .seat-stake + .seat-stakes-helping, .seat-stakes-helping + .seat-stakes-helping { margin-top: 16px; }
.seat-stake-goal, .seat-stakes-helping { font-family: var(--font-body); font-size: 20px; line-height: 24px; color: var(--bone); margin-bottom: 8px; }
.seat-stake-row { margin-bottom: 8px; }
.seat-stake-row dt { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; color: var(--candle); }
.seat-stake-row dd { font-family: var(--font-body); font-size: 20px; line-height: 24px; color: var(--bone); }
.seat-stakes-dice { margin-top: 16px; font-family: var(--font-body); font-size: 20px; line-height: 24px; color: var(--dust); }
</style>
