<script setup lang="ts">
import { computed } from 'vue';
import type { Roll, SessionSnapshot } from '@rpg/contracts';
import PixelDie from './PixelDie.vue';
import { FRAME_MS, flickerFaces, type MomentRoll } from './dice-moment';
import { diePose, restX, type Tray } from './dice-pose';
import { bandLabel, bandSymbol, lastChanceResult, rollBreakdown, slateKind, sortRolls, stageCards } from './stage-format';
import type { ActiveMoment } from './use-dice-moment';

// mode: 'center' when the overlay's center window plays the moment and this strip waits for the totals; 'strip' when this is the Dice piece.
const props = withDefaults(defineProps<{
  snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null;
  moment?: ActiveMoment | null; elapsed?: number; mode?: 'center' | 'strip';
}>(), { moment: null, elapsed: 0, mode: 'strip' });

const latest = computed(() => props.snapshot.history[props.snapshot.history.length - 1] ?? null);
const unknownCharacter = computed(() => !!props.characterId && !props.snapshot.characters.some(character => character.id === props.characterId));
const rolls = computed(() => {
  if (!latest.value || slateKind(props.snapshot) || unknownCharacter.value) return [];
  const sorted = sortRolls(latest.value.rolls, props.snapshot.characters);
  return props.characterId ? sorted.filter(roll => roll.actorCharacterId === props.characterId) : sorted;
});
const held = computed(() => stageCards(props.snapshot).length > 0);
const activeMoment = computed(() => (props.moment && latest.value && props.moment.beatId === latest.value.id ? props.moment : null));
const waiting = computed(() => !!activeMoment.value && props.mode === 'center' && props.elapsed < activeMoment.value.schedule.revealAt);

// The Dice piece plays the moment on its own cards: up to six rolls the dice drop into the empty band above
// the cards and land on each card's top edge; with two rows of cards they tumble inside the card.
const STRIP_DIE = 40;
const BAND_TRAY: Tray = { width: 200, height: 76, die: STRIP_DIE };
const INSIDE_TRAY: Tray = { width: 104, height: 68, die: STRIP_DIE };
const SHAKES: Partial<Record<MomentRoll['flourish'], number[]>> = { jolt: [4, -4, 4, -4, 0], crack: [8, -8, 8, -8, 4, -4, 0] };
const strip = computed(() => (props.mode === 'strip' ? activeMoment.value : null));
const entries = computed(() => new Map((strip.value?.schedule.rolls ?? []).map(entry => [entry.roll.id, entry])));
const inside = computed(() => rolls.value.length > 6);
const tileWidth = computed(() => (rolls.value.length > 5 ? 44 : rolls.value.length > 4 ? 52 : 68));
const dot = (value: number) => Math.round(value / 4) * 4;

function stripView(roll: Roll) {
  const entry = entries.value.get(roll.id);
  const moment = strip.value;
  if (!entry || !moment) return null;
  const t = props.elapsed;
  const since = (at: number) => Math.floor((t - at) / FRAME_MS);
  const stamped = t >= entry.verdictAt;
  const verdictFrame = stamped ? since(entry.verdictAt) : -1;
  const step = [...entry.steps].reverse().find(item => item.at <= t) ?? null;
  const bump = step ? (since(step.at) === 0 ? -8 : since(step.at) === 1 ? -4 : 0) : 0;
  const variant: 'plain' | 'crit' | 'dark' = stamped && entry.flourish === 'crack' ? 'crit' : stamped && entry.flourish === 'dark' ? 'dark' : 'plain';
  const tray = inside.value ? INSIDE_TRAY : BAND_TRAY;
  // On a crowded two-row strip the dice sit on the card's words, so they leave at the stamp; otherwise at the settle.
  const goneAt = inside.value ? entry.verdictAt : moment.schedule.settleAt;
  const goneFrame = t >= goneAt ? since(goneAt) : -1;
  const dice = goneFrame >= 0 ? [] : ([0, 1] as const).flatMap(slot => {
    const pose = diePose(entry.dice[slot], roll.faces[slot], flickerFaces(roll.id, slot, 24), tray, slot, t);
    return pose.visible ? [{ slot, pose, variant, style: { transform: `translate(${pose.x}px, ${pose.y}px)` } }] : [];
  });
  // Then they vanish in a two-frame puff where they rested.
  const floor = tray.height - STRIP_DIE;
  const dust = goneFrame >= 0 && goneFrame < 2
    ? ([0, 1] as const).flatMap(slot => {
      const x = restX(tray, slot);
      const out = goneFrame * 8;
      return [{ left: `${x - 8 - out}px`, top: `${floor + STRIP_DIE - 12 - out}px` }, { left: `${x + STRIP_DIE + out}px`, top: `${floor + STRIP_DIE - 12 - out}px` }];
    })
    : [];
  const shakes = SHAKES[entry.flourish];
  const shake = shakes && verdictFrame >= 0 && verdictFrame < shakes.length ? shakes[verdictFrame]! : 0;
  const sparkles = entry.flourish === 'sparkle' && verdictFrame >= 0 && verdictFrame < 5
    ? Array.from({ length: 8 }, (_, i) => {
      const angle = (i * Math.PI) / 4;
      const reach = 12 + 12 * verdictFrame + tileWidth.value / 2;
      return { left: `${dot(tileWidth.value / 2 - 10 + Math.cos(angle) * reach)}px`, top: `${dot(34 - 10 + Math.sin(angle) * reach)}px` };
    })
    : [];
  return {
    stamped,
    total: step ? String(step.value) : '',
    tileClass: { counted: !!step, flash: entry.flourish === 'flash' && verdictFrame >= 0 && verdictFrame < 2 },
    tileStyle: bump ? { transform: `translateY(${bump}px)` } : undefined,
    bandStyle: verdictFrame === 0 ? { transform: 'translateY(-16px)' } : verdictFrame === 1 ? { transform: 'translateY(-8px)' } : undefined,
    cardStyle: shake ? { transform: `translateX(${shake}px)` } : undefined,
    trayKind: inside.value ? 'inside' : 'band',
    dice,
    dust,
    sparkles,
  };
}
const cards = computed(() => rolls.value.map(roll => ({ roll, view: stripView(roll) })));

function resultWords(roll: Roll): string {
  return roll.lastChance ? lastChanceResult(roll.band) : bandLabel(roll.band);
}
function lastChanceMark(roll: Roll): string | undefined {
  return roll.lastChance ? (lastChanceResult(roll.band) === 'Dies' ? 'dies' : 'pulls-through') : undefined;
}

function nameOf(characterId: string): string {
  return props.snapshot.characters.find(character => character.id === characterId)?.displayName ?? 'Someone';
}
</script>

<template>
  <div v-if="rolls.length" class="dice" :class="{ 'dice-held': held, 'dice-dense': rolls.length > 4, 'dice-rows': rolls.length > 6, 'dice-waiting': waiting }">
    <div v-for="{ roll, view } in cards" :key="roll.id" class="roll" :data-band="view && !view.stamped ? undefined : roll.band" :data-last-chance="view && !view.stamped ? undefined : lastChanceMark(roll)" :style="view?.cardStyle">
      <span class="roll-total" :class="view?.tileClass" :style="view?.tileStyle" :data-dice-target="activeMoment ? roll.id : undefined">{{ view ? view.total : roll.total }}</span>
      <span class="roll-text">
        <span class="roll-head">
          <span class="roll-who">{{ nameOf(roll.actorCharacterId) }}</span>
          <span v-if="roll.lastChance" class="roll-last">Last chance</span>
          <span v-if="!view || view.stamped" class="roll-sum">{{ rollBreakdown(roll) }}</span>
        </span>
        <span v-if="!view || view.stamped" class="roll-band" :style="view?.bandStyle"><span class="roll-symbol">{{ bandSymbol(roll.band) }}</span> <span class="roll-result">{{ resultWords(roll) }}</span></span>
      </span>
      <span v-if="view" class="strip-tray" :class="view.trayKind" aria-hidden="true">
        <span v-for="die in view.dice" :key="die.slot" class="strip-die" :style="die.style">
          <PixelDie :face="die.pose.face" :sprite="die.pose.sprite" :size="40" :variant="die.variant" :squash="die.pose.squash" />
        </span>
        <span v-for="(speck, index) in view.dust" :key="`dust-${index}`" class="strip-dust" :style="speck"></span>
      </span>
      <span v-for="(spark, index) in view?.sparkles ?? []" :key="`spark-${index}`" class="strip-sparkle" :style="spark" aria-hidden="true"></span>
    </div>
  </div>
</template>

<style scoped>
.dice { position: absolute; left: 240px; top: 762px; width: 1440px; height: 68px; display: flex; justify-content: center; gap: 16px; }
.dice.dice-held { visibility: hidden; }
/* The overlay's center window plays the dice; the strip waits until the totals land in it. */
.dice.dice-waiting { visibility: hidden; }
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
.roll-last { flex: 0 0 auto; color: var(--bone); }
.roll-band { gap: 8px; color: var(--bone); }
.roll-symbol, .roll-result { flex: 0 0 auto; }
.roll[data-band="clean"] .roll-band { color: var(--herb); }
.roll[data-band="costly"] .roll-band { color: var(--candle); }
.roll[data-band="setback"] .roll-symbol { padding: 0 4px; color: var(--void); background: var(--heart); clip-path: var(--cut-1); }
.roll[data-band="critical"] .roll-total { box-shadow: inset 0 0 0 4px var(--void), inset 0 0 0 8px var(--heart), inset 0 -12px 0 0 var(--night); }
.roll[data-band="critical"] .roll-text { background: var(--heart); }
.roll[data-band="critical"] .roll-who, .roll[data-band="critical"] .roll-sum, .roll[data-band="critical"] .roll-band { color: var(--void); }
.roll[data-band="critical"] .roll-last { color: var(--void); }
.dice-dense { gap: 8px; }
.dice-dense .roll { gap: 4px; }
.dice-dense .roll-total { width: 52px; }
.dice-dense .roll-text { padding: 0 8px; }
.dice-dense .roll-sum, .dice-dense .roll-symbol { display: none; }
.roll:first-child:nth-last-child(n+6) .roll-total, .roll:first-child:nth-last-child(n+6) ~ .roll .roll-total { width: 44px; }
.roll:first-child:nth-last-child(n+6) .roll-text, .roll:first-child:nth-last-child(n+6) ~ .roll .roll-text { padding: 0; box-shadow: none; }
.roll:first-child:nth-last-child(n+6)[data-band="critical"] .roll-text, .roll:first-child:nth-last-child(n+6) ~ .roll[data-band="critical"] .roll-text { padding: 0 4px; }
/* The Dice piece's own dice moment: dice land on each card from the clear band above, or inside the card with two rows. */
.dice .roll { position: relative; }
.strip-tray { position: absolute; z-index: 1; overflow: hidden; pointer-events: none; }
.strip-tray.band { left: 0; top: -76px; width: 200px; height: 76px; }
.strip-tray.inside { right: 0; top: 0; width: 104px; height: 68px; }
.strip-die { position: absolute; left: 0; top: 0; display: block; }
.strip-dust { position: absolute; width: 8px; height: 8px; background: var(--dust); }
.strip-sparkle {
  position: absolute; z-index: 2; width: 20px; height: 20px; background: var(--herb); pointer-events: none;
  clip-path: polygon(8px 0, 12px 0, 12px 8px, 20px 8px, 20px 12px, 12px 12px, 12px 20px, 8px 20px, 8px 12px, 0 12px, 0 8px, 8px 8px);
}
.strip-sparkle:nth-child(3n) { background: var(--bone); }
.roll-total.flash { color: var(--void); background: var(--candle); }
/* Past six rolls the dice take a second row, growing up into the clear strip above. */
.dice-rows { top: 686px; height: 144px; flex-wrap: wrap; align-content: space-between; }
.dice-rows .roll { flex: 0 0 calc((100% - 40px) / 6); }
</style>
