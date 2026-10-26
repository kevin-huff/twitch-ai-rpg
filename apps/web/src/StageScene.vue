<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import StageSlate from './StageSlate.vue';
import { portraitAlt, pictureUrl, portraitIdFor, shownScenePicture } from './pictures';
import { AI_BADGE, bandLabel, bandSymbol, helperCredit, initials, rollBreakdown, slateKind, sortRolls, speakerName, speakerRole, statusLabel, traitName, wagerOutcomes } from './stage-format';

const props = defineProps<{ snapshot: SessionSnapshot; connected: boolean; activeSegmentId?: string | null }>();

const session = computed(() => props.snapshot.session);
const characters = computed(() => props.snapshot.characters ?? []);
const slate = computed(() => slateKind(props.snapshot));
const chip = computed(() => statusLabel(session.value.status, props.connected));
const chipWarn = computed(() => chip.value !== 'Live');

const latest = computed(() => props.snapshot.history?.at(-1) ?? null);
const segments = computed(() => latest.value?.segments ?? []);
const rolls = computed(() => sortRolls(latest.value?.rolls ?? [], characters.value));
const hasActive = computed(() => !!props.activeSegmentId && segments.value.some(segment => segment.id === props.activeSegmentId));

const stakes = computed(() => {
  const snapshot = props.snapshot;
  if (snapshot.role === 'director' || !snapshot.activeBeat) return [];
  const list = snapshot.activeBeat.stakes ?? [];
  const rank = (id: string) => {
    const index = characters.value.findIndex(character => character.id === id);
    return index === -1 ? characters.value.length : index;
  };
  return list.map((stake, index) => ({ stake, index }))
    .sort((a, b) => rank(a.stake.actorCharacterId) - rank(b.stake.actorCharacterId) || a.index - b.index)
    .map(entry => entry.stake);
});
const SPOTLIGHT_MS = 8000;
const rotating = computed(() => stakes.value.length >= 2);
const stakeKey = computed(() => stakes.value.map(stake => stake.id).join(','));
const spotlight = ref(0);
const spotlightIndex = computed(() => Math.min(spotlight.value, Math.max(0, stakes.value.length - 1)));
const cards = computed(() => (rotating.value ? stakes.value.slice(spotlightIndex.value, spotlightIndex.value + 1) : stakes.value));

const tracks = computed(() => (props.snapshot.tracks ?? []).filter(track => track.enabled).slice(0, 3));
const facts = computed(() => [...(props.snapshot.facts ?? [])].reverse());
const crowded = computed(() => characters.value.length > 5);

const REVEAL_HOLD_MS = 4000;
const REVEAL_SHRINK_MS = 900;
const broken = ref(new Set<string>());
const picture = computed(() => shownScenePicture(props.snapshot));
const pictureSrc = computed(() => {
  const shown = picture.value;
  return shown && !broken.value.has(shown.imageId) ? pictureUrl({ kind: 'session', sessionId: session.value.id }, shown.imageId) : null;
});
const shownPictureId = computed(() => (pictureSrc.value ? picture.value?.imageId ?? null : null));
// Every picture this stage may show right now; a failure is remembered only while the snapshot keeps showing that picture.
const shownIds = computed(() => {
  const ids: string[] = [];
  const scene = picture.value?.imageId;
  if (scene) ids.push(scene);
  for (const entity of [...characters.value, ...(props.snapshot.npcs ?? [])]) {
    const imageId = portraitIdFor(props.snapshot, entity.id);
    if (imageId) ids.push(imageId);
  }
  return ids;
});
watch(() => shownIds.value.join(','), () => {
  const keep = new Set(shownIds.value);
  const kept = [...broken.value].filter(imageId => keep.has(imageId));
  if (kept.length !== broken.value.size) broken.value = new Set(kept);
});
// Portraits of speakers and party members; one that fails to load drops back to the initials.
function portraitSrc(entityId: string): string | null {
  const imageId = portraitIdFor(props.snapshot, entityId);
  return imageId && !broken.value.has(imageId) ? pictureUrl({ kind: 'session', sessionId: session.value.id }, imageId) : null;
}
function speakerPortrait(segment: { kind: string; speaker: { entityId: string } | null }): string | null {
  return segment.speaker && (segment.kind === 'player_dialogue' || segment.kind === 'npc_dialogue') ? portraitSrc(segment.speaker.entityId) : null;
}
function markPortraitBroken(entityId: string) {
  const imageId = portraitIdFor(props.snapshot, entityId);
  if (imageId) markBroken(imageId);
}
const revealing = ref(false);
const shrinking = ref(false);
const seenPictures = new Set<string>();
let revealTimers: ReturnType<typeof setTimeout>[] = [];
function stopReveal() {
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  revealing.value = false;
  shrinking.value = false;
}
function markBroken(imageId: string) {
  broken.value = new Set(broken.value).add(imageId);
}
// A picture already seen here (on mount, reload, reconnect, or shown again after hiding) goes straight to the panel.
watch(shownPictureId, (imageId, previous) => {
  if (!imageId) { stopReveal(); return; }
  const first = previous === undefined;
  if (seenPictures.has(imageId)) return;
  seenPictures.add(imageId);
  if (first) return;
  stopReveal();
  revealing.value = true;
  revealTimers = [
    setTimeout(() => { shrinking.value = true; }, REVEAL_HOLD_MS),
    setTimeout(stopReveal, REVEAL_HOLD_MS + REVEAL_SHRINK_MS),
  ];
}, { immediate: true });

const correction = computed(() => {
  const all = props.snapshot.corrections ?? [];
  let newest: (typeof all)[number] | null = null;
  for (const item of all) {
    if (!newest || item.stateRevision > newest.stateRevision
      || (item.stateRevision === newest.stateRevision && Date.parse(item.recordedAt) >= Date.parse(newest.recordedAt))) newest = item;
  }
  return newest;
});

function nameOf(id: string): string {
  return characters.value.find(character => character.id === id)?.displayName ?? 'Someone';
}
function modifierOf(characterId: string, trait: keyof SessionSnapshot['characters'][number]['traits']): number {
  return characters.value.find(character => character.id === characterId)?.traits[trait] ?? 0;
}
function roleWord(segment: Parameters<typeof speakerRole>[0] & Parameters<typeof speakerName>[0]): string | null {
  const role = speakerRole(segment);
  return role.toLowerCase() === speakerName(segment).toLowerCase() ? null : role;
}
const kindWord = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

const MIN_FIT = 0.6;
const PAGE_MS = 8000;
const MARKER_SPACE = 40;
const MARKER_GAP = 10;
const DENSE_ROLLS = 4;
const linesEl = ref<HTMLElement | null>(null);
type PageEntry = { id: string; offsetRows: number; rows: number; clip: number | null; shift: number; below: number };
const pages = ref<PageEntry[][] | null>(null);
const pageIndex = ref(0);
const pageCount = computed(() => pages.value?.length ?? 1);
const spans = computed(() => {
  const map = new Map<string, { first: number; last: number }>();
  pages.value?.forEach((entries, page) => entries.forEach(entry => {
    const span = map.get(entry.id);
    if (span) span.last = page;
    else map.set(entry.id, { first: page, last: page });
  }));
  return map;
});
const activeSpan = computed(() => (hasActive.value && props.activeSegmentId ? spans.value.get(props.activeSegmentId) ?? null : null));
const activePage = computed(() => activeSpan.value?.first ?? null);
const shownPage = computed(() => {
  const span = activeSpan.value;
  if (span) return Math.min(Math.max(pageIndex.value, span.first), span.last);
  return Math.min(pageIndex.value, pageCount.value - 1);
});
const shownEntries = computed(() => new Map((pages.value?.[shownPage.value] ?? []).map(entry => [entry.id, entry])));
const offPage = (id: string) => pageCount.value > 1 && spans.value.has(id) && !shownEntries.value.has(id);
const clampStyle = (id: string) => {
  const entry = shownEntries.value.get(id);
  return entry?.clip ? { maxHeight: `${entry.clip}px`, overflow: 'hidden' } : undefined;
};
const shiftStyle = (id: string) => {
  const entry = shownEntries.value.get(id);
  return entry?.clip ? { marginTop: `-${entry.shift}px`, clipPath: `inset(${entry.shift}px 0 ${entry.below}px 0)` } : undefined;
};

const px = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

let disposed = false;
let running = false;
let again = false;

async function refit() {
  if (running) { again = true; return; }
  running = true;
  try {
    do { again = false; await measure(); } while (again && !disposed);
  } finally {
    running = false;
  }
}

async function measure() {
  await nextTick();
  pages.value = null;
  await nextTick();
  const el = linesEl.value;
  if (!el || disposed) return;
  const overflows = (fit: number) => {
    el.style.setProperty('--fit', String(fit));
    return el.scrollHeight > el.clientHeight;
  };
  if (!overflows(1)) return;
  if (!overflows(MIN_FIT)) {
    let low = MIN_FIT;
    let high = 1;
    for (let step = 0; step < 8; step++) {
      const mid = (low + high) / 2;
      if (overflows(mid)) high = mid;
      else low = mid;
    }
    el.style.setProperty('--fit', String(low));
    return;
  }
  el.style.setProperty('--fit', String(MIN_FIT));
  const style = getComputedStyle(el);
  const gap = px(style.rowGap, 20);
  const marker = el.parentElement?.querySelector<HTMLElement>('.page-marker');
  const markerSpace = Math.max(MARKER_SPACE, marker ? marker.offsetHeight + MARKER_GAP : 0);
  const room = Math.max(0, el.clientHeight - px(style.paddingTop, 0) - px(style.paddingBottom, 0) - markerSpace);
  const result: PageEntry[][] = [];
  let used = 0;
  let closed = false;
  for (const line of Array.from(el.querySelectorAll<HTMLElement>('.line[data-segment-id]'))) {
    const id = line.dataset.segmentId!;
    const height = line.offsetHeight;
    if (height > room) {
      const text = line.querySelector<HTMLElement>('.line-text');
      const textStyle = text ? getComputedStyle(text) : null;
      const lineHeight = px(textStyle?.lineHeight, px(textStyle?.fontSize, 40 * MIN_FIT) * 1.25);
      const textHeight = text?.offsetHeight ?? 0;
      const extra = Math.max(0, height - textHeight);
      const rowsPerPage = Math.max(1, Math.floor((room - extra) / lineHeight));
      const totalRows = Math.max(1, Math.ceil(textHeight / lineHeight - 0.01));
      for (let offsetRows = 0; offsetRows < totalRows; offsetRows += rowsPerPage) {
        const rows = Math.min(rowsPerPage, totalRows - offsetRows);
        result.push([{ id, offsetRows, rows, clip: Math.min(room, extra + rows * lineHeight), shift: offsetRows * lineHeight, below: (totalRows - offsetRows - rows) * lineHeight }]);
      }
      closed = true;
      continue;
    }
    const page = result.at(-1);
    if (page && !closed && used + gap + height <= room) {
      page.push({ id, offsetRows: 0, rows: 0, clip: null, shift: 0, below: 0 });
      used += gap + height;
    } else {
      result.push([{ id, offsetRows: 0, rows: 0, clip: null, shift: 0, below: 0 }]);
      used = height;
    }
    closed = false;
  }
  pages.value = result.length ? result : null;
  if (pageIndex.value >= result.length) pageIndex.value = 0;
}

let timer: ReturnType<typeof setInterval> | null = null;
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
function startTimer() {
  stopTimer();
  if (pageCount.value > 1) {
    timer = setInterval(() => {
      const span = activeSpan.value;
      if (!span) pageIndex.value = (shownPage.value + 1) % pageCount.value;
      else if (shownPage.value < span.last) pageIndex.value = shownPage.value + 1;
    }, PAGE_MS);
  }
}
let spotlightTimer: ReturnType<typeof setInterval> | null = null;
function stopSpotlight() {
  if (spotlightTimer) clearInterval(spotlightTimer);
  spotlightTimer = null;
}
function startSpotlight() {
  stopSpotlight();
  if (rotating.value && !disposed) {
    spotlightTimer = setInterval(() => { spotlight.value = (spotlightIndex.value + 1) % stakes.value.length; }, SPOTLIGHT_MS);
  }
}
watch(stakeKey, () => { spotlight.value = 0; startSpotlight(); });

watch(pageCount, startTimer);
watch([() => props.activeSegmentId, activePage], ([, page]) => { if (page !== null) pageIndex.value = page; });
watch([() => props.activeSegmentId, shownPage], startTimer);
watch(() => latest.value?.id, () => { pageIndex.value = 0; });
watch(
  () => [
    slate.value, latest.value?.id, segments.value.map(segment => segment.id).join(','), rolls.value.length, stakes.value.length,
    segments.value.map(segment => speakerPortrait(segment) ?? '').join(','),
    characters.value.map(character => portraitSrc(character.id) ?? '').join(','),
  ].join('|'),
  () => { void refit(); },
);

const onResize = () => { void refit(); };
const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
watch(linesEl, (el, old) => {
  if (old) observer?.unobserve(old);
  if (el) observer?.observe(el);
});
onMounted(() => {
  window.addEventListener('resize', onResize);
  startSpotlight();
  void refit();
});
onBeforeUnmount(() => {
  disposed = true;
  stopTimer();
  stopSpotlight();
  stopReveal();
  window.removeEventListener('resize', onResize);
  observer?.disconnect();
});
</script>

<template>
  <div class="scene" :data-slate="slate ?? undefined">
    <header class="scene-head">
      <div class="head-titles">
        <h1 class="show-title">{{ session.title }}</h1>
        <p class="head-scene">{{ session.scene.title }}</p>
      </div>
      <div class="head-badges">
        <span class="chip" :class="{ warn: chipWarn }">{{ chip }}</span>
        <span class="ai-badge">{{ AI_BADGE }}</span>
      </div>
    </header>

    <section class="stage-story">
      <StageSlate v-if="slate" :kind="slate" :show-title="session.title" :scene-title="session.scene.title" />
      <template v-else>
        <div v-if="stakes.length" class="wager" aria-label="What is at stake">
          <div class="wager-head">
            <p class="label">What’s at stake</p>
            <p v-if="rotating" class="wager-marker">{{ spotlightIndex + 1 }} of {{ stakes.length }}</p>
          </div>
          <div v-if="rotating" class="wager-row">
            <div v-for="(stake, index) in stakes" :key="stake.id" class="wager-row-item" :class="{ current: index === spotlightIndex }">
              <p class="wager-row-name">{{ nameOf(stake.actorCharacterId) }}</p>
            </div>
          </div>
          <div :class="rotating ? 'wager-focus' : 'wager-list'" :data-count="rotating ? undefined : stakes.length">
            <div v-for="stake in cards" :key="stake.id" class="wager-card" :class="{ spotlight: rotating }">
              <div class="wager-main">
                <p class="wager-name">{{ nameOf(stake.actorCharacterId) }}</p>
                <p class="wager-goal">{{ stake.intent }}</p>
                <p v-if="stake.ruling === 'check'" class="wager-trait">{{ traitName(stake.trait) }} +{{ modifierOf(stake.actorCharacterId, stake.trait) }} · {{ stake.risk }} risk</p>
                <p v-if="stake.helperCharacterIds.length" class="wager-trait wager-helpers">{{ helperCredit(stake, stake.helperCharacterIds.map(nameOf)) }}</p>
              </div>
              <div class="wager-results">
                <p v-for="outcome in wagerOutcomes(stake)" :key="outcome.label" class="wager-outcome"><b>{{ outcome.label }}</b> <span class="wager-outcome-text">{{ outcome.text }}</span></p>
              </div>
            </div>
          </div>
        </div>
        <div v-if="rolls.length" class="dice" :class="{ 'dice-dense': rolls.length > DENSE_ROLLS, 'dice-held': stakes.length > 0 }">
          <div
            v-for="(roll, index) in rolls"
            :key="roll.id"
            class="roll"
            :class="{ 'roll-wide': rolls.length <= DENSE_ROLLS && rolls.length % 2 === 1 && index === rolls.length - 1 }"
            :data-band="roll.band"
          >
            <span class="roll-total">{{ roll.total }}</span>
            <span class="roll-detail">
              <span class="roll-head"><span class="roll-name">{{ nameOf(roll.actorCharacterId) }}</span><span class="roll-breakdown">{{ rollBreakdown(roll) }}</span></span>
              <span class="roll-band"><span class="roll-symbol" aria-hidden="true">{{ bandSymbol(roll.band) }}</span><span class="roll-result">{{ bandLabel(roll.band) }}</span></span>
            </span>
          </div>
        </div>
        <div ref="linesEl" class="lines" :class="{ 'has-active': hasActive }">
          <div
            v-for="segment in segments"
            :key="segment.id"
            class="line"
            :class="[segment.kind, { speaking: hasActive && segment.id === activeSegmentId, 'off-page': offPage(segment.id) }]"
            :data-segment-id="segment.id"
            :style="clampStyle(segment.id)"
          >
            <p class="line-who" :class="{ 'with-portrait': speakerPortrait(segment) }">
              <img v-if="speakerPortrait(segment)" class="line-portrait" :src="speakerPortrait(segment)!" :alt="portraitAlt(speakerName(segment))" @error="markPortraitBroken(segment.speaker!.entityId)">
              <span class="line-name">{{ speakerName(segment) }}</span><span v-if="roleWord(segment)" class="line-role">{{ roleWord(segment) }}</span>
            </p>
            <p class="line-text" :style="shiftStyle(segment.id)">{{ segment.text }}</p>
          </div>
        </div>
        <p v-if="pageCount > 1" class="page-marker">Part {{ shownPage + 1 }} of {{ pageCount }}</p>
      </template>
    </section>

    <aside class="rail" :class="{ 'with-picture': pictureSrc }" aria-label="Scene status">
      <div v-if="tracks.length" class="meters">
        <div v-for="track in tracks" :key="track.id" class="meter" :class="{ 'meter-compact': pictureSrc }">
          <p v-if="pictureSrc" class="meter-line">
            <span class="meter-label">{{ track.label }}</span>
            <span class="pips" role="img" :aria-label="`${track.label}: ${track.current} of ${track.max}`">
              <span v-for="pip in track.max" :key="pip" class="pip" :class="{ filled: pip <= track.current }"></span>
            </span>
            <span class="meter-count">{{ track.current }}/{{ track.max }}</span>
          </p>
          <template v-else>
          <p class="meter-top"><span class="meter-label">{{ track.label }}</span><span class="meter-count">{{ track.current }}/{{ track.max }}</span></p>
          <div class="meter-bottom">
            <span class="pips" role="img" :aria-label="`${track.label}: ${track.current} of ${track.max}`">
              <span v-for="pip in track.max" :key="pip" class="pip" :class="{ filled: pip <= track.current }"></span>
            </span>
            <span class="meter-kind">{{ kindWord(track.kind) }}</span>
          </div>
          </template>
        </div>
      </div>
      <section v-if="facts.length" class="facts" data-testid="public-facts">
        <p class="label">Known to the party</p>
        <p v-for="fact in facts" :key="fact.id" class="fact">{{ fact.text }}</p>
      </section>
      <section v-if="!pictureSrc" class="about">
        <p class="label">The scene</p>
        <p class="about-text">{{ session.scene.description }}</p>
      </section>
    </aside>

    <div class="party" :class="{ crowded }" aria-label="The party">
      <div v-for="character in characters" :key="character.id" class="party-card">
        <img v-if="portraitSrc(character.id)" class="party-portrait" :src="portraitSrc(character.id)!" :alt="portraitAlt(character.displayName)" @error="markPortraitBroken(character.id)">
        <span v-else class="initials" aria-hidden="true">{{ initials(character.displayName) }}</span>
        <span class="party-text">
          <span class="party-name">{{ character.displayName }}</span>
          <span v-if="!crowded" class="party-strain">
            <span class="pips" role="img" :aria-label="`Strain ${character.strain} of 4`">
              <span v-for="pip in 4" :key="pip" class="pip" :class="{ filled: pip <= character.strain }"></span>
            </span>
            <span v-if="character.strain === 4" class="needs-help">Needs help</span>
          </span>
        </span>
      </div>
    </div>

    <section v-if="correction" class="correction" aria-label="Published corrections">
      <span class="correction-tag">Correction</span>
      <span class="correction-text" data-testid="published-correction">{{ correction.publicText }}</span>
    </section>

    <figure v-if="pictureSrc && picture" class="scene-picture" :class="{ revealing: revealing && !shrinking, shrinking }">
      <img :src="pictureSrc" :alt="session.scene.title" @error="markBroken(picture.imageId)">
    </figure>
    <div v-if="pictureSrc && revealing && !shrinking" class="scene-reveal-titles">
      <p class="reveal-show">{{ session.title }}</p>
      <p class="reveal-scene">{{ session.scene.title }}</p>
    </div>
  </div>
</template>

<style scoped>
.scene {
  position: absolute; inset: 0; overflow: hidden; font-size: 24px; line-height: 1.25; color: #eeeee6;
  background: radial-gradient(ellipse at 18% 0%, #293329 0%, #121815 58%);
}
.scene p, .scene h1 { margin: 0; line-height: 1.25; letter-spacing: 0; }
.label { font-size: 24px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--gold, #ddba76); font-weight: 700; margin-bottom: 8px; }

.scene-head { position: absolute; left: 96px; top: 60px; width: 1728px; height: 90px; display: flex; justify-content: space-between; align-items: flex-start; gap: 32px; }
.head-titles { min-width: 0; flex: 1 1 0; }
.show-title { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 36px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head-scene { font-size: 30px; color: var(--gold, #ddba76); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 6px; }
.head-badges { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 640px; }
.chip { font-size: 26px; line-height: 1.2; border: 2px solid #3e6052; color: #a5dbc3; border-radius: 30px; padding: 2px 18px; }
.chip.warn { color: #edc98d; border-color: #7b6746; }
.ai-badge { font-size: 24px; color: var(--muted, #a7b2ac); white-space: nowrap; }

.stage-story {
  position: absolute; left: 96px; top: 170px; width: 1204px; height: 630px; min-height: 0; padding: 0;
  display: flex; flex-direction: column; gap: 16px; overflow: hidden;
}
.wager { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.wager-head { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; }
.wager-head .label { margin-bottom: 0; }
.wager-marker { flex: none; font-size: 24px; font-weight: 700; color: var(--muted, #a7b2ac); }
.wager-list { display: grid; gap: 16px; }
.wager-list[data-count='1'] { grid-template-columns: minmax(0, 1fr); }
.wager-card {
  min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; overflow: hidden;
  background: rgba(26, 33, 30, 0.85); border: 1px solid var(--line, #35403b); border-radius: 16px; padding: 12px 16px;
}
.wager-list[data-count='1'] .wager-card, .wager-card.spotlight { display: grid; grid-template-columns: 440px minmax(0, 1fr); gap: 24px; align-items: start; }
.wager-card.spotlight { height: 310px; }
.wager-main { min-width: 0; display: flex; flex-direction: column; }
.wager-results { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.wager-name { font-size: 28px; font-weight: 700; color: var(--gold, #ddba76); overflow-wrap: anywhere; }
.wager-goal { font-size: 28px; font-family: Georgia, 'Times New Roman', serif; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.wager-trait { font-size: 24px; color: var(--muted, #a7b2ac); overflow-wrap: anywhere; }
.wager-outcome { font-size: 24px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.wager-outcome b { color: var(--teal, #91c8b6); }
.wager-row { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 12px; }
.wager-row-item { min-width: 0; box-sizing: border-box; padding: 6px 12px; border: 2px solid var(--line, #35403b); border-radius: 12px; background: rgba(26, 33, 30, 0.85); }
.wager-row-item.current { border-color: var(--gold, #ddba76); }
.wager-row-name { font-size: 24px; font-weight: 700; color: var(--gold, #ddba76); overflow-wrap: anywhere; }
@keyframes wager-swap { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: no-preference) {
  .wager-card.spotlight { animation: wager-swap 0.35s ease-out; }
  .wager-row-item { transition: border-color 0.35s; }
}

.dice { flex: 0 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.dice-held { display: none; }
.dice-dense { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.dice-dense .roll { gap: 12px; padding: 8px 12px; }
.dice-dense .roll-total { font-size: 56px; }
.dice-dense .roll-detail { gap: 0; }
.dice-dense .roll-head { gap: 10px; }
.dice-dense .roll-name { font-size: 24px; line-height: 1.1; }
.dice-dense .roll-breakdown { font-size: 24px; line-height: 1.1; }
.dice-dense .roll-band { font-size: 24px; line-height: 1.1; }
.dice-dense .roll-symbol { min-width: 28px; margin-right: 8px; }
.roll {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px; min-width: 0; margin: 0;
  box-sizing: border-box; overflow: hidden;
  border: 1px solid #6c6446; border-radius: 16px; background: rgba(39, 41, 31, 0.9);
}
.roll-total { flex: 0 0 auto; font-size: 72px; line-height: 1; font-family: Georgia, 'Times New Roman', serif; color: var(--gold, #ddba76); }
.roll-detail { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.roll-wide { grid-column: 1 / -1; }
.roll-head { display: flex; align-items: baseline; gap: 14px; min-width: 0; }
.roll-name { flex: 0 1 auto; min-width: 0; font-size: 28px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.roll-breakdown { flex: 0 100000 auto; min-width: 0; font-size: 26px; color: var(--muted, #a7b2ac); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.roll-band { display: flex; align-items: baseline; min-width: 0; font-size: 28px; white-space: nowrap; }
.roll-result { flex: none; }
.roll-symbol { flex: none; display: inline-block; min-width: 32px; margin-right: 10px; text-align: center; font-weight: 700; color: var(--teal, #91c8b6); border: 2px solid currentColor; border-radius: 8px; line-height: 1.1; }
.roll[data-band='setback'] .roll-symbol { color: #edc98d; }

.lines {
  flex: 1 1 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-start; gap: 20px;
  padding: 6px; margin: -6px;
}
.line { flex: 0 0 auto; border-radius: 12px; padding: 4px 12px; transition: opacity 0.2s; }
.line-who { display: flex; align-items: baseline; gap: 14px; }
.line-who.with-portrait { align-items: center; }
.line-portrait { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
.line-name { font-size: max(24px, calc(30px * var(--fit, 1))); font-weight: 700; }
.line-role { font-size: 24px; color: var(--muted, #a7b2ac); text-transform: uppercase; letter-spacing: 0.08em; }
.line-text { font-family: Georgia, 'Times New Roman', serif; font-size: calc(48px * var(--fit, 1)); line-height: 1.25; white-space: pre-wrap; overflow-wrap: anywhere; }
.line.narration .line-text, .line.system .line-text { font-size: calc(40px * var(--fit, 1)); color: #eeeee6; }
.line.player_dialogue .line-name, .line.player_dialogue .line-text { color: var(--teal, #91c8b6); }
.line.npc_dialogue .line-name, .line.npc_dialogue .line-text { color: var(--gold, #ddba76); }
.lines.has-active .line:not(.speaking):not(.player_dialogue) { opacity: 0.45; }
.line.speaking { box-shadow: 0 0 0 4px var(--gold, #ddba76); }
.line.off-page { display: none; }
.page-marker { position: absolute; right: 0; bottom: 0; font-size: 24px; line-height: 1.25; color: var(--muted, #a7b2ac); }

.rail { position: absolute; left: 1360px; top: 170px; width: 464px; height: 630px; display: flex; flex-direction: column; gap: 20px; overflow: hidden; }
.meters { flex: 0 0 auto; display: flex; flex-direction: column; gap: 14px; }
.meter-top { display: flex; justify-content: space-between; gap: 12px; }
.meter-label { font-size: 30px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.meter-count { font-size: 30px; color: var(--gold, #ddba76); }
.meter-bottom { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 4px; }
.meter-kind { font-size: 24px; color: var(--muted, #a7b2ac); }
.pips { display: inline-flex; gap: 6px; }
.pip { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #6c7a72; background: transparent; }
.pip.filled { background: var(--gold, #ddba76); border-color: var(--gold, #ddba76); }
.rail.with-picture .meters { gap: 8px; }
.meter-compact { height: 30px; }
.meter-line { display: flex; align-items: center; gap: 12px; height: 30px; }
.meter-line .meter-label { flex: 1 1 0; font-size: 26px; line-height: 30px; }
.meter-line .pips { flex: 0 0 auto; gap: 4px; }
.meter-line .pip { width: 14px; height: 14px; }
.meter-line .meter-count { flex: 0 0 auto; font-size: 26px; line-height: 30px; }
.facts { flex: 1 1 0; min-height: 0; overflow: hidden; }
.fact { font-size: 26px; line-height: 1.3; margin-bottom: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.rail.with-picture { top: 455px; height: 345px; }
.about { flex: 0 0 auto; }
.about-text { font-size: 26px; line-height: 1.3; color: var(--muted, #a7b2ac); display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }

.party { position: absolute; left: 96px; top: 830px; width: 1728px; height: 125px; display: flex; gap: 16px; align-items: stretch; }
.party-card { flex: 1 1 0; max-width: 340px; min-width: 0; display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: rgba(28, 37, 30, 0.9); border: 1px solid var(--line, #35403b); border-radius: 16px; }
.initials { flex: 0 0 auto; display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: #343c31; color: #e3c58e; font-family: Georgia, 'Times New Roman', serif; font-size: 28px; }
.party-portrait { flex: 0 0 auto; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; }
.party-text { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.party-name { font-size: 30px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.party-strain { display: flex; align-items: center; gap: 12px; }
.needs-help { font-size: 24px; color: #edc98d; white-space: nowrap; }
.crowded .party-card { max-width: none; }

.scene-picture { position: absolute; left: 1360px; top: 170px; width: 464px; height: 265px; margin: 0; z-index: 5; overflow: hidden; border-radius: 16px; border: 1px solid var(--line, #35403b); background: #121815; transform-origin: 0 0; }
.scene-picture img { display: block; width: 100%; height: 100%; object-fit: cover; }
.scene-picture.revealing { z-index: 30; border-radius: 0; border-color: transparent; transform: translate(-1360px, -170px) scale(4.138); }
.scene-picture.shrinking { z-index: 30; }
.scene-reveal-titles { position: absolute; inset: 0; z-index: 31; display: flex; flex-direction: column; justify-content: flex-end; gap: 12px; padding: 0 96px 120px; background: linear-gradient(rgba(8, 10, 9, 0) 55%, rgba(8, 10, 9, 0.75)); }
.reveal-show { font-size: 44px; color: #eeeee6; }
.reveal-scene { font-family: Georgia, 'Times New Roman', serif; font-size: 72px; color: var(--gold, #ddba76); }
@keyframes picture-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .scene-picture { transition: transform 900ms ease-in-out, border-radius 900ms ease-in-out; }
  .scene-picture.revealing { animation: picture-in 400ms ease-out; }
}

.correction { position: absolute; left: 96px; top: 965px; width: 1728px; height: 55px; display: flex; gap: 16px; align-items: flex-start; overflow: hidden; }
.correction-tag { flex: 0 0 auto; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--gold, #ddba76); }
.correction-text { flex: 1 1 0; min-width: 0; font-size: 24px; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
</style>
