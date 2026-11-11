import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import { FRAME_MS, diceSchedule, shouldPlayMoment, type DiceSchedule } from './dice-moment';
import { slateKind, sortRolls } from './stage-format';

// before is the last snapshot the page had before this beat arrived: the stage keeps showing it until the dice land.
export type ActiveMoment = { beatId: string; startedAt: number; schedule: DiceSchedule; before: SessionSnapshot };

// The stage while the dice roll: everything as it was before the publish (strain, Down and Dead, tracks, facts,
// corrections, pictures, the scene and the captions), so nothing gives a result away before its die lands.
// Only the published beat's id and rolls come through, because the dice need them, and the show's current status,
// so a pause or the end still shows its slate.
export function heldStage(current: SessionSnapshot, before: SessionSnapshot): SessionSnapshot {
  const latest = current.history.at(-1);
  const shownLines = before.history.at(-1)?.segments ?? [];
  return {
    ...current,
    session: { ...before.session, status: current.session.status },
    characters: before.characters,
    npcs: before.npcs,
    tracks: before.tracks,
    facts: before.facts,
    corrections: before.corrections,
    picturesEnabled: before.picturesEnabled,
    scenePicture: before.scenePicture,
    pinnedPicture: before.pinnedPicture,
    history: latest ? [...current.history.slice(0, -1), { ...latest, segments: shownLines }] : current.history,
  } as SessionSnapshot;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The page's memory of which published beat it has already shown. The first snapshot counts as seen, so a reload,
// a reconnect or a page opened mid-round never replays a roll; a later new beat with fresh rolls starts a moment.
export function useDiceMoment(snapshot: Ref<SessionSnapshot | null>, options: { reducedMotion?: () => boolean } = {}) {
  const moment = shallowRef<ActiveMoment | null>(null);
  const elapsed = ref(0);
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  let seen: string | null | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function clear() {
    clearInterval(timer);
    timer = undefined;
    moment.value = null;
    elapsed.value = 0;
  }

  // The end is decided by the clock, not by counting ticks, so a page whose timers were held back ends on its next tick.
  function tick() {
    const current = moment.value;
    if (!current) return;
    elapsed.value = Date.now() - current.startedAt;
    if (elapsed.value >= current.schedule.endAt) clear();
  }

  watch(snapshot, (next, previous) => {
    if (!next) return;
    const latest = next.history.at(-1) ?? null;
    const id = latest?.id ?? null;
    if (seen === undefined || slateKind(next)) {
      if (seen !== undefined) clear();
      seen = id;
      return;
    }
    if (id === seen) return;
    seen = id;
    clear();
    if (!latest || reducedMotion() || !shouldPlayMoment(latest, Date.now())) return;
    moment.value = { beatId: latest.id, startedAt: Date.now(), schedule: diceSchedule(sortRolls(latest.rolls, next.characters)), before: previous ?? next };
    timer = setInterval(tick, FRAME_MS);
  }, { immediate: true });

  onScopeDispose(() => clearInterval(timer));
  return { moment, elapsed };
}
