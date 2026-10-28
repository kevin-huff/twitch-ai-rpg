import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fakeVoiceSource, type VoiceList, type VoiceOption, type VoiceSource } from '@rpg/contracts';
import type { Actor } from './repository';

const UNAVAILABLE = 'The voice list is unavailable right now. Everyone keeps the narrator.';
const GROUP_ORDER: Record<VoiceOption['group'], number> = { clone: 0, added: 1, standard: 2 };

function sortVoices(voices: VoiceOption[]): VoiceOption[] {
  return [...voices].sort((a, b) =>
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group]
    || Number(b.tuned) - Number(a.tuned)
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export class VoiceCatalog implements VoiceSource {
  private kept: { list: VoiceList; expires: number } | null = null;
  private inFlight: Promise<VoiceList> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly source: VoiceSource = fakeVoiceSource, options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 600_000;
    this.now = options.now ?? Date.now;
  }

  listVoices(): Promise<VoiceList> {
    if (this.kept && this.now() < this.kept.expires) return Promise.resolve(this.kept.list);
    this.inFlight ??= this.load().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(): Promise<VoiceList> {
    try {
      const result = await this.source.listVoices();
      if (result.reason) return { voices: [], reason: result.reason };
      const list: VoiceList = { voices: sortVoices(result.voices) };
      this.kept = { list, expires: this.now() + this.ttlMs };
      return list;
    } catch {
      return { voices: [], reason: UNAVAILABLE };
    }
  }
}

export function registerVoices(app: FastifyInstance, options: {
  authenticate(request: FastifyRequest): Promise<Actor>;
  catalog: VoiceSource;
}) {
  app.get('/api/voices', async (request): Promise<VoiceList> => {
    await options.authenticate(request);
    return options.catalog.listVoices();
  });
}
