import { readFile } from 'node:fs/promises';
import { buildApp } from '../../apps/server/src/app';
import { FakeAiProvider } from '../../apps/server/src/fake-provider';
import { FakeImageProvider } from '../../apps/server/src/fake-images';
import type { ProviderContext } from '@rpg/contracts';

// Inject deterministic media only in the isolated browser harness.
const databaseUrl = process.env.DATABASE_URL!;
if (new URL(databaseUrl).pathname !== '/rpg_test') throw new Error('Browser tests require the rpg_test database.');
const bytes = new Uint8Array(await readFile(new URL('./silence.mp3', import.meta.url)));
const marker = 'Operations rehearsal:';
const delayed = (context: ProviderContext) => context.submissions.some(submission => submission.text.startsWith(marker));
const pause = () => new Promise<void>(done => setTimeout(done, 3500));
class BrowserAiProvider extends FakeAiProvider {
  async plan(context: ProviderContext) {
    if (delayed(context)) await pause();
    return super.plan(context);
  }
  async render(context: ProviderContext) {
    if (delayed(context)) await pause();
    const draft = await super.render(context);
    if (delayed(context)) for (const segment of draft.segments) segment.text = `${marker} ${segment.text}`;
    return draft;
  }
}
const app = await buildApp({
  databaseUrl, hostToken: 'browser-test-host-credential-not-for-deployment', origin: 'http://127.0.0.1:3100',
  provider: new BrowserAiProvider(),
  images: process.env.BROWSER_PICTURES === 'off' ? undefined : new FakeImageProvider({ delayMs: 1000 }),
  speech: { synthesize: async ({ text }) => { if (text.startsWith(marker)) await pause(); return { bytes, contentType: 'audio/mpeg' }; } },
  speechModel: 'browser-synthetic', speechVoiceId: 'browser-synthetic', assetDir: 'test-results/audio',
});
await app.listen({ host: '127.0.0.1', port: 3100 });
console.log('Local roleplay server is ready at http://127.0.0.1:3100');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
