<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PublicActionContract, SessionSnapshot } from '@rpg/contracts';
import StageSlate from './StageSlate.vue';
import { pictureUrl, portraitAlt, portraitIdFor, shownScenePicture } from './pictures';
import {
  AI_BADGE, bandLabel, bandSymbol, helperCredit, initials, rollBreakdown, slateKind, sortRolls, speakerName, statusLabel, traitName, wagerOutcomes
} from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null }>();

const latest = computed(() => props.snapshot.history[props.snapshot.history.length - 1] ?? null);
const slate = computed(() => slateKind(props.snapshot));
const lines = computed(() => latest.value?.segments ?? []);
const rolls = computed(() => latest.value ? sortRolls(latest.value.rolls, props.snapshot.characters) : []);
const tracks = computed(() => props.snapshot.tracks.filter(track => track.enabled).slice(0, 2));
const stakes = computed<PublicActionContract[]>(() => {
  if (props.snapshot.role === 'director') return [];
  const found = (props.snapshot.activeBeat as { stakes?: PublicActionContract[] } | null)?.stakes;
  if (!Array.isArray(found)) return [];
  const rank = (id: string) => {
    const index = props.snapshot.characters.findIndex(character => character.id === id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...found].sort((a, b) => rank(a.actorCharacterId) - rank(b.actorCharacterId));
});
const status = computed(() => statusLabel(props.snapshot.session.status, props.connected));
const hasActive = computed(() => !!props.activeSegmentId && lines.value.some(line => line.id === props.activeSegmentId));

const failedImages = ref<Set<string>>(new Set());
function imageFailed(id: string) {
  failedImages.value = new Set(failedImages.value).add(id);
}
const shownImageKey = computed(() => {
  const ids = [shownScenePicture(props.snapshot)?.imageId ?? null, ...props.snapshot.characters.map(character => portraitIdFor(props.snapshot, character.id))];
  return ids.filter((id): id is string => !!id).join('|');
});
// A failed picture is remembered only while it stays shown; a fresh show gets one new try.
watch(shownImageKey, key => {
  const shown = new Set(key ? key.split('|') : []);
  const kept = [...failedImages.value].filter(id => shown.has(id));
  if (kept.length !== failedImages.value.size) failedImages.value = new Set(kept);
});
const sessionScope = computed(() => ({ kind: 'session' as const, sessionId: props.snapshot.session.id }));
const cornerId = computed(() => {
  const id = shownScenePicture(props.snapshot)?.imageId ?? null;
  return id && !failedImages.value.has(id) ? id : null;
});
const cornerSrc = computed(() => cornerId.value ? pictureUrl(sessionScope.value, cornerId.value) : null);
function chipPortrait(characterId: string): string | null {
  const id = portraitIdFor(props.snapshot, characterId);
  return id && !failedImages.value.has(id) ? pictureUrl(sessionScope.value, id) : null;
}

function nameOf(characterId: string): string {
  return props.snapshot.characters.find(character => character.id === characterId)?.displayName ?? 'Someone';
}
function kindWord(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
function dimmed(line: { id: string; kind: string }): boolean {
  return hasActive.value && line.id !== props.activeSegmentId && line.kind !== 'player_dialogue';
}
function lineClass(kind: string): string {
  return kind === 'npc_dialogue' ? 'npc' : kind === 'player_dialogue' ? 'player' : 'narration';
}

const SPOTLIGHT_MS = 8000;
const spotlight = ref(0);
const stakeKey = computed(() => stakes.value.map(stake => stake.id).join('|'));
const spot = computed(() => stakes.value[spotlight.value] ?? stakes.value[0] ?? null);
let spotlightTimer: ReturnType<typeof setInterval> | null = null;
function stopSpotlight() {
  if (spotlightTimer !== null) clearInterval(spotlightTimer);
  spotlightTimer = null;
}
watch(stakeKey, () => {
  spotlight.value = 0;
  stopSpotlight();
  if (stakes.value.length < 2) return;
  spotlightTimer = setInterval(() => {
    spotlight.value = (spotlight.value + 1) % Math.max(1, stakes.value.length);
  }, SPOTLIGHT_MS);
}, { immediate: true });

const stakeDetail = computed(() => {
  const stake = spot.value;
  if (!stake) return '';
  const modifier = props.snapshot.characters.find(character => character.id === stake.actorCharacterId)?.traits[stake.trait] ?? 0;
  const parts = stake.ruling === 'check' ? [`${traitName(stake.trait)} +${modifier}`, `${stake.risk} risk`] : [];
  if (stake.helperCharacterIds.length) parts.push(helperCredit(stake, stake.helperCharacterIds.map(nameOf)));
  return parts.join(' · ');
});

const LINE_PX = 50;
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
onMounted(() => window.addEventListener('resize', onResize));
onBeforeUnmount(() => {
  measureToken++;
  clearTimer();
  stopSpotlight();
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div class="overlay" data-layout="overlay">
    <div class="cast-chips" aria-label="Cast">
      <div v-for="character in snapshot.characters" :key="character.id" class="chip">
        <img
          v-if="chipPortrait(character.id)" class="chip-portrait" :src="chipPortrait(character.id)!" :alt="portraitAlt(character.displayName)"
          @error="imageFailed(portraitIdFor(snapshot, character.id)!)"
        >
        <span v-else class="initials" aria-hidden="true">{{ initials(character.displayName) }}</span>
        <span class="chip-name">{{ character.displayName }}</span>
        <span class="strain" :aria-label="`Strain ${character.strain} of 4`"><i v-for="pip in 4" :key="pip" :class="{ filled: pip <= character.strain }"></i></span>
        <span v-if="character.strain === 4" class="chip-flag">Needs help</span>
      </div>
    </div>

    <img
      v-if="cornerSrc" class="scene-corner" :src="cornerSrc" :alt="snapshot.session.scene.title"
      @error="imageFailed(cornerId!)"
    >

    <div class="top-right">
      <span class="ai-badge">{{ AI_BADGE }}</span>
      <span class="state-chip" :class="{ off: !connected || snapshot.session.status !== 'live' }">{{ status }}</span>
    </div>

    <template v-if="!slate">
      <div v-if="tracks.length" class="rail">
        <div v-for="item in tracks" :key="item.id" class="rail-item">
          <div class="rail-head"><span class="rail-label">{{ item.label }}</span><span class="rail-count">{{ item.current }}/{{ item.max }}</span></div>
          <div class="pips" :aria-label="`${item.label}: ${item.current} of ${item.max}`"><i v-for="pip in item.max" :key="pip" :class="{ filled: pip <= item.current }"></i></div>
          <span class="rail-kind">{{ kindWord(item.kind) }}</span>
        </div>
      </div>

      <div v-if="spot" class="wager" aria-label="What is at stake">
        <div :key="spot.id" class="wager-body">
          <p class="wager-goal"><strong>{{ nameOf(spot.actorCharacterId) }}</strong> · {{ spot.intent }}</p>
          <p v-if="stakeDetail" class="wager-detail">{{ stakeDetail }}</p>
          <div class="wager-outcomes">
            <p v-for="outcome in wagerOutcomes(spot)" :key="outcome.label"><span>{{ outcome.label }}</span><em>{{ outcome.text }}</em></p>
          </div>
        </div>
        <span v-if="stakes.length > 1" class="wager-marker">{{ spotlight + 1 }} of {{ stakes.length }}</span>
      </div>

      <div v-if="rolls.length" class="dice" :class="{ 'dice-held': stakes.length > 0, 'dice-dense': rolls.length > 4 }">
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

      <div v-if="lines.length" class="stage-story" aria-label="Story">
        <div ref="caption" class="caption-window">
          <p
            v-for="line in lines" :key="line.id" class="line"
            :class="[lineClass(line.kind), chunkClass(line.id), { speaking: line.id === activeSegmentId, dim: dimmed(line) }]"
            :data-segment-id="line.id"
          ><span class="who">{{ speakerName(line) }}</span> <span class="said">{{ line.text }}</span></p>
        </div>
      </div>
    </template>
    <div v-else class="slate-spot">
      <StageSlate compact :kind="slate" :show-title="snapshot.session.title" :scene-title="snapshot.session.scene.title" :scene-description="snapshot.session.scene.description" />
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute; inset: 0; pointer-events: none; color: #f4efe2;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.overlay p { margin: 0; }
.cast-chips, .top-right, .rail, .wager, .dice, .stage-story, .slate-spot { position: absolute; }

.chip, .ai-badge, .state-chip, .rail-item, .wager, .roll, .stage-story {
  background: rgba(14, 18, 16, 0.82); border: 1px solid rgba(221, 186, 118, 0.35); border-radius: 16px; box-sizing: border-box;
}

.cast-chips { left: 96px; top: 60px; width: 1000px; height: 72px; display: flex; gap: 12px; overflow: hidden; }
.chip { display: flex; align-items: center; gap: 10px; padding: 0 14px 0 10px; height: 72px; min-width: 0; flex: 0 1 auto; white-space: nowrap; }
.initials {
  display: grid; place-items: center; flex: 0 0 auto; width: 48px; height: 48px; border-radius: 50%;
  background: #343c31; color: #e3c58e; font: 600 22px Georgia, serif;
}
.chip-portrait { flex: 0 0 auto; width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
.chip-name { font-size: 28px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.strain, .pips { display: inline-flex; gap: 5px; flex: 0 0 auto; }
.strain i, .pips i { display: block; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(221, 186, 118, 0.7); box-sizing: border-box; }
.strain i.filled, .pips i.filled { background: #ddba76; }
.chip-flag { font-size: 24px; font-weight: 700; color: #f0b27a; flex: 0 0 auto; }

.scene-corner { position: absolute; left: 96px; top: 160px; width: 336px; height: 192px; object-fit: cover; border-radius: 16px; border: 1px solid rgba(221, 186, 118, 0.35); box-sizing: border-box; }

.top-right { right: 96px; top: 60px; display: flex; align-items: center; gap: 12px; }
.ai-badge { font-size: 24px; padding: 10px 18px; color: #d8d3c4; }
.state-chip { font-size: 26px; font-weight: 700; padding: 10px 20px; color: #a5dbc3; border-color: #3e6052; }
.state-chip.off { color: #edc98d; border-color: #7b6746; }

.rail { left: 1500px; top: 160px; width: 324px; height: 260px; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; overflow: hidden; }
.rail-item { padding: 12px 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; }
.rail-head { min-width: 0; display: flex; justify-content: space-between; gap: 12px; font-size: 28px; font-weight: 600; }
.rail-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-kind { font-size: 24px; color: #b9b4a4; }

.wager { left: 480px; top: 140px; width: 960px; height: auto; max-height: 612px; padding: 12px 20px; overflow: hidden; }
.wager-body { display: grid; gap: 6px; }
.wager-goal { font-size: 30px; line-height: 1.2; overflow-wrap: anywhere; padding-right: 110px; }
.wager-goal strong { color: #ddba76; }
.wager-detail { font-size: 26px; line-height: 1.2; color: #d8d3c4; overflow-wrap: anywhere; }
.wager-outcomes { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: 8px; margin-top: 4px; }
.wager-outcomes p { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.wager-outcomes span { font-size: 26px; line-height: 1.2; font-weight: 700; color: #ddba76; overflow-wrap: anywhere; }
.wager-outcomes em {
  font-size: 26px; line-height: 1.2; font-style: normal; min-width: 0; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
}
.wager-marker {
  position: absolute; top: 12px; right: 20px; font-size: 24px; font-weight: 700; line-height: 1.2;
  color: #a5dbc3; background: rgba(95, 208, 196, 0.14); padding: 2px 12px; border-radius: 10px;
}
@media (prefers-reduced-motion: no-preference) {
  .wager-body { animation: wager-in 320ms ease-out; }
  @keyframes wager-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
}

.dice { left: 240px; top: 762px; width: 1440px; height: 68px; display: flex; justify-content: center; gap: 16px; }
.dice.dice-held { visibility: hidden; }
.roll { display: flex; align-items: center; gap: 6px; flex: 1 1 0; height: 68px; padding: 0 8px; min-width: 0; margin: 0; }
.roll-total { font-size: 40px; font-weight: 700; line-height: 1; color: #ddba76; margin: 0; flex: 0 0 auto; }
.roll-text { display: grid; flex: 1 1 0; min-width: 0; font-size: 24px; line-height: 1.1; }
.roll-text > span { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin: 0; white-space: nowrap; }
.roll-who { flex: 0 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.roll-sum { flex: 0 100000 auto; min-width: 0; color: #b9b4a4; overflow: hidden; text-overflow: ellipsis; }
.roll-band { font-weight: 600; gap: 6px; }
.roll-symbol, .roll-result { flex: 0 0 auto; }
.dice-dense { gap: 8px; }
.dice-dense .roll { gap: 6px; padding: 0 6px; }
.dice-dense .roll-total { font-size: 32px; }
.dice-dense .roll-sum, .dice-dense .roll-symbol { display: none; }

.stage-story {
  left: 240px; top: 838px; width: 1440px; height: 182px; min-height: 0; padding: 16px 24px;
  overflow: hidden;
}
.caption-window { height: 150px; display: flex; flex-direction: column; overflow: hidden; }
.line {
  flex: 0 0 auto; margin: 0; padding: 0 12px; border-radius: 12px; overflow-wrap: anywhere;
  font: 44px/50px Georgia, 'Times New Roman', serif;
}
.line.narration { font-size: 38px; color: #eeeee6; }
.line.chunk-start { margin-top: auto; }
.line.off-chunk { display: none; }
.who {
  display: inline-block; vertical-align: top; margin: 5px 8px 0 0; font: 700 32px/40px system-ui, sans-serif; padding: 0 12px; border-radius: 10px;
  color: #ddba76; background: rgba(221, 186, 118, 0.14);
}
.line.player .who { color: #5fd0c4; background: rgba(95, 208, 196, 0.14); }
.line.speaking { box-shadow: inset 0 0 0 4px #ddba76; }
.line.dim { opacity: 0.5; }

.slate-spot { left: 240px; top: 762px; width: 1440px; height: 258px; overflow: hidden; }
</style>
