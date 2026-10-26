import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CardGenerationInputSchema, HostCardGenerationRequestSchema, FieldGenerationRequestSchema, FieldGenerationResponseSchema, MAX_FIELD_GENERATION_REQUEST_BYTES, validateFieldGenerationText, type AiProvider, type FieldGenerationRequest } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { AppError, type Actor } from './repository';
import { executeCardGeneration } from './card-generation';

export async function executeFieldGeneration(provider: AiProvider, input: FieldGenerationRequest, timeoutMs = 50_000) {
  if (!provider.generateField) throw new AppError(503, 'generation_unavailable', 'Field generation is unavailable with the configured AI provider.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      provider.generateField(input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderError('timeout', 'ClewdR')), timeoutMs);
      }),
    ]);
    const parsed = FieldGenerationResponseSchema.parse(output);
    return { text: validateFieldGenerationText(input.field, parsed.text) };
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'timeout') throw new AppError(504, 'generation_timeout', 'Generation timed out. Retry or edit the field yourself.');
    throw new AppError(502, 'generation_failed', 'AI could not produce a valid draft for this field. Retry or edit the field yourself.');
  } finally { clearTimeout(timer); }
}

export function registerFieldGeneration(app: FastifyInstance, options: {
  authenticate(request: FastifyRequest): Promise<Actor>;
  provider: AiProvider;
  timeoutMs?: number;
}) {
  app.post('/api/authoring/generate-field', { bodyLimit: MAX_FIELD_GENERATION_REQUEST_BYTES }, async (request) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the director can generate field drafts.');
    const input = FieldGenerationRequestSchema.parse(request.body);
    return executeFieldGeneration(options.provider, input, options.timeoutMs);
  });
  app.post('/api/authoring/generate-card', { bodyLimit: MAX_FIELD_GENERATION_REQUEST_BYTES }, async (request) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the director can generate character cards.');
    const body = HostCardGenerationRequestSchema.parse(request.body);
    const input = CardGenerationInputSchema.parse({
      prompt: body.prompt, keepFilled: body.keepFilled,
      ...(body.current ? { current: body.current } : {}), ...(body.premise ? { premise: body.premise } : {}),
    });
    return executeCardGeneration(options.provider, input, options.timeoutMs);
  });
}
