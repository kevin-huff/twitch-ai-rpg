<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { slateKind, speakerName } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null; characterId?: string | null }>();

const latest = computed(() => props.snapshot.history[props.snapshot.history.length - 1] ?? null);
const slate = computed(() => slateKind(props.snapshot));
const lines = computed(() => latest.value?.segments ?? []);
const hasActive = computed(() => !!props.activeSegmentId && lines.value.some(line => line.id === props.activeSegmentId));

function dimmed(line: { id: string }): boolean {
  return hasActive.value && line.id !== props.activeSegmentId;
}
function lineClass(kind: string): string {
  if (kind === 'npc_dialogue') return 'npc';
  if (kind === 'player_dialogue') return 'player';
  if (kind === 'player_action') return 'player action';
  return 'narration';
}

const LINE_PX = 48;
const MIN_CHUNK_MS = 4000;
const WORDS_PER_SECOND = 2.5;

type View = { row: number; ms: number };
type Chunk = { ids: string[]; views: View[] };

const caption = ref<HTMLElement | null>(null);
const measuring = ref(true);
const chunks = ref<Chunk[]>([]);
const chunkIndex = ref(0);
const viewIndex = ref(0);
const latestId = computed(() => latest.value?.id ?? null);
const segmentIds = computed(() => lines.value.map(line => line.id).join('|'));
const chunkOf = computed(() => {
  const found = new Map<string, number>();
  chunks.value.forEach((chunk, index) => chunk.ids.forEach(id => found.set(id, index)));
  return found;
});
const shownIds = computed(() => chunks.value[chunkIndex.value]?.ids ?? []);

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
function readingMs(words: number): number {
  return Math.max(MIN_CHUNK_MS, (words / WORDS_PER_SECOND) * 1000);
}
function chunkClass(id: string) {
  if (measuring.value || !chunks.value.length) return {};
  const shown = chunkOf.value.get(id) === chunkIndex.value;
  return { 'off-chunk': !shown, 'chunk-start': shown && shownIds.value[0] === id };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let measureToken = 0;
const seen = new Set<string>();
const voiced = new Set<string>();
const screenMs = new Map<string, number>();
let shownAt: number | null = null;
function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
function activeChunk(): number | null {
  if (!props.activeSegmentId) return null;
  return chunkOf.value.get(props.activeSegmentId) ?? null;
}
function applyScroll() {
  const el = caption.value;
  if (!el) return;
  el.scrollTop = (chunks.value[chunkIndex.value]?.views[viewIndex.value]?.row ?? 0) * LINE_PX;
}
function nextChunk(): number | null {
  const unseen = chunks.value.findIndex((chunk, index) => index !== chunkIndex.value && chunk.ids.some(id => !seen.has(id)));
  if (unseen !== -1) return unseen;
  const last = chunks.value.length - 1;
  return chunkIndex.value < last ? last : null;
}
function markSeen(index: number | null) {
  if (index !== null) chunks.value[index]?.ids.forEach(id => seen.add(id));
}
function chunkKey(index: number): string {
  return chunks.value[index]?.ids.join('|') ?? '';
}
function onScreenMs(index: number): number {
  const running = index === chunkIndex.value && shownAt !== null ? Date.now() - shownAt : 0;
  return (screenMs.get(chunkKey(index)) ?? 0) + running;
}
function checkSeen(index: number | null) {
  if (index === null) return;
  const chunk = chunks.value[index];
  if (!chunk) return;
  const readMs = chunk.views.reduce((sum, view) => sum + view.ms, 0);
  if (chunk.ids.every(id => voiced.has(id)) || onScreenMs(index) >= readMs) markSeen(index);
}
function settleScreenTime() {
  if (shownAt === null) return;
  const index = chunkIndex.value;
  if (chunks.value[index]) screenMs.set(chunkKey(index), onScreenMs(index));
  shownAt = null;
  checkSeen(index);
}
function show(index: number, view = 0) {
  settleScreenTime();
  chunkIndex.value = index;
  shownAt = Date.now();
  viewIndex.value = view;
  applyScroll();
  schedule();
}
function schedule() {
  clearTimer();
  const chunk = chunks.value[chunkIndex.value];
  if (measuring.value || !chunk) return;
  const lastView = viewIndex.value >= chunk.views.length - 1;
  if (lastView && (activeChunk() !== null || nextChunk() === null)) return;
  timer = setTimeout(() => {
    timer = null;
    if (!lastView) show(chunkIndex.value, viewIndex.value + 1);
    else if (activeChunk() === null) {
      markSeen(chunkIndex.value);
      const next = nextChunk();
      if (next !== null) show(next);
    }
  },  chunk.views[viewIndex.value]!.ms);
}

function buildChunks(el: HTMLElement): Chunk[] {
  const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-segment-id]'));
  const height = new Map(nodes.map(node => [node.dataset.segmentId ?? '', node.offsetHeight]));
  const avail = el.clientHeight;
  const windowRows = Math.max(1, Math.floor(avail / LINE_PX));
  const groups: { ids: string[]; height: number; words: number }[] = [];
  let open: { ids: string[]; height: number; words: number } | null = null;
  for (const line of lines.value) {
    const size = height.get(line.id) ?? 0;
    const words = wordCount(line.text);
    if (open && open.height + size <= avail + 0.5) {
      open.ids.push(line.id);
      open.height += size;
      open.words += words;
    } else {
      open = { ids: [line.id], height: size, words };
      groups.push(open);
    }
    if (open.height > avail + 0.5) open = null;
  }
  return groups.map(group => {
    const rows = Math.round(group.height / LINE_PX);
    if (avail <= 0 || rows <= windowRows) return { ids: group.ids, views: [{ row: 0, ms: readingMs(group.words) }] };
    const starts: number[] = [];
    for (let row = 0; row + windowRows < rows; row += windowRows) starts.push(row);
    starts.push(rows - windowRows);
    return {
      ids: group.ids,
      views: starts.map((row, index) => {
        const revealed = index === 0 ? windowRows : row - starts[index - 1]!;
        return { row, ms: readingMs((group.words * revealed) / rows) };
      })
    };
  });
}

async function measure(reset: boolean) {
  const token = ++measureToken;
  clearTimer();
  const anchor = reset ? null : shownIds.value[0] ?? null;
  settleScreenTime();
  measuring.value = true;
  await nextTick();
  if (token !== measureToken) return;
  const el = caption.value;
  if (!el) {
    chunks.value = [];
    return;
  }
  el.scrollTop = 0;
  if (reset) {
    seen.clear();
    voiced.clear();
    screenMs.clear();
  }
  if (props.activeSegmentId) voiced.add(props.activeSegmentId);
  chunks.value = buildChunks(el);
  measuring.value = false;
  const kept = anchor ? chunkOf.value.get(anchor) : undefined;
  const active = activeChunk();
  checkSeen(active);
  show(active ?? kept ?? 0);
}

watch([caption, latestId], () => measure(true));
watch(segmentIds, () => measure(false));
watch(() => props.activeSegmentId, id => {
  if (id) voiced.add(id);
  if (measuring.value) return;
  const index = activeChunk();
  checkSeen(index);
  if (index === null) schedule();
  else if (index !== chunkIndex.value) show(index);
});
function onResize() {
  measure(false);
}
let unmounted = false;
const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
onMounted(() => {
  window.addEventListener('resize', onResize);
  if (!fonts) return;
  fonts.addEventListener('loadingdone', onResize);
  fonts.ready.then(() => {
    if (!unmounted) measure(false);
  });
});
onBeforeUnmount(() => {
  unmounted = true;
  measureToken++;
  clearTimer();
  window.removeEventListener('resize', onResize);
  fonts?.removeEventListener('loadingdone', onResize);
});
</script>

<template>
  <div v-if="lines.length && !slate" class="stage-story" aria-label="Story">
    <div ref="caption" class="caption-window">
      <p
        v-for="line in lines" :key="line.id" class="line"
        :class="[lineClass(line.kind), chunkClass(line.id), { speaking: line.id === activeSegmentId, dim: dimmed(line) }]"
        :data-segment-id="line.id"
      ><template v-if="line.kind !== 'narration' && line.kind !== 'system'"><span class="who">{{ speakerName(line) }}</span>{{ ' ' }}<template v-if="line.kind === 'player_action'"><span class="line-tag">Action</span>{{ ' ' }}</template></template><span class="said">{{ line.text }}</span></p>
    </div>
  </div>
</template>

<style scoped>
.stage-story {
  position: absolute; left: 240px; top: 836px; width: 1440px; height: 184px; min-height: 0; margin: 0; padding: 20px 24px;
  box-sizing: border-box; overflow: hidden; border: 0; border-radius: 0;
  background: var(--night); box-shadow: var(--canvas-frame-window); clip-path: var(--cut-1);
}
.caption-window { height: 144px; display: flex; flex-direction: column; overflow: hidden; }
.line {
  position: relative; flex: 0 0 auto; margin: 0; padding: 0 0 0 28px; overflow-wrap: anywhere;
  font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 48px; color: var(--bone);
}
.line.narration { color: var(--dust); }
.line.chunk-start { margin-top: auto; }
.line.off-chunk { display: none; }
.who { font-family: var(--font-body); font-size: 40px; font-weight: 400; line-height: 48px; color: var(--candle); }
.line-tag { margin-left: 12px; font-family: var(--font-label); font-size: 24px; font-weight: 400; line-height: 28px; text-transform: uppercase; color: var(--dust); }
.line.speaking::before {
  content: ''; position: absolute; left: 8px; top: 16px; width: 12px; height: 20px; background: var(--candle);
  clip-path: polygon(0 0, 4px 0, 4px 4px, 8px 4px, 8px 8px, 12px 8px, 12px 12px, 8px 12px, 8px 16px, 4px 16px, 4px 20px, 0 20px);
}
.line.dim, .line.dim .who { color: var(--dust); }

</style>
