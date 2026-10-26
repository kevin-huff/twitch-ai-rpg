import { buildApp } from './app';
import { parseHourlyLimit, parseSafeFilter } from './image-settings';
import { ClewdrAiProvider, ElevenLabsSpeechProvider, SogniImageProvider } from '@rpg/providers';

const databaseUrl = process.env.DATABASE_URL;
const hostToken = process.env.HOST_TOKEN;
const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
if (!databaseUrl || !hostToken) throw new Error('Set DATABASE_URL and a securely generated HOST_TOKEN before starting.');
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before enabling its provider.`);
  return value;
};
if (!['fake', 'clewdr'].includes(process.env.AI_PROVIDER ?? 'fake')) throw new Error('AI_PROVIDER must be fake or clewdr.');
if (!['silent', 'elevenlabs'].includes(process.env.TTS_PROVIDER ?? 'silent')) throw new Error('TTS_PROVIDER must be silent or elevenlabs.');
const imageSetting = process.env.IMAGE_PROVIDER?.trim() || (process.env.SOGNI_KEY?.trim() ? 'sogni' : 'off');
if (!['sogni', 'off'].includes(imageSetting)) throw new Error('IMAGE_PROVIDER must be sogni or off.');
const imageHourlyLimit = parseHourlyLimit(process.env.SOGNI_HOURLY_LIMIT);
const safeContentFilter = parseSafeFilter(process.env.SOGNI_SAFE_FILTER);
const provider = process.env.AI_PROVIDER === 'clewdr' ? new ClewdrAiProvider({ baseUrl: required('CLEWDR_BASE_URL'), apiKey: required('CLEWDR_API_KEY'), model: required('CLEWDR_MODEL'), timeoutMs: 45000 }) : undefined;
const speech = process.env.TTS_PROVIDER === 'elevenlabs' ? new ElevenLabsSpeechProvider({ apiKey: required('ELEVENLABS_API_KEY'), model: required('ELEVENLABS_MODEL'), voiceId: required('ELEVENLABS_VOICE_ID') }) : undefined;
const images = imageSetting === 'sogni' ? new SogniImageProvider({ apiKey: required('SOGNI_KEY'), model: process.env.SOGNI_IMAGE_MODEL?.trim() || undefined, safeContentFilter }) : undefined;
console.log(images ? `Pictures: on (Sogni, ${images.model}, safe-content filter ${safeContentFilter ? 'on' : 'off'}).` : 'Pictures: off.');
console.log('Connecting to PostgreSQL and applying migrations…');
const app = await buildApp({ databaseUrl, hostToken, origin, provider, providerTimeoutMs: 50000, speech, speechModel: process.env.ELEVENLABS_MODEL, speechVoiceId: process.env.ELEVENLABS_VOICE_ID, assetDir: process.env.ASSET_DIR, images, imageHourlyLimit });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
console.log(`Local roleplay server is ready at ${origin}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
