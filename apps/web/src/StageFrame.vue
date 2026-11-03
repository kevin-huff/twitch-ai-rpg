<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

const props = defineProps<{
  layout: 'scene' | 'overlay' | 'piece' | 'blank';
  checker?: boolean;
  box?: { x: number; y: number; width: number; height: number };
}>();

const root = ref<HTMLElement | null>(null);
const size = ref({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
let observer: ResizeObserver | null = null;
let usingWindow = false;
let htmlClassAdded = false;

const isPiece = computed(() => props.layout === 'piece' && !!props.box);
const scale = computed(() => {
  if (isPiece.value && props.box) return Math.min(size.value.width / props.box.width, size.value.height / props.box.height);
  return Math.min(size.value.width / CANVAS_WIDTH, size.value.height / CANVAS_HEIGHT);
});
const canvasStyle = computed(() => {
  const s = scale.value;
  if (isPiece.value && props.box) {
    return {
      width: `${props.box.width}px`,
      height: `${props.box.height}px`,
      left: '0px',
      top: '0px',
      transform: `scale(${s})`,
      transformOrigin: 'top left'
    };
  }
  const left = (size.value.width - CANVAS_WIDTH * s) / 2;
  const top = (size.value.height - CANVAS_HEIGHT * s) / 2;
  return {
    width: `${CANVAS_WIDTH}px`,
    height: `${CANVAS_HEIGHT}px`,
    left: `${left}px`,
    top: `${top}px`,
    transform: `scale(${s})`,
    transformOrigin: 'top left'
  };
});

const originStyle = computed(() => ({
  left: `${-(props.box?.x ?? 0)}px`,
  top: `${-(props.box?.y ?? 0)}px`
}));

function measureWindow() {
  size.value = { width: window.innerWidth, height: window.innerHeight };
}

onMounted(() => {
  if (props.layout !== 'scene') {
    document.documentElement.classList.add('stage-transparent');
    htmlClassAdded = true;
  }
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) size.value = { width: rect.width, height: rect.height };
    });
    observer.observe(root.value);
  } else {
    usingWindow = true;
    measureWindow();
    window.addEventListener('resize', measureWindow);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  if (usingWindow) window.removeEventListener('resize', measureWindow);
  if (htmlClassAdded) document.documentElement.classList.remove('stage-transparent');
});
</script>

<template>
  <div ref="root" class="stage stage-frame" :data-layout="layout">
    <div v-if="checker" class="stage-checker" aria-hidden="true" />
    <template v-if="layout === 'piece'">
      <div class="stage-canvas" :style="canvasStyle">
        <div class="stage-piece-origin" :style="originStyle"><slot /></div>
      </div>
    </template>
    <div v-else-if="layout !== 'blank'" class="stage-canvas" :style="canvasStyle"><slot /></div>
  </div>
</template>

<style scoped>
.stage-frame { position: relative; width: 100%; height: 100%; padding: 0; min-height: 0; overflow: hidden; }
.stage-frame[data-layout='overlay'],
.stage-frame[data-layout='piece'],
.stage-frame[data-layout='blank'] { background: transparent; }
.stage-frame[data-layout='scene'] { background: var(--void); }
.stage-checker {
  position: absolute; inset: 0;
  background-color: #2b2b2b;
  background-image: linear-gradient(45deg, #3a3a3a 25%, transparent 25%, transparent 75%, #3a3a3a 75%),
    linear-gradient(45deg, #3a3a3a 25%, transparent 25%, transparent 75%, #3a3a3a 75%);
  background-size: 40px 40px;
  background-position: 0 0, 20px 20px;
}
.stage-canvas { position: absolute; overflow: hidden; }
.stage-piece-origin {
  position: absolute; width: 1920px; height: 1080px;
  color: var(--bone); font-family: var(--font-body); font-weight: 400; pointer-events: none;
}
:global(html.stage-transparent),
:global(html.stage-transparent body),
:global(html.stage-transparent #app) { background: transparent; }
</style>
