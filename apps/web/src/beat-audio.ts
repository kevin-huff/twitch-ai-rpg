import { reactive } from 'vue';
import { AudioManifestSchema, type AudioManifest } from '../../../packages/contracts/src/playback';
import { identityHeaders, identityPath } from './identity';

export type BeatClip = Pick<HTMLAudioElement, 'src' | 'onended' | 'onerror' | 'play' | 'pause'>;

// Plays one published beat's voices in this browser only, from the start, whenever the player asks.
// Nothing is shared with the stream or kept in step with it, so the sound never seeks or skips.
export function createBeatAudio(sessionId: string, makeClip: () => BeatClip = () => new Audio()) {
  const state = reactive({ beatId: null as string | null, loading: null as string | null, error: '', errorBeatId: null as string | null });
  const manifests = new Map<string, AudioManifest>();
  let clip: BeatClip | null = null;
  let run = 0;

  async function load(beatId: string): Promise<AudioManifest | null> {
    const cached = manifests.get(beatId);
    if (cached) return cached;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/audio/${encodeURIComponent(beatId)}`, { credentials: 'same-origin', headers: identityHeaders() });
    const data = await response.json().catch(() => null) as { status?: unknown; manifest?: unknown } | null;
    if (!response.ok || data?.status !== 'ready') return null;
    const manifest = AudioManifestSchema.parse(data.manifest);
    if (manifest.beatId !== beatId) return null;
    manifests.set(beatId, manifest);
    return manifest;
  }

  function fail(beatId: string, message: string) { state.error = message; state.errorBeatId = beatId; }

  function stop() {
    run++;
    if (clip) { clip.onended = null; clip.onerror = null; clip.pause(); }
    state.beatId = null; state.loading = null;
  }

  function playFrom(manifest: AudioManifest, index: number, mine: number) {
    if (mine !== run) return;
    const segment = manifest.segments[index];
    if (!segment) { state.beatId = null; return; }
    const current = clip ??= makeClip();
    // A clip that cannot load is skipped, so one bad file does not silence the rest.
    current.onended = () => playFrom(manifest, index + 1, mine);
    current.onerror = () => playFrom(manifest, index + 1, mine);
    current.src = identityPath(segment.url);
    current.play().catch(() => {
      if (mine !== run) return;
      stop(); fail(manifest.beatId, 'This browser blocked the sound. Press Play again.');
    });
  }

  async function play(beatId: string) {
    stop();
    const mine = run;
    state.error = ''; state.errorBeatId = null;
    // A recording that is already loaded starts inside the tap itself, which phones require before they make sound.
    const cached = manifests.get(beatId);
    if (cached) { state.beatId = beatId; playFrom(cached, 0, mine); return; }
    state.loading = beatId;
    try {
      const manifest = await load(beatId);
      if (mine !== run) return;
      state.loading = null;
      if (!manifest) { fail(beatId, 'This part has no voices yet.'); return; }
      state.beatId = beatId; playFrom(manifest, 0, mine);
    } catch {
      if (mine !== run) return;
      state.loading = null; fail(beatId, 'The sound could not load. Press Play to try again.');
    }
  }

  function prefetch(beatId: string) { void load(beatId).catch(() => undefined); }
  function dispose() { stop(); clip = null; }

  return { state, play, stop, prefetch, dispose };
}
