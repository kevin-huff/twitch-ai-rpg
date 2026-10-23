import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CharacterBuilderDraftSchema, CharacterBuilderSnapshotSchema, CharacterBuilderSummarySchema,
  CharacterBuilderFieldGenerationRequestSchema, FieldGenerationRequestSchema, MAX_FIELD_GENERATION_REQUEST_BYTES,
  CreateCharacterBuilderSchema, IdSchema, SaveCharacterBuilderSchema, SubmitCharacterBuilderSchema,
  type AiProvider, type CharacterBuilderDraft,
} from '@rpg/contracts';
import { transaction } from './database';
import { AppError, conflict, type Actor } from './repository';
import { digest } from './commands';
import { requestIdentity } from './identity';
import { executeFieldGeneration } from './field-generation';

interface BuilderOptions {
  pool: Pool;
  authenticate(request: FastifyRequest): Promise<Actor>;
  hostToken: string;
  origin: string;
  provider: AiProvider;
  timeoutMs?: number;
}
interface BuilderRow {
  id: string;
  owner_id: string;
  label: string;
  instructions: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  draft_revision: number;
  draft: CharacterBuilderDraft;
  submitted_at: Date | null;
  submitted_template_id: string | null;
  submitted_template_version: number | null;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const submittedTemplate = (row: BuilderRow) => row.submitted_template_id === null ? null : { templateId: row.submitted_template_id, version: row.submitted_template_version };
const summary = (row: BuilderRow) => CharacterBuilderSummarySchema.parse({
  id: row.id, label: row.label, instructions: row.instructions, createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
  submittedAt: row.submitted_at?.toISOString() ?? null, submittedTemplate: submittedTemplate(row),
});
const snapshot = (row: BuilderRow) => CharacterBuilderSnapshotSchema.parse({
  id: row.id, label: row.label, instructions: row.instructions, revision: row.draft_revision, draft: row.draft,
  expiresAt: row.expires_at.toISOString(), submittedTemplate: submittedTemplate(row),
});
const blankDraft = () => CharacterBuilderDraftSchema.parse({
  schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '',
  traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '',
  possessions: ['', '', ''], connection: '', secret: '', extensions: {},
});
const unauthorized = (): never => { throw new AppError(401, 'unauthorized', 'This character builder is expired, revoked, or unavailable. Open an active builder link.'); };
const notFound = (): never => { throw new AppError(404, 'not_found', 'That owned character builder was not found.'); };

async function activeGrant(client: PoolClient, id: string) {
  // Check time after taking the grant lock, including when an earlier writer held it across expiry.
  return (await client.query('SELECT expires_at>clock_timestamp() AND revoked_at IS NULL AS active FROM character_builders WHERE id=$1', [id])).rows[0]?.active === true;
}
async function previousCommand(client: PoolClient, actorId: string, commandId: string, requestHash: string) {
  const previous = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actorId, commandId])).rows[0];
  if (previous && previous.request_hash !== requestHash) conflict('This command ID was already used for a different operation.');
  return previous?.response;
}
async function saveReceipt(client: PoolClient, actorId: string, commandId: string, requestHash: string, response: unknown) {
  await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,response) VALUES($1,$2,$3,$4)', [actorId, commandId, requestHash, response]);
}

export function registerCharacterBuilders(app: FastifyInstance, options: BuilderOptions) {
  const tokenFor = (id: string) => createHmac('sha256', options.hostToken).update(JSON.stringify(['rpg-character-builder-v1', id])).digest('base64url');
  const host = async (request: FastifyRequest) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host can manage character builder links.');
    return actor;
  };
  const owned = async (client: PoolClient, id: string, ownerId: string) => {
    const row = (await client.query<BuilderRow>('SELECT * FROM character_builders WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId])).rows[0];
    if (!row) return notFound();
    return row;
  };
  const selectedCredential = (request: FastifyRequest) => {
    const identityId = requestIdentity(request.url, request.headers['x-rpg-identity']);
    if (!identityId) return unauthorized();
    const name = `rpg_builder_${identityId}`;
    const credential = request.cookies[name];
    if (!credential) return unauthorized();
    return { name, tokenHash: hash(credential) };
  };
  const authenticated = async (client: PoolClient, request: FastifyRequest) => {
    const selected = selectedCredential(request);
    const credential = (await client.query('SELECT builder_id FROM character_builder_credentials WHERE token_hash=$1', [selected.tokenHash])).rows[0];
    if (!credential) return unauthorized();
    const row = (await client.query<BuilderRow>('SELECT * FROM character_builders WHERE id=$1 FOR UPDATE', [credential.builder_id])).rows[0];
    if (!row || !await activeGrant(client, row.id)) return unauthorized();
    const activeCredential = (await client.query('SELECT 1 FROM character_builder_credentials WHERE token_hash=$1 AND expires_at>clock_timestamp() AND revoked_at IS NULL', [selected.tokenHash])).rowCount;
    if (!activeCredential) return unauthorized();
    return { row, selected };
  };

  app.get('/api/character-builders', async (request) => {
    const actor = await host(request);
    const builders = await options.pool.query<BuilderRow>('SELECT * FROM character_builders WHERE owner_id=$1 ORDER BY created_at DESC,id', [actor.actor_id]);
    return { builders: builders.rows.map(summary) };
  });
  app.post('/api/character-builders', async (request) => {
    const actor = await host(request);
    const command = CreateCharacterBuilderSchema.parse(request.body);
    const requestHash = digest({ operation: 'character-builder.create', builderId: null, command });
    return transaction(options.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      let row: BuilderRow;
      if (previous) {
        row = await owned(client, previous.builderId, actor.actor_id);
        if (!await activeGrant(client, row.id)) return notFound();
      } else {
        const id = randomUUID();
        row = (await client.query<BuilderRow>("INSERT INTO character_builders(id,owner_id,label,instructions,token_hash,draft,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '720 hours') RETURNING *", [id, actor.actor_id, command.label, command.instructions, hash(tokenFor(id)), blankDraft()])).rows[0]!;
        await saveReceipt(client, actor.actor_id, command.commandId, requestHash, { builderId: id });
      }
      return { builder: summary(row), token: tokenFor(row.id) };
    });
  });
  app.get<{ Params: { id: string } }>('/api/character-builders/:id/link', async (request) => {
    const actor = await host(request);
    return transaction(options.pool, async (client) => {
      const row = await owned(client, request.params.id, actor.actor_id);
      if (!await activeGrant(client, row.id)) return notFound();
      return { builder: summary(row), token: tokenFor(row.id) };
    });
  });
  app.post<{ Params: { id: string } }>('/api/character-builders/:id/revoke', async (request) => {
    const actor = await host(request);
    const command = z.strictObject({ commandId: IdSchema }).parse(request.body);
    const requestHash = digest({ operation: 'character-builder.revoke', builderId: request.params.id, command });
    return transaction(options.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
      const row = await owned(client, request.params.id, actor.actor_id);
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      if (previous) return previous;
      const revoked = (await client.query<BuilderRow>('UPDATE character_builders SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING *', [row.id])).rows[0]!;
      await client.query('UPDATE character_builder_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE builder_id=$1', [row.id]);
      const response = summary(revoked);
      await saveReceipt(client, actor.actor_id, command.commandId, requestHash, response);
      return response;
    });
  });

  app.post('/api/character-builder/access', async (request, reply) => {
    const { token } = z.strictObject({ token: z.string().min(1).max(1024) }).parse(request.body);
    const result = await transaction(options.pool, async (client) => {
      const row = (await client.query<BuilderRow>('SELECT * FROM character_builders WHERE token_hash=$1 FOR UPDATE', [hash(token)])).rows[0];
      if (!row || !await activeGrant(client, row.id)) return unauthorized();
      const credential = randomBytes(32).toString('base64url');
      await client.query('INSERT INTO character_builder_credentials(token_hash,builder_id,expires_at) VALUES($1,$2,$3)', [hash(credential), row.id, row.expires_at]);
      return { row, credential };
    });
    const identityId = randomBytes(16).toString('hex');
    reply.setCookie(`rpg_builder_${identityId}`, result.credential, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: options.origin.startsWith('https:'),
      maxAge: Math.max(0, Math.min(30 * 86400, Math.floor((result.row.expires_at.getTime() - Date.now()) / 1000))),
    });
    return { identityId, builder: snapshot(result.row) };
  });
  app.get('/api/character-builder', async (request) => transaction(options.pool, async (client) => snapshot((await authenticated(client, request)).row)));
  app.post('/api/character-builder/generate-field', { bodyLimit: MAX_FIELD_GENERATION_REQUEST_BYTES }, async (request) => {
    const requireEditable = (row: BuilderRow, expectedRevision: number) => {
      if (row.submitted_at !== null) conflict('This character has already been submitted. It is now read-only.');
      if (row.draft_revision !== expectedRevision) conflict('This draft changed. Reload it before generating.');
    };
    const { input, expectedRevision } = await transaction(options.pool, async (client) => {
      const { row } = await authenticated(client, request);
      const command = CharacterBuilderFieldGenerationRequestSchema.parse(request.body);
      requireEditable(row, command.expectedRevision);
      const instructions = row.instructions.trim();
      return {
        expectedRevision: command.expectedRevision,
        input: FieldGenerationRequestSchema.parse({
          field: command.field, seed: command.seed, characterContext: command.characterContext,
          ...(instructions ? { instructions } : {}),
        }),
      };
    });
    const output = await executeFieldGeneration(options.provider, input, options.timeoutMs);
    await transaction(options.pool, async (client) => requireEditable((await authenticated(client, request)).row, expectedRevision));
    return output;
  });
  for (const operation of ['save', 'submit'] as const) {
    app.post(`/api/character-builder/${operation}`, async (request) => {
      const command = (operation === 'submit' ? SubmitCharacterBuilderSchema : SaveCharacterBuilderSchema).parse(request.body);
      return transaction(options.pool, async (client) => {
        const { row } = await authenticated(client, request);
        const actorId = `builder:${row.id}`;
        const requestHash = digest({ operation: `character-builder.${operation}`, builderId: row.id, command });
        const previous = await previousCommand(client, actorId, command.commandId, requestHash);
        if (previous) return previous;
        if (row.submitted_at !== null) conflict('This character has already been submitted. It is now read-only.');
        if (row.draft_revision !== command.expectedRevision) conflict('This draft changed. Reload it before saving.');
        let updated: BuilderRow;
        if (operation === 'submit') {
          const templateId = randomUUID();
          await client.query("INSERT INTO library_templates(id,owner_id,kind,current_version) VALUES($1,$2,'characters',1)", [templateId, row.owner_id]);
          await client.query('INSERT INTO library_versions(template_id,version,definition) VALUES($1,1,$2)', [templateId, command.draft]);
          updated = (await client.query<BuilderRow>('UPDATE character_builders SET draft=$2,draft_revision=draft_revision+1,submitted_at=clock_timestamp(),submitted_template_id=$3,submitted_template_version=1 WHERE id=$1 RETURNING *', [row.id, command.draft, templateId])).rows[0]!;
        } else {
          updated = (await client.query<BuilderRow>('UPDATE character_builders SET draft=$2,draft_revision=draft_revision+1 WHERE id=$1 RETURNING *', [row.id, command.draft])).rows[0]!;
        }
        const response = snapshot(updated);
        await saveReceipt(client, actorId, command.commandId, requestHash, response);
        return response;
      });
    });
  }
  app.post('/api/character-builder/logout', async (request, reply) => {
    z.strictObject({}).parse(request.body);
    const name = await transaction(options.pool, async (client) => {
      const { selected } = await authenticated(client, request);
      await client.query('UPDATE character_builder_credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [selected.tokenHash]);
      return selected.name;
    });
    reply.clearCookie(name, { path: '/' });
    return { ok: true };
  });
}
