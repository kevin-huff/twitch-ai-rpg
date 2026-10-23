import { reactive } from 'vue';
import {
  AudioManifestSchema, PlaybackResponseSchema, PlaybackSnapshotSchema,
  PLAYBACK_POSITION_REPORT_MS, PLAYBACK_SEEK_THRESHOLD_MS, PRESENTER_RENEW_MS,
  type AudioManifest, type PlaybackCommand, type PlaybackSnapshot,
} from '../../../packages/contracts/src/playback';
import { getIdentity, identityHeaders, identityPath } from './identity';

type Context = { sessionId: string; beatId?: string; director: boolean; stage?: boolean };
type AudioStatus = 'missing' | 'preparing' | 'ready' | 'unavailable';
type SharedCommand = PlaybackCommand['type'];
type Lease = { id: string; deadline: number; generation: number };

export function createPlaybackController(initial: Context) {
  let context = { ...initial };
  const state = reactive({
    snapshot: null as PlaybackSnapshot | null, manifest: null as AudioManifest | null,
    audioStatus: 'missing' as AudioStatus, preparing: false, commandPending: false,
    listening: false, presenting: false, muted: true, volume: 1, error: '',
  });
  const clientId = crypto.randomUUID();
  let identity: string | undefined;
  let disposed = false;
  let contextGeneration = 0;
  let responseGeneration = 0;
  let manifestGeneration = 0;
  let audioGeneration = 0;
  let leaseGeneration = 0;
  let renewalSequence = 0;
  let telemetrySequence = 0;
  let pollSequence = 0;
  let successfulPollSequence = 0;
  let activePolls = 0;
  let claimingGeneration: number | null = null;
  let renewing: Lease | null = null;
  let lease: Lease | null = null;
  let audio: HTMLAudioElement | null = null;
  let audioKey = '';
  let blockedKey = '';
  let started = false;
  let sampleClock = { server: 0, local: 0 };
  let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  const requests = new Set<AbortController>();
  const now = () => performance.now();
  const endpoint = () => `/api/sessions/${encodeURIComponent(context.sessionId)}/playback`;

  function halt() {
    audioGeneration++;
    clearTimeout(scheduleTimer); scheduleTimer = undefined;
    if (audio) {
      audio.onended = null; audio.onerror = null; audio.onloadedmetadata = null;
      audio.pause(); audio.src = ''; audio.load(); audio = null;
    }
    audioKey = ''; started = false;
  }

  function dropLease(message = '') {
    leaseGeneration++; lease = null; state.presenting = false;
    clearTimeout(expiryTimer); clearInterval(renewTimer);
    expiryTimer = undefined; renewTimer = undefined;
    if (context.stage) { state.listening = false; state.muted = true; halt(); }
    if (message) state.error = message;
  }

  function reset() {
    contextGeneration++; responseGeneration++; manifestGeneration++;
    requests.forEach(request => request.abort()); requests.clear();
    dropLease(); halt(); blockedKey = '';
    state.snapshot = null; state.manifest = null; state.audioStatus = 'missing';
    state.preparing = false; state.commandPending = false;
    state.listening = false; state.muted = true;
  }

  function checkIdentity() {
    if (disposed) return false;
    try {
      const selected = getIdentity();
      if (selected !== identity) { reset(); identity = selected; }
      return true;
    } catch (cause) {
      reset(); state.error = cause instanceof Error ? cause.message : 'This tab’s identity is invalid.';
      return false;
    }
  }

  async function request(path: string, body?: unknown, timeoutMs = 5000) {
    const start = now();
    const abort = new AbortController(); requests.add(abort);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Audio connection timed out. Reclaim audio or try Listen again.'));
        abort.abort();
      }, timeoutMs);
      abort.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Audio request cancelled.'));
      }, { once: true });
    });
    try {
      return await Promise.race([interrupted, (async () => {
        const result = await fetch(path, {
          credentials: 'same-origin', signal: abort.signal,
          headers: { ...identityHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        });
        const data: unknown = await result.json();
        if (!result.ok) {
          const message = data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : 'Reviewed audio is unavailable.';
          throw Object.assign(new Error(message), { status: result.status });
        }
        return { data, start, end: now() };
      })()]);
    } finally { clearTimeout(timeout); requests.delete(abort); }
  }

  function validManifest(manifest: AudioManifest) {
    const prefix = `/api/sessions/${encodeURIComponent(context.sessionId)}/audio/assets/`;
    return manifest.segments.every(segment => segment.url.startsWith(prefix));
  }

  function accept(snapshot: PlaybackSnapshot, start: number, end: number) {
    if (snapshot.sessionId !== context.sessionId || (snapshot.manifest && !validManifest(snapshot.manifest))) {
      state.snapshot = null; halt(); throw new Error('The reviewed playback manifest could not be loaded.');
    }
    const current = state.snapshot;
    if (current && (snapshot.sampleRevision < current.sampleRevision ||
      (snapshot.sampleRevision === current.sampleRevision && snapshot.serverTimeMs < current.serverTimeMs))) return false;
    state.snapshot = snapshot;
    sampleClock = { server: snapshot.serverTimeMs, local: start + (end - start) / 2 };
    synchronize();
    return true;
  }

  function liveLease() {
    if (!lease) return false;
    if (now() >= lease.deadline) { dropLease('Presenter lease expired. Reclaim audio and ask the director to resume.'); return false; }
    return true;
  }

  function allowed() {
    return !disposed && !state.commandPending && state.listening && !state.muted && (!context.stage || liveLease());
  }

  function currentKey(snapshot: PlaybackSnapshot) { return `${snapshot.playbackId}/${snapshot.revision}/${snapshot.segmentIndex}`; }
  function position(snapshot: PlaybackSnapshot) {
    const serverNow = sampleClock.server + Math.max(0, now() - sampleClock.local);
    const untilAnchor = snapshot.anchorTimeMs === null ? 0 : snapshot.anchorTimeMs - serverNow;
    return { delay: Math.max(0, untilAnchor), seconds: (snapshot.positionMs + Math.max(0, -untilAnchor)) / 1000 };
  }

  function synchronize() {
    const snapshot = state.snapshot;
    if (!allowed() || !snapshot || snapshot.status !== 'playing' || !snapshot.manifest || snapshot.segmentIndex === null) {
      if (audio || scheduleTimer) halt();
      return;
    }
    const key = currentKey(snapshot);
    if (key === blockedKey) return;
    const timing = position(snapshot);
    if (key === audioKey && audio) {
      if (started && !state.presenting && Math.abs(audio.currentTime - timing.seconds) * 1000 > PLAYBACK_SEEK_THRESHOLD_MS) seek(audio, timing.seconds);
      return;
    }
    halt();
    getIdentity();
    const clip = new Audio(identityPath(snapshot.manifest.segments[snapshot.segmentIndex].url));
    audio = clip; audioKey = key; clip.volume = state.volume; clip.muted = state.muted; clip.preload = 'auto';
    const generation = audioGeneration;
    const owner = lease?.id;
    const valid = () => checkIdentity() && generation === audioGeneration && audio === clip && allowed() &&
      state.snapshot !== null && currentKey(state.snapshot) === key && (!context.stage || lease?.id === owner);
    const seekCurrent = () => { if (valid()) seek(clip, position(state.snapshot!).seconds); };
    clip.onloadedmetadata = seekCurrent;
    seekCurrent();
    clip.onended = () => {
      if (!valid() || !started) return;
      const report = telemetry('ended'); blockedKey = key; halt(); void report;
    };
    clip.onerror = () => { if (valid()) playbackFailed(key); };
    const startClip = () => {
      if (!checkIdentity() || !valid()) return;
      const delay = position(state.snapshot!).delay;
      if (delay > 0) {
        scheduleTimer = setTimeout(() => { scheduleTimer = undefined; startClip(); }, delay);
        return;
      }
      seekCurrent();
      try {
        const playing = clip.play();
        void Promise.resolve(playing).then(() => {
          if (!valid()) { clip.pause(); return; }
          started = true;
        }, () => { if (valid()) playbackFailed(key); });
      } catch { if (valid()) playbackFailed(key); }
    };
    clip.load(); startClip();
  }

  function seek(clip: HTMLAudioElement, seconds: number) {
    try { clip.currentTime = seconds; } catch { /* Metadata callback retries once the clip is seekable. */ }
  }

  function playbackFailed(key: string) {
    const report = telemetry('error'); blockedKey = key; halt();
    if (!context.stage) { state.listening = false; state.muted = true; }
    state.error = context.stage
      ? 'Playback could not start or the audio was interrupted. Check browser audio permission. Release audio, choose Present audio again, then ask the director to resume.'
      : 'Playback could not start or the audio was interrupted. Check browser audio permission and try Listen again.';
    void report;
  }

  function failed(cause: unknown, generation: number) {
    if (!checkIdentity() || generation !== contextGeneration) return;
    halt(); state.listening = false; state.muted = true;
    if (lease) dropLease('Audio connection lost. Reclaim audio and ask the director to resume.');
    else state.error = cause instanceof Error ? cause.message : 'Reviewed audio is unavailable. Try Listen again.';
  }

  async function refresh() {
    if (!checkIdentity() || state.commandPending) return;
    const generation = contextGeneration, fence = responseGeneration, sequence = ++pollSequence;
    activePolls++;
    try {
      const result = await request(endpoint());
      if (!checkIdentity() || generation !== contextGeneration || fence !== responseGeneration) return;
      if (accept(PlaybackSnapshotSchema.parse(result.data), result.start, result.end)) successfulPollSequence = Math.max(successfulPollSequence, sequence);
    } catch (cause) { if (fence === responseGeneration && sequence >= successfulPollSequence) failed(cause, generation); }
    finally { activePolls--; }
  }

  async function loadManifest(prepare = false) {
    if (!checkIdentity() || !context.beatId || (prepare && !context.director)) return;
    const generation = contextGeneration, manifestRequest = ++manifestGeneration, beat = context.beatId;
    if (prepare) { state.preparing = true; state.error = ''; }
    try {
      const path = `/api/sessions/${encodeURIComponent(context.sessionId)}/audio/${encodeURIComponent(beat)}`;
      const result = await request(path, prepare ? { commandId: crypto.randomUUID() } : undefined, prepare ? 300_000 : 5000);
      if (!checkIdentity() || generation !== contextGeneration || manifestRequest !== manifestGeneration) return;
      const data = result.data as { status?: unknown; manifest?: unknown };
      if (!data || !['missing', 'preparing', 'ready', 'unavailable'].includes(String(data.status))) throw new Error('The reviewed audio manifest could not be loaded.');
      state.audioStatus = data.status as AudioStatus; state.manifest = null;
      if (data.status === 'ready') {
        const manifest = AudioManifestSchema.parse(data.manifest);
        if (manifest.beatId !== beat || !validManifest(manifest)) throw new Error('The reviewed audio manifest could not be loaded.');
        state.manifest = manifest;
      }
    } catch (cause) {
      if (checkIdentity() && generation === contextGeneration && manifestRequest === manifestGeneration) state.error = cause instanceof Error ? cause.message : 'Reviewed speech is unavailable.';
    } finally {
      if (!disposed && generation === contextGeneration && manifestRequest === manifestGeneration) state.preparing = false;
    }
  }

  function listen() {
    if (!checkIdentity() || context.stage || !state.snapshot) return;
    state.listening = true; state.muted = false; state.error = ''; blockedKey = ''; halt(); synchronize();
  }
  function mute() { state.listening = false; state.muted = true; halt(); }
  function setVolume(value: number) {
    state.volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    if (audio) audio.volume = state.volume;
  }

  async function command(type: SharedCommand, startBeatId = context.beatId) {
    if (!checkIdentity() || !context.director || !state.snapshot || state.commandPending) return;
    if (type === 'start' && !startBeatId) return;
    const current = state.snapshot;
    if (type !== 'start' && !current.playbackId) return;
    const body = { type, commandId: crypto.randomUUID(), expectedRevision: current.revision,
      ...(type === 'start' ? { beatId: startBeatId } : { playbackId: current.playbackId }) };
    const generation = contextGeneration, fence = ++responseGeneration;
    state.commandPending = true; state.error = ''; blockedKey = ''; halt();
    try {
      const result = await request(`${endpoint()}/commands`, body);
      if (!checkIdentity() || generation !== contextGeneration || fence !== responseGeneration) return;
      state.commandPending = false;
      accept(PlaybackResponseSchema.parse(result.data).snapshot, result.start, result.end);
    } catch (cause) { if (fence === responseGeneration) failed(cause, generation); }
    finally { if (!disposed && generation === contextGeneration && fence === responseGeneration) state.commandPending = false; }
  }

  function setLease(id: string, snapshot: PlaybackSnapshot, requestStart: number, generation: number) {
    const deadline = Math.max(lease?.id === id ? lease.deadline : 0,
      requestStart + Math.max(0, (snapshot.presenter.leaseExpiresAtMs ?? snapshot.serverTimeMs) - snapshot.serverTimeMs));
    if (!snapshot.presenter.available || deadline <= now()) {
      dropLease('Presenter lease expired. Reclaim audio and ask the director to resume.'); return;
    }
    lease = { id, deadline, generation }; state.presenting = true;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { liveLease(); }, Math.max(0, deadline - now()));
  }

  async function claim() {
    if (!checkIdentity() || !context.stage || !state.snapshot || claimingGeneration === contextGeneration || liveLease()) return;
    const generation = contextGeneration, ownerGeneration = ++leaseGeneration, fence = ++responseGeneration;
    claimingGeneration = generation;
    state.error = '';
    try {
      const result = await request(`${endpoint()}/presenter`, {
        type: 'claim', commandId: crypto.randomUUID(), expectedRevision: state.snapshot.revision, clientId,
      });
      if (!checkIdentity() || generation !== contextGeneration || ownerGeneration !== leaseGeneration || fence !== responseGeneration) return;
      const data = PlaybackResponseSchema.parse(result.data);
      if (!data.leaseId) throw new Error('Presenter lease was not granted. Try Present audio again.');
      accept(data.snapshot, result.start, result.end);
      setLease(data.leaseId, data.snapshot, result.start, ownerGeneration);
      if (!lease) return;
      renewalSequence = 0; telemetrySequence = 0;
      state.listening = true; state.muted = false; blockedKey = '';
      clearInterval(renewTimer); renewTimer = setInterval(() => { void renew(); }, PRESENTER_RENEW_MS);
      synchronize();
    } catch (cause) { if (ownerGeneration === leaseGeneration && fence === responseGeneration) failed(cause, generation); }
    finally { if (claimingGeneration === generation) claimingGeneration = null; }
  }

  async function renew() {
    if (!checkIdentity() || !liveLease() || renewing === lease) return;
    const owner = lease!, generation = contextGeneration;
    renewing = owner;
    try {
      const result = await request(`${endpoint()}/presenter`, {
        type: 'renew', commandId: crypto.randomUUID(), clientId, leaseId: owner.id, renewalSequence: ++renewalSequence,
      });
      if (!checkIdentity() || generation !== contextGeneration || lease !== owner || owner.generation !== leaseGeneration) return;
      if (!liveLease()) return;
      const data = PlaybackResponseSchema.parse(result.data);
      if (data.leaseId && data.leaseId !== owner.id) throw new Error('Presenter lease was lost. Reclaim audio and ask the director to resume.');
      accept(data.snapshot, result.start, result.end);
      setLease(owner.id, data.snapshot, result.start, owner.generation);
    } catch (cause) { if (lease === owner) failed(cause, generation); }
    finally { if (renewing === owner) renewing = null; }
  }

  async function release() {
    if (!checkIdentity() || !lease) return;
    const owner = lease, generation = contextGeneration, fence = ++responseGeneration;
    dropLease(); halt();
    try {
      const result = await request(`${endpoint()}/presenter`, { type: 'release', commandId: crypto.randomUUID(), clientId, leaseId: owner.id });
      if (!checkIdentity() || generation !== contextGeneration || fence !== responseGeneration) return;
      accept(PlaybackResponseSchema.parse(result.data).snapshot, result.start, result.end);
    } catch (cause) { if (fence === responseGeneration) failed(cause, generation); }
  }

  async function telemetry(type: 'position' | 'ended' | 'error') {
    if (!checkIdentity() || !liveLease() || !state.snapshot || !audio || (type !== 'error' && !started)) return;
    const snapshot = state.snapshot, owner = lease!, generation = contextGeneration, fence = responseGeneration;
    if (!snapshot.playbackId || snapshot.segmentIndex === null || snapshot.status !== 'playing' || (type !== 'error' && position(snapshot).delay > 0)) return;
    const key = currentKey(snapshot);
    try {
      const result = await request(`${endpoint()}/telemetry`, {
        type, commandId: crypto.randomUUID(), clientId, leaseId: owner.id, playbackId: snapshot.playbackId,
        expectedRevision: snapshot.revision, segmentIndex: snapshot.segmentIndex, telemetrySequence: ++telemetrySequence,
        ...(type === 'position' ? { positionMs: Math.min(3_600_000, Math.max(0, Math.round(audio.currentTime * 1000))) } : {}),
      });
      if (!checkIdentity() || generation !== contextGeneration || fence !== responseGeneration || lease !== owner || !liveLease() || !state.snapshot || currentKey(state.snapshot) !== key) return;
      accept(PlaybackResponseSchema.parse(result.data).snapshot, result.start, result.end);
    } catch (cause) {
      if (!checkIdentity() || generation !== contextGeneration || fence !== responseGeneration || lease !== owner || !state.snapshot || currentKey(state.snapshot) !== key) return;
      if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 409) await refresh();
      else failed(cause, generation);
    }
  }

  function setContext(next: Context) {
    if (disposed) return;
    const changed = next.sessionId !== context.sessionId || next.director !== context.director || Boolean(next.stage) !== Boolean(context.stage);
    const beatChanged = next.beatId !== context.beatId;
    if (changed) reset();
    context = { ...next };
    if (changed) void refresh();
    if (changed || beatChanged) { manifestGeneration++; state.manifest = null; state.audioStatus = 'missing'; state.preparing = false; void loadManifest(); }
  }

  function dispose() {
    if (disposed) return;
    reset(); disposed = true; clearInterval(pollTimer); clearInterval(positionTimer); clearInterval(manifestTimer);
  }

  try { identity = getIdentity(); } catch { /* Refresh exposes invalid identities without starting audio. */ }
  let pollTicks = 0;
  const pollTimer = setInterval(() => {
    pollTicks++;
    if (activePolls === 0 && (state.listening || state.presenting || pollTicks % 4 === 0)) void refresh();
  }, 250);
  const positionTimer = setInterval(() => { void telemetry('position'); }, PLAYBACK_POSITION_REPORT_MS);
  const manifestTimer = setInterval(() => { if (state.audioStatus !== 'ready' && !state.preparing) void loadManifest(); }, 3000);
  void refresh(); void loadManifest();
  return { state, refresh, prepare: () => loadManifest(true), listen, mute, setVolume, command,
    replay: () => state.snapshot?.manifest ? command('start', state.snapshot.manifest.beatId) : Promise.resolve(),
    claim, release, setContext, dispose };
}
