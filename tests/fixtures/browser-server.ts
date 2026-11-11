import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { buildApp } from '../../apps/server/src/app';
import { FakeAiProvider } from '../../apps/server/src/fake-provider';
import { FakeImageProvider } from '../../apps/server/src/fake-images';
import type { AiCallOptions, ProviderContext } from '@rpg/contracts';

// Inject deterministic media only in the isolated browser harness.
const databaseUrl = process.env.DATABASE_URL!;
if (new URL(databaseUrl).pathname !== '/rpg_test') throw new Error('Browser tests require the rpg_test database.');
const bytes = new Uint8Array(await readFile(new URL('./silence.mp3', import.meta.url)));
const marker = 'Operations rehearsal:';
// A planned line starting with 'Double ones:' makes the next lock roll double 1s.
const ONES = 'Double ones:';
let forceOnes = false;
const delayed = (context: ProviderContext) => context.submissions.some(submission => submission.text.startsWith(marker));
// A line starting with 'Hold the AI:' makes plan and render wait until the call is aborted or 20 seconds pass.
const HOLD = 'Hold the AI:';
const held = (context: ProviderContext) => context.submissions.some(submission => submission.text.startsWith(HOLD) || submission.intent.startsWith(HOLD));
const hold = (signal?: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal?.aborted) { fail(signal.reason); return; }
  const onAbort = () => { clearTimeout(timer); fail(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); done(); }, 20000);
  signal?.addEventListener('abort', onAbort, { once: true });
});
const pause = () => new Promise<void>(done => setTimeout(done, 3500));
class BrowserAiProvider extends FakeAiProvider {
  async plan(context: ProviderContext, options?: AiCallOptions) {
    if (held(context)) await hold(options?.signal);
    forceOnes = context.submissions.some(submission => submission.text.startsWith(ONES) || submission.intent.startsWith(ONES));
    if (delayed(context)) await pause();
    return super.plan(context, options);
  }
  async render(context: ProviderContext, options?: AiCallOptions) {
    if (held(context)) await hold(options?.signal);
    if (delayed(context)) await pause();
    const draft = await super.render(context, options);
    if (delayed(context)) for (const segment of draft.segments) segment.text = `${marker} ${segment.text}`;
    return draft;
  }
}
const app = await buildApp({
  databaseUrl, hostToken: 'browser-test-host-credential-not-for-deployment', origin: 'http://127.0.0.1:3100',
  provider: new BrowserAiProvider(),
  rollDie: () => (forceOnes ? 1 : randomInt(1, 7)),
  images: process.env.BROWSER_PICTURES === 'off' ? undefined : new FakeImageProvider({ delayMs: 1000 }),
  speech: { synthesize: async ({ text }) => { if (text.startsWith(marker)) await pause(); return { bytes, contentType: 'audio/mpeg' }; } },
  speechModel: 'browser-synthetic', speechVoiceId: 'browser-synthetic', assetDir: 'test-results/audio',
});
await app.listen({ host: '127.0.0.1', port: 3100 });
console.log('Local roleplay server is ready at http://127.0.0.1:3100');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
