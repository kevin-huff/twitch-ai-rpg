import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ScenarioDraftSchema, ScenarioGenerationRequestSchema, type AiProvider, type VoiceSource, type ScenarioSize } from '@rpg/contracts';
import { AppError, type Actor } from './repository';
import { ScenarioDraftJobs } from './scenario-jobs';
import { scenarioFromDraft } from './scenario-generation';

const SIZE_FACTOR: Record<ScenarioSize, number> = { small: 1, medium: 4 / 3, large: 2 };

export function registerScenarioDrafts(app: FastifyInstance, options: {
  authenticate(request: FastifyRequest): Promise<Actor>;
  provider: AiProvider;
  voices?: VoiceSource;
  scenarioTimeoutMs?: number;
}) {
  const jobs = new ScenarioDraftJobs();
  const scenarioTimeoutMs = options.scenarioTimeoutMs ?? 180_000;
  app.addHook('onClose', async () => { jobs.close(); });

  const host = async (request: FastifyRequest) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the director can generate scenarios.');
    return actor;
  };
  const ownerKey = (actor: Actor) => `${actor.actor_id}:${actor.producer_grant_id ?? 'host'}`;

  app.post('/api/authoring/scenario-drafts', async (request, reply) => {
    const actor = await host(request);
    const body = ScenarioGenerationRequestSchema.parse(request.body);
    const provider = options.provider;
    if (!provider.generateScenario) {
      throw new AppError(503, 'generation_unavailable', 'AI drafting is not available right now. You can still fill in the form yourself.');
    }
    const list = await Promise.resolve(options.voices?.listVoices()).then(result => result?.voices ?? [], () => []);
    const voiceIds = list.map(voice => voice.id);
    const choices = list.map(({ id, name, summary }) => ({ id, name, summary }));
    const deadlineMs = Math.round(scenarioTimeoutMs * SIZE_FACTOR[body.size]);
    const job = jobs.start(ownerKey(actor), body.size, deadlineMs, async (deadlineAt) =>
      scenarioFromDraft(ScenarioDraftSchema.parse(await provider.generateScenario!(body, { deadlineAt, voices: choices })), body.boundaries, undefined, voiceIds));
    return reply.code(202).send(job);
  });

  app.get<{ Params: { jobId: string } }>('/api/authoring/scenario-drafts/:jobId', async (request) => {
    const actor = await host(request);
    const job = jobs.get(ownerKey(actor), request.params.jobId);
    if (!job) throw new AppError(404, 'not_found', 'That scenario draft was not found. It may have expired.');
    return job;
  });
}
