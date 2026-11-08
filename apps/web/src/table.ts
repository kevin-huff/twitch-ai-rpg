import { computed, inject, provide, ref } from 'vue';
import type { InjectionKey } from 'vue';
import { LAST_CHANCE_STRAIN, RESCUE_STRAIN, STRAIN_MAX, incidentKey, strainStep } from '@rpg/contracts';
import type { CharacterCondition, Command, DirectorSnapshot, Effect, PlayerSnapshot, Resolution, SessionSnapshot } from '@rpg/contracts';
import { api, subscribeToSession } from './api';
import { identityPath, selectIdentity } from './identity';

export const PAUSE_REQUEST_TEXT = 'Pause requested. Please check in with the table.';
export const AI_STILL_WORKING = 'The connection to the server closed while the AI was still working. It keeps going, and the result appears here when it finishes.';

// The host closes a request with no data moving after 5 minutes: the browser then sees a network error or a gateway status.
const droppedRequest = (cause: unknown) => cause instanceof TypeError || [502, 503, 504].includes(Number((cause as { status?: unknown } | null)?.status));

export function createTable() {
  const path = window.location.pathname;
  const route = path.match(/^\/sessions\/([^/]+)\/(play|director|stage|lobby)\/?$/);
  const sessionId = route ? decodeURIComponent(route[1]) : '';
  const view = route?.[2] ?? 'home';
  const stage = view === 'stage';
  const inviteToken = path.startsWith('/join/') ? decodeURIComponent(path.slice(6)) : '';
  const testCharacterId = view === 'play' ? new URLSearchParams(window.location.search).get('testCharacterId') : null;
  const snapshot = ref<SessionSnapshot | null>(null);
  const error = ref('');
  const notice = ref('');
  const loading = ref(true);
  const busy = ref(false);
  const beatBusy = ref(false);
  const aiWorking = ref(false);
  let aiRequests = 0;
  const connected = ref(false);
  const director = computed<DirectorSnapshot | null>(() => !stage && snapshot.value?.role === 'director' ? snapshot.value : null);
  const player = computed<PlayerSnapshot | null>(() => !stage && snapshot.value?.role === 'player' ? snapshot.value : null);
  const setup = computed(() => director.value?.setup ?? player.value?.setup);
  const latestHistory = computed(() => snapshot.value?.history.slice(-1) ?? []);
  let unsubscribe: (() => void) | undefined;
  let refreshSequence = 0;
  const listeners: Array<(next: SessionSnapshot) => void> = [];

  function onSnapshot(listener: (next: SessionSnapshot) => void) {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  const initials = (name: string) => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const nameOf = (id: string) => snapshot.value?.characters.find(character => character.id === id)?.displayName ?? 'Player';
  const phaseName = (phase: string) => ({ collecting: 'Collecting input', stakes_review: "What's at risk", locked: 'Locked · dice fixed', draft_review: 'Review script', published: 'Published', aborted: 'Aborted' })[phase] ?? phase;
  const npcNameOf = (id: string) => snapshot.value?.npcs.find(npc => npc.id === id)?.displayName ?? 'Someone';
  const strainChange = (effect: Effect) => {
    if (effect.kind !== 'strain_delta') return null;
    const character = snapshot.value?.characters.find(item => item.id === effect.characterId);
    const before = character?.strain ?? 0;
    const step = strainStep(before, character?.condition, effect.delta);
    return { before, after: step.strain, over: step.over, down: step.down };
  };
  const strainText = (name: string, before: number, after: number, over: number, down: boolean) => `${name} strain ${before} to ${after} of ${STRAIN_MAX}${down ? ' · goes down' : over > 0 ? ` · ${over} past full` : ''}`;
  const effectLabel = (effect: Effect) => {
    if (effect.kind === 'track_delta') return `${snapshot.value?.tracks.find(track => track.id === effect.trackId)?.label ?? 'Track'} ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
    if (effect.kind === 'strain_delta') {
      const change = strainChange(effect)!;
      return strainText(nameOf(effect.characterId), change.before, change.after, change.over, change.down);
    }
    if (effect.kind === 'character_down') return `${nameOf(effect.characterId)} goes down`;
    if (effect.kind === 'character_rescue') return `${nameOf(effect.characterId)} is saved: back up at ${RESCUE_STRAIN} of ${STRAIN_MAX}`;
    if (effect.kind === 'npc_death') return `${npcNameOf(effect.npcId)} dies`;
    if (effect.kind === 'fact_add') return `${effect.visibility === 'director' ? 'Private fact' : 'Fact'}: ${effect.text}`;
    if (effect.kind === 'card_add' || effect.kind === 'card_remove') {
      const name = nameOf(effect.characterId);
      const add = effect.kind === 'card_add';
      if (effect.list === 'wearing') return add ? `${name} puts on ${effect.entry}` : `${name} takes off ${effect.entry}`;
      if (effect.list === 'owes') return add ? `${name} promise or debt: ${effect.entry}` : `${name} settles: ${effect.entry}`;
      return add ? `How people feel about ${name}: ${effect.entry}` : `How people feel about ${name}, no longer: ${effect.entry}`;
    }
    if (effect.kind === 'looks_set') return `${nameOf(effect.characterId)} changed by the story: ${effect.text ? effect.text : 'cleared'}`;
    return `${nameOf(effect.characterId)} ${effect.kind === 'inventory_add' ? 'gains' : 'loses'} ${effect.item}`;
  };
  const publicationLines = (resolution: Resolution): string[] => {
    const seen = new Set<string>();
    const running = new Map<string, { start: number; strain: number; condition: CharacterCondition | undefined; over: number; down: boolean }>();
    const placed = new Set<string>();
    const lines: Array<string | { strainOf: string }> = [];
    const stateOf = (id: string) => {
      let entry = running.get(id);
      if (!entry) {
        const character = snapshot.value?.characters.find(item => item.id === id);
        entry = { start: character?.strain ?? 0, strain: character?.strain ?? 0, condition: character?.condition, over: 0, down: false };
        running.set(id, entry);
      }
      return entry;
    };
    for (const group of resolution.effectGroups ?? [resolution.effects]) {
      const fresh = group.filter(effect => {
        const key = incidentKey(effect);
        if (effect.incidentId === undefined) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const net = new Map<string, number>();
      const before = new Map<string, { strain: number; condition: CharacterCondition | undefined }>();
      for (const effect of fresh) {
        if (effect.kind !== 'strain_delta') continue;
        const entry = stateOf(effect.characterId);
        if (!net.has(effect.characterId)) before.set(effect.characterId, { strain: entry.strain, condition: entry.condition });
        net.set(effect.characterId, (net.get(effect.characterId) ?? 0) + effect.delta);
      }
      for (const [id, delta] of net) {
        const entry = stateOf(id);
        const prior = before.get(id)!;
        const step = strainStep(prior.strain, prior.condition, delta);
        entry.strain = step.strain;
        entry.over += step.over;
        if (step.down) { entry.down = true; entry.condition = 'down'; }
      }
      for (const effect of fresh) {
        if (effect.kind === 'character_down') { const entry = stateOf(effect.characterId); if (entry.condition === undefined) entry.condition = 'down'; }
        else if (effect.kind === 'character_rescue') { const entry = stateOf(effect.characterId); if (entry.condition === 'down') { entry.condition = undefined; entry.strain = RESCUE_STRAIN; } }
      }
      for (const effect of fresh) {
        if (effect.kind !== 'strain_delta') lines.push(effectLabel(effect));
        else if (!placed.has(effect.characterId)) { placed.add(effect.characterId); lines.push({ strainOf: effect.characterId }); }
      }
    }
    return lines.map(item => {
      if (typeof item === 'string') return item;
      const entry = running.get(item.strainOf)!;
      return strainText(nameOf(item.strainOf), entry.start, entry.strain, entry.over, entry.down);
    }).concat(resolution.rolls.filter(roll => roll.lastChance).map(roll => {
      const name = nameOf(roll.actorCharacterId);
      return roll.band === 'clean' || roll.band === 'costly'
        ? `${name}'s last chance: rolled ${roll.total}, pulls through at ${LAST_CHANCE_STRAIN} of ${STRAIN_MAX}`
        : `${name}'s last chance: rolled ${roll.total}, dies`;
    }));
  };
  const inputContext = () => ({ epoch: snapshot.value?.session.inputEpoch ?? 0, beatId: snapshot.value?.activeBeat && ['collecting', 'stakes_review'].includes(snapshot.value.activeBeat.phase) ? snapshot.value.activeBeat.id : null });

  async function refresh() {
    if (testCharacterId !== null) return;
    const sequence = ++refreshSequence;
    try {
      const next = await api.snapshot(sessionId, stage ? 'stage' : view === 'director' ? 'director' : view === 'play' ? 'player' : undefined);
      if (sequence !== refreshSequence) return;
      snapshot.value = next;
      for (const listener of [...listeners]) listener(next);
    } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load the show.'; }
    finally { loading.value = false; }
  }

  async function work(task: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { await task(); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
    finally { busy.value = false; }
  }

  async function beatWork(task: () => Promise<void>) {
    if (beatBusy.value) return;
    beatBusy.value = true; error.value = ''; notice.value = '';
    try { await task(); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
    finally { beatBusy.value = false; }
  }

  function aiJobRunning() {
    const beat = director.value?.activeBeat;
    return Boolean(beat && director.value?.jobs.some(job => job.beatId === beat.id && job.generation === beat.generation && ['queued', 'running'].includes(job.status)));
  }

  async function send(command: Command) {
    const aiWork = command.type === 'plan_beat' || command.type === 'render_beat';
    if (aiWork) { aiRequests++; aiWorking.value = true; }
    let result: { snapshot?: SessionSnapshot } | null | undefined;
    try { result = await api.command(sessionId, command) as { snapshot?: SessionSnapshot } | null | undefined; }
    catch (cause) {
      if (!aiWork || !droppedRequest(cause)) throw cause;
      await refresh();
      if (!aiJobRunning()) throw cause;
      notice.value = AI_STILL_WORKING;
      return;
    }
    finally { if (aiWork) { aiRequests--; aiWorking.value = aiRequests > 0; } }
    const returned = result?.snapshot;
    if (returned && testCharacterId === null && returned.role === snapshot.value?.role) {
      refreshSequence++;
      snapshot.value = returned;
      for (const listener of [...listeners]) listener(returned);
    }
    await refresh();
  }

  async function restoreSession() {
    if (testCharacterId !== null) {
      await work(async () => {
        const result = await api.testSeat(sessionId, testCharacterId);
        if (result.sessionId !== sessionId || result.role !== 'player' || result.characterId !== testCharacterId) throw new Error('The requested character seat could not be opened.');
        selectIdentity(result.identityId);
        window.location.replace(identityPath(`/sessions/${encodeURIComponent(sessionId)}/play`));
      });
      loading.value = false;
      return;
    }
    await refresh();
    if (snapshot.value && !unsubscribe) {
      try { unsubscribe = subscribeToSession(sessionId, () => { void refresh(); }, value => { connected.value = value; }); }
      catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not connect to the show.'; }
    }
  }

  function dispose() { unsubscribe?.(); }

  function requestPause() { return work(async () => {
    const captured = inputContext();
    await send({ type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, kind: 'ooc', text: PAUSE_REQUEST_TEXT, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true });
    notice.value = 'Pause requested. Say so on the voice call too.';
  }); }

  function setStatus(value: 'live' | 'paused') { return work(() => send({ type: 'set_status', commandId: crypto.randomUUID(), status: value, expectedStateRevision: snapshot.value!.session.stateRevision })); }

  return {
    path, sessionId, view, stage, inviteToken, testCharacterId,
    snapshot, error, notice, loading, busy, beatBusy, aiWorking, connected,
    director, player, setup, latestHistory,
    refresh, work, beatWork, send, restoreSession, dispose, onSnapshot,
    requestPause, setStatus,
    nameOf, initials, phaseName, effectLabel, strainChange, publicationLines, inputContext,
  };
}

export type Table = ReturnType<typeof createTable>;

const tableKey: InjectionKey<Table> = Symbol('table');

export function provideTable(table: Table) { provide(tableKey, table); }

export function useTable(): Table {
  const table = inject(tableKey, null);
  if (!table) throw new Error('The table is not provided.');
  return table;
}
