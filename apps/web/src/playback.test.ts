// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../../../packages/contracts/src/playback';
import { createPlaybackController } from './playback';

const playbackId = '11111111-1111-4111-8111-111111111111';
const leaseId = '22222222-2222-4222-8222-222222222222';
const instances: FakeAudio[] = [];
class FakeAudio {
  src: string;
  currentTime = 0;
  volume = 1;
  muted = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  constructor(src: string) { this.src = src; instances.push(this); }
}
const manifest = { beatId: 'beat-1', segments: [
  { id: 'one', text: 'The door opens.', speaker: 'Narrator', voiceProfileId: 'narrator', url: `/api/sessions/show/audio/assets/${'a'.repeat(64)}` },
  { id: 'two', text: 'Who sent you?', speaker: 'Mara', voiceProfileId: 'mara', url: `/api/sessions/show/audio/assets/${'b'.repeat(64)}` },
] };
function snapshot(overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return { schemaVersion: 1, sessionId: 'show', revision: 1, sampleRevision: 1, serverTimeMs: 100_000,
    playbackId, status: 'playing', manifest, segmentIndex: 0, positionMs: 3000, anchorTimeMs: 99_000,
    presenter: { available: true, leaseExpiresAtMs: 110_000 }, ...overrides };
}
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: ReturnType<typeof createPlaybackController>[] = [];
function controller(options: { director?: boolean; stage?: boolean } = {}) {
  const value = createPlaybackController({ sessionId: 'show', beatId: 'beat-1', director: false, ...options });
  controllers.push(value); return value;
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function routeFetch(current: () => PlaybackSnapshot = () => snapshot()) {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/audio/')) return response({ status: 'ready', manifest });
    const data = current(); data.serverTimeMs += performance.now();
    if (String(url).endsWith('/presenter')) return response({ snapshot: data, leaseId });
    if (init?.method) return response({ snapshot: data });
    return response(data);
  });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); instances.length = 0;
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('Audio', FakeAudio); vi.stubGlobal('fetch', vi.fn()); routeFetch();
});
afterEach(() => { controllers.splice(0).forEach(value => value.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('coordinated browser playback', () => {
  it('mounts silently, joins at the shared offset, and keeps the pinned beat when a new beat appears', async () => {
    const value = controller(); await settle();
    expect(instances).toHaveLength(0);
    value.listen(); await settle();
    expect(instances).toHaveLength(1); expect(instances[0].currentTime).toBeCloseTo(4);
    value.setContext({ sessionId: 'show', beatId: 'beat-2', director: false }); await settle();
    expect(instances).toHaveLength(1); expect(instances[0].pause).not.toHaveBeenCalled();
    expect(value.state.snapshot?.manifest?.beatId).toBe('beat-1');
  });

  it('replays the pinned recording even when a newer published beat is unprepared', async () => {
    const value = controller({ director: true }); await settle();
    value.setContext({ sessionId: 'show', beatId: 'beat-2', director: true }); await settle();
    expect(value.state.manifest).toBeNull();
    await value.replay();
    const command = vi.mocked(fetch).mock.calls.find(call => String(call[0]).endsWith('/commands'));
    expect(JSON.parse(String(command?.[1]?.body))).toMatchObject({ type: 'start', beatId: 'beat-1' });
  });

  describe('stale command retry', () => {
    const posts = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/commands'));
    const stale = () => Object.assign(response({ message: 'Playback changed. Review the current playback state.' }, false), { status: 409 });

    it('resends once with the fresh revision and a new command id', async () => {
      const value = controller({ director: true }); await settle();
      const updated = () => snapshot({ revision: 2, sampleRevision: 2, serverTimeMs: 100_500 });
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).includes('/audio/')) return response({ status: 'ready', manifest });
        if (String(url).endsWith('/commands')) return posts().length === 1 ? stale() : response({ snapshot: updated() });
        return response(init?.method ? { snapshot: updated() } : updated());
      });
      await value.command('pause'); await settle();
      const sent = posts().map(call => JSON.parse(String(call[1]?.body)));
      expect(sent).toHaveLength(2);
      expect(sent[0].expectedRevision).toBe(1);
      expect(sent[1].expectedRevision).toBe(2);
      expect(sent[1].commandId).not.toBe(sent[0].commandId);
      expect(sent[1]).toMatchObject({ type: 'pause', playbackId });
      expect(value.state.error).toBe('');
      expect(value.state.commandPending).toBe(false);
    });

    it('does not resend when the fresh snapshot is a different playback', async () => {
      const value = controller({ director: true }); await settle();
      const other = '33333333-3333-4333-8333-333333333333';
      const changed = () => snapshot({ revision: 2, sampleRevision: 2, serverTimeMs: 100_500, playbackId: other });
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).includes('/audio/')) return response({ status: 'ready', manifest });
        if (String(url).endsWith('/commands')) return stale();
        return response(init?.method ? { snapshot: changed() } : changed());
      });
      await value.command('pause'); await settle();
      expect(posts()).toHaveLength(1);
      expect(value.state.error).toBe('Playback changed. Review the current playback state.');
      expect(value.state.snapshot?.playbackId).toBe(other);
      expect(value.state.commandPending).toBe(false);
    });

    it('retries only once when the second attempt is also stale', async () => {
      const value = controller({ director: true }); await settle();
      const updated = () => snapshot({ revision: 2, sampleRevision: 2, serverTimeMs: 100_500 });
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).includes('/audio/')) return response({ status: 'ready', manifest });
        if (String(url).endsWith('/commands')) return stale();
        return response(init?.method ? { snapshot: updated() } : updated());
      });
      await value.command('pause'); await settle();
      expect(posts()).toHaveLength(2);
      expect(value.state.error).toBe('Playback changed. Review the current playback state.');
      expect(value.state.commandPending).toBe(false);
    });
  });

  it('does not turn replay into a latest-beat start when no recording is pinned', async () => {
    routeFetch(() => snapshot({ playbackId: null, manifest: null, status: 'idle', segmentIndex: null }));
    const value = controller({ director: true }); await settle(); await value.replay();
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/commands'))).toBe(false);
  });

  it('ignores lower sample revisions and same-sample older clocks', async () => {
    const value = controller(); await settle(); value.listen(); await settle();
    const old = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(old.promise);
    const older = value.refresh();
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ sampleRevision: 8, positionMs: 6000 })));
    await value.refresh();
    old.resolve(response(snapshot({ sampleRevision: 7, status: 'stopped' }))); await older;
    expect(value.state.snapshot?.sampleRevision).toBe(8); expect(instances).toHaveLength(1);
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ sampleRevision: 8, serverTimeMs: 99_000, status: 'stopped' })));
    await value.refresh(); expect(value.state.snapshot?.status).toBe('playing');
  });

  it('stage audio requires its own live lease and a claim never starts a paused broadcast', async () => {
    let current = snapshot({ status: 'paused', anchorTimeMs: null }); routeFetch(() => current);
    const value = controller({ stage: true }); await settle();
    value.listen(); await settle(); expect(instances).toHaveLength(0);
    await value.claim(); expect(value.state.presenting).toBe(true); expect(instances).toHaveLength(0);
    current = snapshot({ revision: 2, sampleRevision: 2 }); await value.refresh(); await settle();
    expect(instances).toHaveLength(1);
    await value.release(); expect(instances[0].pause).toHaveBeenCalled();
    await value.refresh(); value.listen(); await settle(); expect(instances).toHaveLength(1);
  });

  it('keeps ordinary directors in the listener and command roles without claiming presentation', async () => {
    const value = controller({ director: true }); await settle(); await value.claim();
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/presenter'))).toBe(false);
    expect(value.state.presenting).toBe(false);
    value.listen(); await settle(); expect(instances).toHaveLength(1);
    await value.command('pause');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/commands'))).toBe(true);
  });

  it('uses a fresh memory-only client identifier for each mounted controller', async () => {
    const one = controller({ stage: true }); const two = controller({ stage: true }); await settle();
    await one.claim(); await two.claim();
    const bodies = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/presenter')).map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0].clientId).not.toBe(bodies[1].clientId);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it('expires conservatively from request start and cannot revive from a delayed claim', async () => {
    const value = controller({ stage: true }); await settle();
    const claim = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(claim.promise);
    const pending = value.claim(); await vi.advanceTimersByTimeAsync(10_001);
    claim.resolve(response({ snapshot: snapshot(), leaseId })); await pending;
    expect(value.state.presenting).toBe(false); expect(instances).toHaveLength(0);
    expect(value.state.error).toMatch(/expired|reclaim/i);
  });

  it('accepts a valid private claim overtaken by a newer-clock projection without replacing that projection', async () => {
    const value = controller({ stage: true }); await settle();
    const claim = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(claim.promise); const pending = value.claim();
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ serverTimeMs: 100_050, positionMs: 3100 })));
    await value.refresh();
    claim.resolve(response({ snapshot: snapshot(), leaseId })); await pending; await settle();
    expect(value.state.presenting).toBe(true); expect(value.state.snapshot?.positionMs).toBe(3100);
    expect(instances).toHaveLength(1);
  });

  it('serializes repeated claims so a losing duplicate cannot orphan the winning lease', async () => {
    const value = controller({ stage: true }); await settle();
    const granted = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(granted.promise);
    const one = value.claim(), two = value.claim();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/presenter'))).toHaveLength(1);
    granted.resolve(response({ snapshot: snapshot(), leaseId })); await one; await two;
    expect(value.state.presenting).toBe(true);
  });

  it('serializes slow renewals while preserving independent telemetry', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    const renewal = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/presenter') ? renewal.promise : response(String(url).endsWith('/telemetry') ? { snapshot: snapshot() } : snapshot()));
    await vi.advanceTimersByTimeAsync(4100);
    const renewals = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/presenter') && JSON.parse(String(call[1]?.body)).type === 'renew');
    expect(renewals).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/telemetry'))).toBe(true);
    renewal.resolve(response({ snapshot: snapshot({ serverTimeMs: 104_100, sampleRevision: 5, presenter: { available: true, leaseExpiresAtMs: 114_100 } }) }));
    await settle(); expect(value.state.presenting).toBe(true);
  });

  it('accepts a valid private renewal overtaken by a higher-sample projection', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    const renewal = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/presenter')) return renewal.promise;
      if (String(url).endsWith('/telemetry')) return response({ snapshot: snapshot({ sampleRevision: 10, serverTimeMs: 102_000, positionMs: 5000 }) });
      return response(snapshot({ sampleRevision: 10, serverTimeMs: 102_000, positionMs: 5000 }));
    });
    await vi.advanceTimersByTimeAsync(2000);
    renewal.resolve(response({ snapshot: snapshot({ sampleRevision: 9, serverTimeMs: 102_000, presenter: { available: true, leaseExpiresAtMs: 112_000 } }) }));
    await settle();
    routeFetch(() => snapshot({ sampleRevision: 10, serverTimeMs: 102_000, positionMs: 5000 }));
    await vi.advanceTimersByTimeAsync(8001);
    expect(value.state.presenting).toBe(true); expect(value.state.snapshot?.sampleRevision).toBe(10);
  });

  it('stops at its lease deadline even when renewal remains unresolved', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    const renew = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/presenter') ? renew.promise : response(snapshot()));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(value.state.presenting).toBe(false); expect(instances[0].pause).toHaveBeenCalled();
    renew.resolve(response({ snapshot: snapshot({ sampleRevision: 100, serverTimeMs: 110_000, presenter: { available: true, leaseExpiresAtMs: 120_000 } }), leaseId }));
    await settle(); expect(value.state.presenting).toBe(false); expect(instances).toHaveLength(1);
  });

  it('uses independent increasing renewal and telemetry sequences and actual currentTime', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    instances[0].currentTime = 7.25;
    await vi.advanceTimersByTimeAsync(4100);
    const bodies = vi.mocked(fetch).mock.calls.filter(call => call[1]?.method).map(call => JSON.parse(String(call[1]?.body)));
    const renewals = bodies.filter(body => body.type === 'renew');
    const reports = bodies.filter(body => body.type === 'position');
    expect(renewals.map(body => body.renewalSequence)).toEqual([1, 2]);
    expect(reports.map(body => body.telemetrySequence)).toEqual([1, 2, 3, 4]);
    expect(reports[0].positionMs).toBe(7250);
  });

  it('retains a live lease when renewal receipts omit the claim-only lease identifier', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    vi.mocked(fetch).mockImplementation(async url => {
      const current = snapshot({ sampleRevision: 2, serverTimeMs: 102_000, presenter: { available: true, leaseExpiresAtMs: 112_000 } });
      return response(String(url).endsWith('/playback') ? current : { snapshot: current });
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.state.presenting).toBe(true); expect(instances[0].pause).not.toHaveBeenCalled();
  });

  it('refreshes an expected stale telemetry conflict while retaining a valid presenter', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    let conflict = false;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/telemetry')) { conflict = true; return { ...response({ message: 'Playback revision changed.' }, false), status: 409 } as Response; }
      return response(conflict ? snapshot({ revision: 2, sampleRevision: 3, status: 'paused', anchorTimeMs: null }) : snapshot());
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.state.presenting).toBe(true); expect(value.state.snapshot?.status).toBe('paused');
    expect(value.state.error).toBe('');
  });

  it('does not silence a successful newer poll when an older request fails later', async () => {
    const value = controller(); await settle(); value.listen(); await settle();
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise); const pending = value.refresh();
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ sampleRevision: 4 }))); await value.refresh();
    old.reject(new Error('obsolete network error')); await pending;
    expect(value.state.listening).toBe(true); expect(instances[0].pause).not.toHaveBeenCalled();
    expect(value.state.error).toBe('');
  });

  it('bounds a hanging listener request and ignores its late reply without overlapping polls', async () => {
    const value = controller(); await settle(); value.listen(); await settle();
    const delayed = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(delayed.promise);
    const count = vi.mocked(fetch).mock.calls.length;
    const pending = value.refresh(); await vi.advanceTimersByTimeAsync(4999);
    expect(vi.mocked(fetch).mock.calls.length).toBe(count + 1);
    expect(value.state.listening).toBe(true);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(value.state.listening).toBe(false); expect(instances[0].pause).toHaveBeenCalled();
    expect(value.state.error).toMatch(/timed out/i);
    delayed.resolve(response(snapshot({ sampleRevision: 100 }))); await settle();
    expect(instances).toHaveLength(1); expect(value.state.listening).toBe(false);
  });

  it('preloads a future segment while gating playback and position telemetry until its anchor', async () => {
    routeFetch(() => snapshot({ anchorTimeMs: 100_500, positionMs: 0 }));
    const value = controller({ stage: true }); await settle(); await value.claim();
    expect(instances).toHaveLength(1); expect(instances[0].play).not.toHaveBeenCalled();
    instances[0].onloadedmetadata!();
    await vi.advanceTimersByTimeAsync(499); expect(instances[0].play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(instances[0].play).toHaveBeenCalledOnce();
    expect(instances[0].currentTime).toBe(0);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/telemetry'))).toBe(false);
  });

  it('catches up if metadata arrives after the scheduled anchor', async () => {
    routeFetch(() => snapshot({ anchorTimeMs: 100_500, positionMs: 0 }));
    const value = controller(); await settle(); value.listen(); await settle();
    expect(instances).toHaveLength(1); expect(instances[0].play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900); instances[0].onloadedmetadata!();
    expect(instances[0].currentTime).toBeCloseTo(.4);
  });

  describe('listener drift', () => {
    // The clip plays in step with fake time; any assignment to currentTime is a seek.
    function track(clip: FakeAudio) {
      const seeks: number[] = [];
      let time = clip.currentTime;
      Object.defineProperty(clip, 'currentTime', { get: () => time, set: (value: number) => { seeks.push(value); time = value; } });
      return { seeks, play: (seconds: number) => { time += seconds; } };
    }
    async function run(clip: ReturnType<typeof track>, ms: number, playing = true) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) { if (playing) clip.play(.25); await vi.advanceTimersByTimeAsync(250); }
    }

    it('keeps playing through one slow reply instead of jumping back', async () => {
      const value = controller(); await settle(); value.listen(); await settle();
      const clip = track(instances[0]);
      await run(clip, 2000);
      vi.mocked(fetch).mockImplementationOnce(async () => {
        const data = snapshot(); data.serverTimeMs += performance.now();
        await new Promise(resolve => setTimeout(resolve, 3000));
        return response(data);
      });
      await run(clip, 5000);
      expect(clip.seeks).toEqual([]);
      expect(instances).toHaveLength(1);
    });

    it('still catches up once the clip stays out of step', async () => {
      const value = controller(); await settle(); value.listen(); await settle();
      const clip = track(instances[0]);
      await run(clip, 2250, false);
      expect(clip.seeks).toEqual([]);
      await run(clip, 250, false);
      expect(clip.seeks).toHaveLength(1);
      expect(clip.seeks[0]).toBeCloseTo(6.5);
    });
  });

  it('reports presenter preload failure before the anchor without position telemetry', async () => {
    routeFetch(() => snapshot({ anchorTimeMs: 100_500, positionMs: 0 }));
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    expect(instances).toHaveLength(1); instances[0].onerror!(); await settle();
    const reports = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/telemetry'));
    expect(reports).toHaveLength(1); expect(JSON.parse(String(reports[0][1]?.body)).type).toBe('error');
    expect(value.state.error).toContain('Release audio'); expect(value.state.error).not.toContain('Listen');
  });

  it('keeps a single slow preparation request pending beyond the coordinator timeout', async () => {
    const value = controller({ director: true }); await settle();
    const delayed = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(delayed.promise);
    const pending = value.prepare(); await vi.advanceTimersByTimeAsync(6000);
    expect(value.state.preparing).toBe(true); expect(value.state.error).toBe('');
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes('/audio/') && call[1]?.method)).toHaveLength(1);
    delayed.resolve(response({ status: 'ready', manifest })); await pending;
    expect(value.state.preparing).toBe(false); expect(value.state.audioStatus).toBe('ready');
  });

  describe('presenter clip end', () => {
    const ends = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/telemetry') && JSON.parse(String(call[1]?.body)).type === 'ended');
    // Serves the playback snapshot of the moment; the server moves to the next segment when it receives a clip end it accepts.
    function server(acceptEnd: (attempt: number) => boolean) {
      let current = snapshot();
      let attempts = 0;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).includes('/audio/')) return response({ status: 'ready', manifest });
        const stamped = () => ({ ...current, serverTimeMs: 100_000 + performance.now() });
        if (String(url).endsWith('/presenter')) return response({ snapshot: stamped(), leaseId });
        if (String(url).endsWith('/telemetry')) {
          if (JSON.parse(String(init?.body)).type === 'ended') {
            attempts += 1;
            if (!acceptEnd(attempts)) throw new TypeError('Failed to fetch');
            current = snapshot({ revision: 1, sampleRevision: 50, segmentIndex: 1, positionMs: 0, anchorTimeMs: 100_000 + performance.now() });
          }
          return response({ snapshot: stamped() });
        }
        return response(stamped());
      });
    }

    it('sends a lost clip end again until the server moves on', async () => {
      server(attempt => attempt > 1);
      const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
      expect(instances).toHaveLength(1);
      instances[0].onended!(); await settle();
      expect(ends()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(ends()).toHaveLength(2);
      expect(instances.at(-1)!.src).toBe(manifest.segments[1].url);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(ends()).toHaveLength(2);
    });

    it('sends the clip end even when the clock reads the last report as still ahead', async () => {
      server(() => true);
      const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
      const late = deferred<Response>();
      vi.mocked(fetch).mockImplementationOnce(() => late.promise);
      const polled = value.refresh();
      await vi.advanceTimersByTimeAsync(20);
      late.resolve(response(snapshot({ sampleRevision: 7, serverTimeMs: 100_000 + performance.now() + 30, positionMs: 4_000, anchorTimeMs: 100_000 + performance.now() + 30 })));
      await polled; await settle();
      instances[0].onended!(); await settle();
      expect(ends()).toHaveLength(1);
    });
  });

  it('only presenter ended advances the cursor; listeners wait for a server transition', async () => {
    const value = controller(); await settle(); value.listen(); await settle();
    const ended = instances[0].onended!; ended(); await value.refresh(); await settle();
    expect(instances).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/telemetry'))).toBe(false);
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ revision: 2, sampleRevision: 2, segmentIndex: 1, positionMs: 0, anchorTimeMs: 100_000 })));
    await value.refresh(); await settle(); expect(instances).toHaveLength(2);
    expect(instances[1].src).toBe(manifest.segments[1].url);
    ended(); await settle(); expect(instances).toHaveLength(2);
  });

  it('fences old play resolve/reject and ended/error callbacks after skip', async () => {
    const pendingPlay = deferred<void>();
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); if (instances.length === 1) this.play.mockReturnValue(pendingPlay.promise); } });
    const value = controller({ director: true }); await settle(); value.listen(); await settle();
    const old = instances[0], ended = old.onended!, error = old.onerror!;
    vi.mocked(fetch).mockResolvedValueOnce(response({ snapshot: snapshot({ revision: 2, sampleRevision: 2, segmentIndex: 1 }) }));
    await value.command('skip'); await settle();
    const current = instances[1]; pendingPlay.resolve(); ended(); error(); await settle();
    expect(current.pause).not.toHaveBeenCalled(); expect(value.state.error).toBe('');
    expect(old.onended).toBeNull(); expect(old.onerror).toBeNull();
    const rejection = deferred<void>();
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); this.play.mockReturnValue(rejection.promise); } });
    value.listen(); await settle(); value.mute(); rejection.reject(new Error('old failure')); await settle();
    expect(value.state.error).toBe('');
  });

  it('stops locally before a host stop request and discards pre-command polls', async () => {
    const value = controller({ director: true }); await settle(); value.listen(); await settle();
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise); const poll = value.refresh();
    const command = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(command.promise); const stopping = value.command('stop');
    expect(instances[0].pause).toHaveBeenCalled();
    old.resolve(response(snapshot({ sampleRevision: 9 }))); await poll;
    expect(instances).toHaveLength(1);
    command.resolve(response({ snapshot: snapshot({ status: 'stopped', revision: 2, sampleRevision: 10 }) })); await stopping;
    expect(value.state.snapshot?.status).toBe('stopped'); expect(instances).toHaveLength(1);
  });

  it('ignores an obsolete telemetry failure after a newer clip is selected', async () => {
    const value = controller({ director: true, stage: true }); await settle(); await value.claim(); await settle();
    const delayed = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/telemetry') ? delayed.promise : response(snapshot()));
    await vi.advanceTimersByTimeAsync(1000);
    const command = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(command.promise);
    const skipping = value.command('skip');
    delayed.reject(new Error('obsolete telemetry failure')); await settle();
    command.resolve(response({ snapshot: snapshot({ revision: 2, sampleRevision: 2, segmentIndex: 1 }) })); await skipping; await settle();
    expect(value.state.listening).toBe(true); expect(value.state.error).toBe(''); expect(instances).toHaveLength(2);
  });

  it('shows blocked play failures and an explicit listen retries at the current offset', async () => {
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); if (instances.length === 1) this.play.mockRejectedValue(new Error('NotAllowedError')); } });
    const value = controller(); await settle(); value.listen(); await settle();
    expect(value.state.error).toMatch(/Playback could not start/);
    expect(value.state.listening).toBe(false);
    value.listen(); await settle(); expect(instances).toHaveLength(2); expect(instances[1].currentTime).toBeCloseTo(4);
  });

  it('applies volume and mute locally without sending shared commands', async () => {
    const value = controller(); await settle(); value.listen(); await settle();
    value.setVolume(.35); expect(instances[0].volume).toBe(.35);
    value.mute(); expect(instances[0].pause).toHaveBeenCalled(); expect(value.state.muted).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it('fails closed on network loss and does not auto-reclaim', async () => {
    const value = controller({ stage: true }); await settle(); await value.claim(); await settle();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline')); await value.refresh();
    expect(value.state.presenting).toBe(false); expect(instances[0].pause).toHaveBeenCalled();
    await value.refresh(); await settle(); expect(instances).toHaveLength(1);
    expect(value.state.error).toMatch(/reclaim/i);
  });

  it('cleans identity changes and unmounts without a delayed claim reviving audio', async () => {
    const value = controller({ stage: true }); await settle();
    const claim = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(claim.promise); const pending = value.claim();
    window.history.replaceState({}, '', `/?identity=${'c'.repeat(32)}`); await value.refresh();
    claim.resolve(response({ snapshot: snapshot({ sampleRevision: 5 }), leaseId })); await pending;
    expect(value.state.presenting).toBe(false); expect(instances).toHaveLength(0);
    const delayed = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(delayed.promise); const late = value.claim();
    value.dispose(); delayed.resolve(response({ snapshot: snapshot({ sampleRevision: 6 }), leaseId })); await late;
    expect(instances).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('checks an identity change inside a delayed claim response before adopting its lease', async () => {
    const value = controller({ stage: true }); await settle();
    const claim = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(claim.promise); const pending = value.claim();
    window.history.replaceState({}, '', `/?identity=${'d'.repeat(32)}`);
    claim.resolve(response({ snapshot: snapshot(), leaseId })); await pending; await settle();
    expect(value.state.presenting).toBe(false); expect(value.state.snapshot).toBeNull(); expect(instances).toHaveLength(0);
  });

  it('checks identity before resolving a queued browser play promise', async () => {
    const queued = deferred<void>();
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); this.play.mockReturnValue(queued.promise); } });
    const value = controller(); await settle(); value.listen(); await settle();
    window.history.replaceState({}, '', `/?identity=${'e'.repeat(32)}`);
    queued.resolve(); await settle();
    expect(value.state.listening).toBe(false); expect(instances[0].pause).toHaveBeenCalled();
  });

  it('rejects malformed manifests and foreign asset paths before loading audio', async () => {
    const value = controller(); await settle();
    vi.mocked(fetch).mockResolvedValueOnce(response(snapshot({ sampleRevision: 2, manifest: { ...manifest, segments: [{ ...manifest.segments[0], url: `/api/sessions/other/audio/assets/${'a'.repeat(64)}` }] } })));
    await value.refresh(); value.listen(); await settle();
    expect(instances).toHaveLength(0); expect(value.state.error).toMatch(/manifest|playback/i);
  });
});
