import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  LINE_ASSIST_ROUNDS, LineAssistInputSchema, LineAssistRequestSchema, LineAssistResponseSchema, hasAudioTags, stripAudioTags,
  type AiProvider, type LineAssistInput, type LineAssistRequest, type LineAssistResponse, type PublishedBeat, type SessionState,
} from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, readState, type Actor } from './repository';

interface LineAssistOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  provider: AiProvider;
  timeoutMs?: number;
}
type Params = { Params: { sessionId: string } };

export const LINE_ASSIST_FAILED = 'The AI could not help this time. Your words are unchanged.';
const running = new Set<string>();

const reachable = (state: SessionState, npc: SessionState['npcs'][number]) =>
  (npc.status === 'present' && npc.locationId === state.session.scene.locationId) || Boolean(npc.communicationChannel);

export function lineAssistInput(state: SessionState, history: PublishedBeat[], characterId: string, request: LineAssistRequest): LineAssistInput {
  const character = state.characters.find(item => item.id === characterId);
  if (!character) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
  const recipientIds = [...new Set(request.recipientNpcIds)];
  const talkingTo = recipientIds.map((id) => {
    const npc = state.npcs.find(item => item.id === id && reachable(state, item));
    if (!npc) return conflict('The addressed NPC is unavailable.');
    return { displayName: npc.displayName, role: npc.role, appearance: npc.appearance, mood: npc.mood, personality: [...npc.personality] };
  });
  const brief = state.session.brief;
  return LineAssistInputSchema.parse({
    idea: request.idea,
    character: {
      displayName: character.displayName, pronouns: character.pronouns, appearance: character.appearance, personality: character.personality,
      backstory: character.backstory, specialty: character.specialty, flaw: character.flaw, connection: character.connection,
      secret: character.secret, possessions: [...character.possessions],
    },
    talkingTo,
    present: {
      npcs: state.npcs
        .filter(npc => npc.status === 'present' && npc.locationId === state.session.scene.locationId && !recipientIds.includes(npc.id))
        .map(npc => ({ displayName: npc.displayName, role: npc.role })),
      characters: state.characters.filter(item => item.id !== characterId).map(item => ({ displayName: item.displayName, appearance: item.appearance })),
    },
    scene: { title: state.session.scene.title, description: state.session.scene.description },
    story: brief ? { premise: brief.premise, genre: brief.genre, tone: brief.tone } : null,
    facts: state.facts.filter(fact => fact.visibility === 'public').map(fact => fact.text),
    recentRounds: history.slice(-LINE_ASSIST_ROUNDS).map(beat => ({
      beatNumber: beat.beatNumber,
      lines: beat.segments.map(segment => ({ speaker: segment.speaker?.displayName ?? null, text: segment.text })),
    })),
    boundaries: [...(state.setup?.boundaries ?? [])],
  });
}

async function suggest(provider: AiProvider, input: LineAssistInput, timeoutMs: number): Promise<LineAssistResponse> {
  if (!provider.suggestLine) throw new AppError(503, 'generation_unavailable', 'The line helper is not available right now. You can still write the line yourself.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      provider.suggestLine(input),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The AI took too long.')), timeoutMs); }),
    ]);
    const parsed = LineAssistResponseSchema.safeParse(output);
    if (!parsed.success) throw new Error('The suggestion did not parse.');
    const words = hasAudioTags(parsed.data.text) ? stripAudioTags(parsed.data.text) : parsed.data.text;
    if (!words.trim()) throw new Error('The suggestion held no words.');
    return parsed.data;
  } catch {
    throw new AppError(502, 'generation_failed', LINE_ASSIST_FAILED);
  } finally { clearTimeout(timer); }
}

export function registerLineAssist(app: FastifyInstance, options: LineAssistOptions) {
  app.post<Params>('/api/sessions/:sessionId/line-assist', async (request) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'player' || !actor.character_id) throw new AppError(403, 'forbidden', 'Use your own player seat to get help with a line.');
    const body = LineAssistRequestSchema.parse(request.body);
    const sessionId = request.params.sessionId;
    const input = await transaction(options.pool, async (client) => {
      const current = await options.authenticate(request, client);
      if (current.actor_id !== actor.actor_id || current.character_id !== actor.character_id) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
      await authorize(client, sessionId, current);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict('This session has ended.');
      const character = state.characters.find(item => item.id === current.character_id);
      if (!character) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
      if (state.setup && (!state.setup.started || !character.approved)) conflict('Start the session before joining in-character play.');
      const recent = (await client.query('SELECT data FROM published_beats WHERE session_id=$1 ORDER BY beat_number DESC LIMIT $2', [sessionId, LINE_ASSIST_ROUNDS]))
        .rows.map(row => row.data as PublishedBeat).reverse();
      return lineAssistInput(state, recent, character.id, body);
    });
    const key = `${sessionId}:${actor.character_id}`;
    if (running.has(key)) conflict('Already writing a suggestion.');
    running.add(key);
    try {
      return await suggest(options.provider, input, options.timeoutMs ?? 50_000);
    } finally { running.delete(key); }
  });
}
