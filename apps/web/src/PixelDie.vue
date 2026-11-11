<script setup lang="ts">
import { computed } from 'vue';
import { PIPS, pipGrid, type Sprite } from './dice-pose';

const props = withDefaults(defineProps<{ face: number; sprite: Sprite; size: number; variant?: 'plain' | 'crit' | 'dark'; squash?: boolean }>(), { variant: 'plain', squash: false });

const dot = (value: number) => Math.round(value / 4) * 4;
const px = (value: number) => `${value}px`;
const box = (left: number, top: number, width: number, height: number) => ({ left: px(left), top: px(top), width: px(width), height: px(height) });

const grid = computed(() => pipGrid(props.size));
const cells = computed(() => PIPS[props.face] ?? PIPS[1]!);

// On a landing frame the body is one dot wider on each side and two dots shorter, still standing on the floor.
const body = computed(() => (props.squash ? { left: -4, top: 8, width: props.size + 8, height: props.size - 8 } : { left: 0, top: 0, width: props.size, height: props.size }));
const facePips = computed(() => {
  const { pip, columns } = grid.value;
  const rows = props.squash ? [columns[0], (props.size - 8 - pip) / 2, props.size - 8 - columns[0] - pip] : columns;
  const shift = props.squash ? 4 : 0;
  return cells.value.map(cell => ({ cell, style: box(columns[cell % 3]! + shift, rows[Math.floor(cell / 3)]!, pip, pip) }));
});

// A crack down a critical die: a jagged run of one-dot blocks, right of the centre so a single pip stays whole.
const crack = computed(() => {
  const slice = dot(props.size / 5);
  return [0.74, 0.66, 0.78, 0.68, 0.76].map((share, i) => box(dot(props.size * share), i * slice, 4, slice + 4));
});

// Edge-on frames: the face turned partly away (narrower pips) beside a darker side face.
const front = computed(() => dot(props.size * 0.625));
const frontPips = computed(() => {
  const { pip, columns } = grid.value;
  const share = front.value / props.size;
  const offset = props.sprite === 'edge2' ? props.size - front.value : 0;
  return cells.value.map(cell => ({ cell, style: box(offset + dot(columns[cell % 3]! * share), columns[Math.floor(cell / 3)]!, Math.max(4, dot(pip * share)), pip) }));
});
const sidePips = computed(() => {
  const { pip, columns } = grid.value;
  const side = props.size - front.value;
  const offset = props.sprite === 'edge2' ? 0 : front.value;
  const inset = Math.max(4, dot(side / 4));
  return [box(offset + inset, columns[0], 4, pip), box(offset + side - inset - 4, columns[2], 4, pip)];
});
const frontBody = computed(() => (props.sprite === 'edge2' ? box(props.size - front.value, 0, front.value, props.size) : box(0, 0, front.value, props.size)));
const sideBody = computed(() => (props.sprite === 'edge2' ? box(0, 0, props.size - front.value, props.size) : box(front.value, 0, props.size - front.value, props.size)));

// A die standing on its corner: a diamond with one-dot steps, drawn as a void ring around the face color.
function diamond(size: number, inset: number): string {
  const n = size / 4 - inset * 2;
  const half = n / 2;
  const off = inset * 4;
  const reach = (row: number) => (row < half ? row + 1 : n - row);
  const points: string[] = [];
  for (let row = 0; row < n; row++) {
    const x = (half + reach(row)) * 4 + off;
    points.push(`${x}px ${row * 4 + off}px`, `${x}px ${(row + 1) * 4 + off}px`);
  }
  for (let row = n - 1; row >= 0; row--) {
    const x = (half - reach(row)) * 4 + off;
    points.push(`${x}px ${(row + 1) * 4 + off}px`, `${x}px ${row * 4 + off}px`);
  }
  return `polygon(${points.join(', ')})`;
}
const outerShape = computed(() => ({ '--die-shape': diamond(props.size, 0) }));
const innerShape = computed(() => ({ '--die-shape': diamond(props.size, 1) }));
const centerPip = computed(() => {
  const { pip } = grid.value;
  return box((props.size - pip) / 2, (props.size - pip) / 2, pip, pip);
});
</script>

<template>
  <span class="pixel-die" :class="{ squash }" :data-face="face" :data-sprite="sprite" :data-variant="variant" :style="{ width: px(size), height: px(size) }" aria-hidden="true">
    <span v-if="sprite === 'face'" class="die-body" :style="box(body.left, body.top, body.width, body.height)">
      <span v-for="pip in facePips" :key="pip.cell" class="pip" :style="pip.style"></span>
      <template v-if="variant === 'crit'"><span v-for="(block, index) in crack" :key="index" class="die-crack" :style="block"></span></template>
    </span>
    <template v-else-if="sprite === 'corner'">
      <span class="die-diamond die-diamond-ring" :style="outerShape"></span>
      <span class="die-diamond die-diamond-body" :style="innerShape"></span>
      <span class="pip" :style="centerPip"></span>
    </template>
    <template v-else>
      <span class="die-front" :style="frontBody"></span>
      <span class="die-side" :style="sideBody"></span>
      <span v-for="pip in frontPips" :key="pip.cell" class="pip" :style="pip.style"></span>
      <span v-for="(pip, index) in sidePips" :key="`side-${index}`" class="pip pip-side" :style="pip"></span>
    </template>
  </span>
</template>

<style scoped>
.pixel-die { --die-face: var(--bone); --die-pip: var(--void); --die-ring: var(--void); --die-band: var(--dust); --die-side: var(--dust); position: relative; display: block; flex: none; }
.pixel-die[data-variant='crit'] { --die-face: var(--heart); --die-band: var(--void); --die-side: var(--void); }
.pixel-die[data-variant='dark'] { --die-face: var(--void); --die-pip: var(--night-raised); --die-ring: var(--night-raised); --die-band: var(--night); --die-side: var(--night); }
.die-body, .die-front, .die-side, .die-diamond, .pip, .die-crack { position: absolute; display: block; box-sizing: border-box; }
.die-body {
  background: var(--die-face); clip-path: var(--cut-2);
  box-shadow: inset 0 0 0 4px var(--die-ring), inset 0 -12px 0 0 var(--die-band);
}
.die-front { background: var(--die-face); box-shadow: inset 0 0 0 4px var(--die-ring), inset 0 -12px 0 0 var(--die-band); clip-path: var(--cut-1); }
.die-side { background: var(--die-side); box-shadow: inset 0 0 0 4px var(--die-ring); clip-path: var(--cut-1); }
.die-diamond { inset: 0; clip-path: var(--die-shape); }
.die-diamond-ring { background: var(--die-ring); }
.die-diamond-body { background: var(--die-face); }
.pip { background: var(--die-pip); }
.pip-side { background: var(--die-ring); }
.die-crack { background: var(--void); }
</style>
