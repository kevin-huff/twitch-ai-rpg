<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import PixelDie from './PixelDie.vue';
import { CLOSE_AFTER_MS, FRAME_MS, flickerFaces, momentWindow, type MomentRoll } from './dice-moment';
import { diePose, type DiePose, type Tray } from './dice-pose';
import { traitName } from './stage-format';
import type { ActiveMoment } from './use-dice-moment';

const props = defineProps<{ moment: ActiveMoment; elapsed: number; snapshot: SessionSnapshot; layout: 'overlay' | 'scene' }>();

const CANVAS_WIDTH = 1920;
const PAD = 24;
const GAP = 16;
const FLIGHT_FRAMES = 6;
const SHAKES: Partial<Record<MomentRoll['flourish'], number[]>> = { jolt: [4, -4, 4, -4, 0], crack: [8, -8, 8, -8, 4, -4, 0] };

const dot = (value: number) => Math.round(value / 4) * 4;
const floorDot = (value: number) => Math.floor(value / 4) * 4;
const px = (value: number) => `${value}px`;

const schedule = computed(() => props.moment.schedule);
const frame = computed(() => momentWindow(props.layout));
const size = computed(() => schedule.value.size);

// Text, tile and spacing step down with the die so every cell keeps its name, dice, total and verdict whole.
// name and result are the heights of the name row and the result row (the tile, or a verdict on two lines).
const look = computed(() => {
  const die = size.value.die;
  if (die >= 112) return { kind: 'xl', tile: 96, gap: 12, name: 40, result: 96, chips: 'all' };
  if (die >= 80) return { kind: 'md', tile: 64, gap: 12, name: 40, result: 64, chips: 'all' };
  if (die >= 64) return { kind: 'sm', tile: 56, gap: 12, name: 28, result: 56, chips: 'latest' };
  return { kind: 'xs', tile: 48, gap: 4, name: 28, result: 56, chips: 'latest' };
});
// In the smaller cells the Last chance chip sits in the corner of the tray, so it never squeezes the name.
const lastInTray = computed(() => look.value.kind === 'sm' || look.value.kind === 'xs');
// The dice land on a one-dot floor line at the bottom of the tray.
const trayHeight = computed(() => dot(size.value.die * 1.75));
// Cells are as tall as their content, so rows line up and the grid sits centred in the window.
const cell = computed(() => {
  const { columns, rows } = size.value;
  const content = look.value.name + trayHeight.value + look.value.result + look.value.gap * 2;
  return {
    width: floorDot((frame.value.width - PAD * 2 - GAP * (columns - 1)) / columns),
    height: Math.min(content, floorDot((frame.value.height - PAD * 2 - GAP * (rows - 1)) / rows)),
  };
});
const tray = computed<Tray>(() => ({ width: cell.value.width, height: trayHeight.value - 4, die: size.value.die }));

const windowStyle = computed(() => ({ left: px(frame.value.left), top: px(frame.value.top), width: px(frame.value.width), height: px(frame.value.height) }));
const cellStyle = computed(() => ({ width: px(cell.value.width), height: px(cell.value.height), gap: px(look.value.gap) }));
const tileStyle = computed(() => ({ width: px(look.value.tile), height: px(look.value.tile) }));

const flickers = computed(() => new Map(schedule.value.rolls.map(entry => [entry.roll.id, [flickerFaces(entry.roll.id, 0, 24), flickerFaces(entry.roll.id, 1, 24)] as const])));
const since = (at: number) => Math.floor((props.elapsed - at) / FRAME_MS);
const bump = (at: number) => (since(at) === 0 ? -8 : since(at) === 1 ? -4 : 0);

function nameOf(characterId: string): string {
  return props.snapshot.characters.find(character => character.id === characterId)?.displayName ?? 'Someone';
}

const settleFrame = computed(() => (props.elapsed >= schedule.value.settleAt ? since(schedule.value.settleAt) : -1));
const closing = computed(() => props.elapsed >= schedule.value.settleAt + CLOSE_AFTER_MS);

type Box = { left: number; top: number; width: number; height: number };
const rootEl = ref<HTMLElement | null>(null);
const flights = shallowRef<Map<string, { from: Box; to: Box }> | null>(null);

// Where each cell's total is and where its card in the strip waits, in canvas pixels. Null when the page has no layout.
function measure(): Map<string, { from: Box; to: Box }> | null {
  const root = rootEl.value;
  if (!root) return null;
  const canvas = root.getBoundingClientRect();
  const scale = canvas.width / CANVAS_WIDTH;
  if (!scale) return null;
  const local = (el: Element | null | undefined): Box | null => {
    const rect = el?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return { left: (rect.left - canvas.left) / scale, top: (rect.top - canvas.top) / scale, width: rect.width / scale, height: rect.height / scale };
  };
  const targets = new Map<string, Element>();
  root.parentElement?.querySelectorAll('[data-dice-target]').forEach(el => targets.set(el.getAttribute('data-dice-target') ?? '', el));
  const found = new Map<string, { from: Box; to: Box }>();
  root.querySelectorAll<HTMLElement>('.moment-cell').forEach(cellEl => {
    const id = cellEl.dataset.rollId ?? '';
    const from = local(cellEl.querySelector('.cell-total'));
    const to = local(targets.get(id));
    if (from && to) found.set(id, { from, to });
  });
  return found.size ? found : null;
}
watch(() => settleFrame.value >= 0, settling => { if (settling && !flights.value) flights.value = measure(); });
onMounted(() => { if (settleFrame.value >= 0 && !flights.value) flights.value = measure(); });

function flyerBox(flight: { from: Box; to: Box }): Box {
  const step = Math.min(settleFrame.value, FLIGHT_FRAMES);
  if (step >= FLIGHT_FRAMES) return flight.to;
  const share = step / FLIGHT_FRAMES;
  const along = (from: number, to: number) => dot(from + (to - from) * share);
  return { left: along(flight.from.left, flight.to.left), top: along(flight.from.top, flight.to.top), width: along(flight.from.width, flight.to.width), height: along(flight.from.height, flight.to.height) };
}

function dieView(entry: MomentRoll, slot: 0 | 1, variant: 'plain' | 'crit' | 'dark') {
  const flicker = flickers.value.get(entry.roll.id)![slot];
  const pose: DiePose = diePose(entry.dice[slot], entry.roll.faces[slot], flicker, tray.value, slot, props.elapsed);
  const die = tray.value.die;
  const dust = pose.dust === null ? [] : pose.dust === 0
    ? [{ left: pose.x - 8, top: pose.y + die - 8 }, { left: pose.x + die, top: pose.y + die - 8 }]
    : [{ left: pose.x - 16, top: pose.y + die - 12 }, { left: pose.x + die + 8, top: pose.y + die - 12 }];
  return { slot, pose, variant, style: { transform: `translate(${pose.x}px, ${pose.y}px)` }, dust: dust.map(spot => ({ left: px(spot.left), top: px(spot.top) })) };
}

const cells = computed(() => schedule.value.rolls.map(entry => {
  const t = props.elapsed;
  const roll = entry.roll;
  const stamped = t >= entry.verdictAt;
  const verdictFrame = stamped ? since(entry.verdictAt) : -1;
  const variant = stamped && entry.flourish === 'crack' ? 'crit' : stamped && entry.flourish === 'dark' ? 'dark' : 'plain';
  const step = [...entry.steps].reverse().find(item => item.at <= t) ?? null;

  const chips: { kind: 'trait' | 'edge'; text: string; style: Record<string, string> }[] = [];
  if (!stamped) {
    for (const item of entry.steps) {
      if (!item.chip || item.at > t) continue;
      const text = item.chip === 'trait' ? `+${roll.traitModifier} ${traitName(roll.trait)}` : '+1 Edge';
      chips.push({ kind: item.chip, text, style: { transform: `translateY(${bump(item.at)}px)` } });
    }
    if (look.value.chips === 'latest') chips.splice(0, chips.length - 1);
  }

  const shakes = SHAKES[entry.flourish];
  const shake = shakes && verdictFrame >= 0 && verdictFrame < shakes.length ? shakes[verdictFrame]! : 0;
  const sparkles = entry.flourish === 'sparkle' && verdictFrame >= 0 && verdictFrame < 5
    ? Array.from({ length: 8 }, (_, i) => {
      const angle = (i * Math.PI) / 4;
      const reach = 16 + 16 * verdictFrame + look.value.tile / 2;
      const centre = look.value.tile / 2 - 10;
      return { left: px(dot(centre + Math.cos(angle) * reach)), top: px(dot(centre + Math.sin(angle) * reach)) };
    })
    : [];
  const band = roll.lastChance ? (entry.flourish === 'dark' ? 'dies' : 'pulls-through') : roll.band;

  const flight = flights.value?.get(roll.id) ?? null;
  const dropping = settleFrame.value >= 0 && !flight;
  const tileOffset = dropping ? dot(Math.min(settleFrame.value, FLIGHT_FRAMES) * 12) : step ? bump(step.at) : 0;

  return {
    id: roll.id,
    name: nameOf(roll.actorCharacterId),
    last: roll.lastChance === true,
    dice: [dieView(entry, 0, variant), dieView(entry, 1, variant)],
    total: step ? String(step.value) : '',
    tileClass: { flash: entry.flourish === 'flash' && verdictFrame >= 0 && verdictFrame < 2, dropping, flown: !!flight && settleFrame.value >= 0, counted: !!step },
    tileStyle: { ...tileStyle.value, transform: `translateY(${tileOffset}px)` },
    chips,
    verdict: stamped ? { text: entry.verdict, band, style: { transform: `translateY(${verdictFrame === 0 ? -16 : verdictFrame === 1 ? -8 : 0}px)` } } : null,
    cellStyle: { ...cellStyle.value, ...(shake ? { transform: `translateX(${shake}px)` } : {}) },
    sparkles,
    flyer: flight && settleFrame.value >= 0 ? { box: flyerBox(flight), total: String(roll.total), big: flight.to.height >= 88 } : null,
  };
}));
</script>

<template>
  <div ref="rootEl" class="dice-moment" :data-layout="layout" :data-size="look.kind" aria-hidden="true">
    <div class="moment-window" :class="{ closing }" :style="windowStyle">
      <div class="moment-cells">
        <div v-for="item in cells" :key="item.id" class="moment-cell" :data-roll-id="item.id" :style="item.cellStyle">
          <p class="cell-head">
            <span class="cell-name">{{ item.name }}</span>
            <span v-if="item.last && !lastInTray" class="cell-last">Last chance</span>
          </p>
          <div class="cell-tray" :style="{ height: `${trayHeight}px` }">
            <span v-if="item.last && lastInTray" class="cell-last in-tray">Last chance</span>
            <template v-for="die in item.dice" :key="die.slot">
              <span v-for="(speck, index) in die.dust" :key="`dust-${die.slot}-${index}`" class="cell-dust" :style="speck"></span>
              <span v-if="die.pose.visible" class="cell-die" :style="die.style">
                <PixelDie :face="die.pose.face" :sprite="die.pose.sprite" :size="tray.die" :variant="die.variant" :squash="die.pose.squash" />
              </span>
            </template>
          </div>
          <div class="cell-result">
            <span class="cell-tile">
              <span class="cell-total" :class="item.tileClass" :style="item.tileStyle">{{ item.total }}</span>
              <span v-for="(spark, index) in item.sparkles" :key="index" class="cell-sparkle" :style="spark"></span>
            </span>
            <span class="cell-words">
              <span v-for="chip in item.chips" :key="chip.kind" class="cell-chip" :data-chip="chip.kind" :style="chip.style">{{ chip.text }}</span>
              <span v-if="item.verdict" class="cell-verdict" :data-band="item.verdict.band" :style="item.verdict.style">{{ item.verdict.text }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
    <template v-for="item in cells" :key="`flyer-${item.id}`">
      <span
        v-if="item.flyer"
        class="moment-flyer"
        :class="{ big: item.flyer.big }"
        :data-roll-id="item.id"
        :style="{ left: `${item.flyer.box.left}px`, top: `${item.flyer.box.top}px`, width: `${item.flyer.box.width}px`, height: `${item.flyer.box.height}px` }"
      >{{ item.flyer.total }}</span>
    </template>
  </div>
</template>

<style scoped>
.dice-moment { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
.dice-moment p { margin: 0; }
.moment-window {
  position: absolute; box-sizing: border-box; padding: 24px; overflow: hidden;
  background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.moment-cells { display: flex; flex-wrap: wrap; justify-content: center; align-content: center; gap: 16px; width: 100%; height: 100%; }
.moment-cell { position: relative; display: flex; flex-direction: column; justify-content: flex-start; box-sizing: border-box; min-width: 0; }
.cell-head { display: flex; align-items: center; gap: 12px; min-width: 0; height: 40px; }
.cell-name {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-body); font-size: 40px; line-height: 40px; font-weight: 400; color: var(--candle);
}
.cell-last {
  flex: none; padding: 0 8px 4px; font-family: var(--font-label); font-size: 24px; line-height: 28px; font-weight: 400;
  text-transform: uppercase; color: var(--void); background: var(--heart); clip-path: var(--cut-1);
}
.cell-tray { position: relative; flex: none; overflow: hidden; box-shadow: inset 0 -4px 0 0 var(--night-raised); }
.cell-last.in-tray { position: absolute; top: 0; right: 0; padding: 0 8px 4px; font-family: var(--font-body); font-size: 24px; line-height: 28px; text-transform: none; }
.cell-die { position: absolute; left: 0; top: 0; z-index: 1; display: block; }
.cell-dust { position: absolute; width: 8px; height: 8px; background: var(--dust); }
.cell-result { position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; flex: none; }
.cell-tile { position: relative; flex: none; }
.cell-total {
  display: grid; place-items: center; box-sizing: border-box; padding-bottom: 8px;
  font-family: var(--font-body); font-size: 40px; line-height: 40px; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--bone);
  background: var(--night-raised); box-shadow: inset 0 0 0 4px var(--void), inset 0 -12px 0 0 var(--night); clip-path: var(--cut-2);
}
.cell-total:not(.counted) { color: transparent; }
.cell-total.flash { color: var(--void); background: var(--candle); box-shadow: inset 0 0 0 4px var(--void), inset 0 -12px 0 0 var(--candle-deep); }
.cell-total.flown { visibility: hidden; }
.cell-sparkle {
  position: absolute; z-index: 2; width: 20px; height: 20px; background: var(--herb);
  clip-path: polygon(8px 0, 12px 0, 12px 8px, 20px 8px, 20px 12px, 12px 12px, 12px 20px, 8px 20px, 8px 12px, 0 12px, 0 8px, 8px 8px);
}
.cell-sparkle:nth-child(3n) { background: var(--bone); }
.cell-sparkle:nth-child(3n + 1) { background: var(--candle); }
.cell-words { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.cell-chip {
  flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; padding: 4px 12px 12px; font-family: var(--font-label); font-size: 24px; line-height: 28px; font-weight: 400; white-space: nowrap;
  color: var(--bone); background: var(--night-raised); box-shadow: var(--canvas-frame-chip); clip-path: var(--cut-1);
}
.cell-verdict {
  min-width: 0; overflow-wrap: anywhere;
  font-family: var(--font-label); font-size: 32px; line-height: 40px; font-weight: 700; text-transform: uppercase; color: var(--bone);
}
.cell-verdict[data-band='clean'], .cell-verdict[data-band='pulls-through'] { color: var(--herb); }
.cell-verdict[data-band='costly'] { color: var(--candle); }
.cell-verdict[data-band='setback'], .cell-verdict[data-band='dies'], .cell-verdict[data-band='critical'] {
  padding: 0 8px 4px; color: var(--void); background: var(--heart); clip-path: var(--cut-1);
}
.moment-flyer {
  position: absolute; display: grid; place-items: center; box-sizing: border-box; padding-bottom: 8px;
  font-family: var(--font-body); font-size: 40px; line-height: 40px; font-weight: 400; color: var(--bone);
  background: var(--night-raised); box-shadow: inset 0 0 0 4px var(--void), inset 0 -12px 0 0 var(--night); clip-path: var(--cut-2);
}
.moment-flyer.big { font-size: 80px; line-height: 80px; }

/* Smaller cells: the total and the words step down so a twelve-roll grid keeps every verdict whole. */
.dice-moment[data-size='xl'] .cell-total { font-size: 80px; line-height: 80px; }
.dice-moment[data-size='md'] .cell-verdict { font-size: 24px; line-height: 28px; }
.dice-moment[data-size='sm'] .cell-head, .dice-moment[data-size='xs'] .cell-head { height: 28px; gap: 8px; }
.dice-moment[data-size='sm'] .cell-name, .dice-moment[data-size='xs'] .cell-name { font-size: 24px; line-height: 28px; }
.dice-moment[data-size='sm'] .cell-last, .dice-moment[data-size='xs'] .cell-last { padding: 0 4px; }
.dice-moment[data-size='sm'] .cell-verdict, .dice-moment[data-size='xs'] .cell-verdict { font-family: var(--font-body); font-size: 24px; line-height: 28px; font-weight: 400; text-transform: none; }
.dice-moment[data-size='sm'] .cell-chip, .dice-moment[data-size='xs'] .cell-chip { padding: 0 8px 8px; font-family: var(--font-body); }
.dice-moment[data-size='xs'] .cell-result { gap: 8px; }

@media (prefers-reduced-motion: no-preference) {
  .moment-window { transform-origin: 50% 100%; animation: moment-open 160ms steps(4, jump-start) both; }
  .moment-window.closing { transform-origin: 50% 0; animation: moment-close 160ms steps(4, jump-start) both; }
}
@keyframes moment-open { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes moment-close { from { transform: scaleY(1); } to { transform: scaleY(0); } }
</style>
