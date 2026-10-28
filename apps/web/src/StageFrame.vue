<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

const props = defineProps<{ layout: 'scene' | 'overlay'; checker?: boolean }>();

const root = ref<HTMLElement | null>(null);
const box = ref({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
let observer: ResizeObserver | null = null;
let usingWindow = false;
let htmlClassAdded = false;

const scale = computed(() => Math.min(box.value.width / CANVAS_WIDTH, box.value.height / CANVAS_HEIGHT));
const canvasStyle = computed(() => {
  const s = scale.value;
  const left = (box.value.width - CANVAS_WIDTH * s) / 2;
  const top = (box.value.height - CANVAS_HEIGHT * s) / 2;
  return {
    width: `${CANVAS_WIDTH}px`,
    height: `${CANVAS_HEIGHT}px`,
    left: `${left}px`,
    top: `${top}px`,
    transform: `scale(${s})`,
    transformOrigin: 'top left'
  };
});

function measureWindow() {
  box.value = { width: window.innerWidth, height: window.innerHeight };
}

onMounted(() => {
  if (props.layout === 'overlay') {
    document.documentElement.classList.add('stage-transparent');
    htmlClassAdded = true;
  }
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) box.value = { width: rect.width, height: rect.height };
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
    <div class="stage-canvas" :style="canvasStyle"><slot /></div>
  </div>
</template>

<style scoped>
.stage-frame { position: relative; width: 100%; height: 100%; padding: 0; min-height: 0; overflow: hidden; }
.stage-frame[data-layout='overlay'] { background: transparent; }
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
:global(html.stage-transparent),
:global(html.stage-transparent body),
:global(html.stage-transparent #app) { background: transparent; }
</style>
