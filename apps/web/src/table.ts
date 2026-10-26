import { computed, inject, provide, ref } from 'vue';
import type { InjectionKey } from 'vue';
import type { Command, DirectorSnapshot, Effect, PlayerSnapshot, SessionSnapshot } from '@rpg/contracts';
import { api, subscribeToSession } from './api';
import { identityPath, selectIdentity } from './identity';

export const PAUSE_REQUEST_TEXT = 'Pause requested. Please check in with the table.';

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
  const phaseName = (phase: string) => ({ collecting: 'Collecting input', stakes_review: 'Review stakes', locked: 'Locked · dice fixed', draft_review: 'Review script', published: 'Published', aborted: 'Aborted' })[phase] ?? phase;
  const effectLabel = (effect: Effect) => {
    if (effect.kind === 'track_delta') return `${snapshot.value?.tracks.find(track => track.id === effect.trackId)?.label ?? 'Track'} ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
    if (effect.kind === 'strain_delta') return `${nameOf(effect.characterId)} strain ${effect.delta >= 0 ? '+' : ''}${effect.delta}`;
    if (effect.kind === 'fact_add') return `${effect.visibility === 'director' ? 'Private fact' : 'Fact'}: ${effect.text}`;
    return `${nameOf(effect.characterId)} ${effect.kind === 'inventory_add' ? 'gains' : 'loses'} ${effect.item}`;
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
    } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load the session.'; }
    finally { loading.value = false; }
  }

  async function work(task: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { await task(); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The request could not be completed.'; }
    finally { busy.value = false; }
  }

  async function send(command: Command) {
    const result = await api.command(sessionId, command) as { snapshot?: SessionSnapshot } | null | undefined;
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
      catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not connect to the session.'; }
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
    snapshot, error, notice, loading, busy, connected,
    director, player, setup, latestHistory,
    refresh, work, send, restoreSession, dispose, onSnapshot,
    requestPause, setStatus,
    nameOf, initials, phaseName, effectLabel, inputContext,
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
