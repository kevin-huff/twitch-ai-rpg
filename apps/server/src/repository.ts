import type { PoolClient } from 'pg';
import {
  SessionStateSchema, SessionSnapshotSchema, PublicCorrectionSchema, type SessionState, type Beat, type Submission,
  type SessionSnapshot, type PublishedBeat, type Role, type PublicBeat, type PublicCorrection, type GalleryStatus,
} from '@rpg/contracts';
import { actionPictureView, lastBeatInScene, portraitJobsView, scenePictureView } from './picture-views';
import { pictureSettingsOf } from './picture-settings';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const conflict = (message: string): never => { throw new AppError(409, 'conflict', message); };
export interface Actor {
  actor_id: string; role: 'host' | 'player' | 'stage'; session_id: string | null; character_id: string | null;
  producer_grant_id?: string | null; stream_link_id?: string | null; can_present?: boolean; expires_at?: Date;
}
export const isHostOnly = (actor: Actor) => actor.role === 'host' && !actor.producer_grant_id;

export async function authorize(client: PoolClient, sessionId: string, actor: Actor) {
  const result = await client.query('SELECT * FROM sessions WHERE id=$1', [sessionId]);
  const row = result.rows[0];
  if (!row || (actor.role === 'host' ? row.owner_id !== actor.actor_id : actor.session_id !== sessionId)) {
    throw new AppError(404, 'not_found', 'Session was not found.');
  }
  return row;
}

export async function readState(client: PoolClient, sessionId: string): Promise<SessionState> {
  const result = await client.query('SELECT * FROM sessions WHERE id=$1', [sessionId]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Session was not found.');
  const values = [];
  for (const table of ['characters', 'npcs', 'tracks', 'facts']) {
    const result = await client.query(`SELECT data FROM ${table} WHERE session_id=$1 ORDER BY ordinal,id`, [sessionId]);
    values.push(result.rows.map((entry) => entry.data));
  }
  const locations = row.locations?.length ? row.locations : [
    { id: row.scene.locationId, title: 'Current location', description: '' },
    ...[...new Set(values[1]!.map(npc => npc.locationId as string))].filter(id => id !== row.scene.locationId)
      .map((id, index) => ({ id, title: `Other location ${index + 1}`, description: '' })),
  ];
  return SessionStateSchema.parse({ locations, schemaVersion: 1, rulesVersion: '0.1', session: {
    id: row.id, title: row.title, status: row.status, mode: row.mode, stateRevision: row.version,
    inputEpoch: row.input_epoch, beatNumber: row.beat_number, actionRoundNumber: row.action_round, scene: row.scene, ...(row.brief ? { brief: row.brief } : {}),
  }, characters: values[0], npcs: values[1], tracks: values[2], facts: values[3], directorNotes: row.director_notes, ...(row.setup ? { setup: row.setup } : {}) });
}

export async function saveState(client: PoolClient, state: SessionState) {
  const session = state.session;
  await client.query('UPDATE sessions SET title=$2,status=$3,mode=$4,version=$5,input_epoch=$6,beat_number=$7,action_round=$8,scene=$9,director_notes=$10,setup=$11,brief=$12,locations=$13 WHERE id=$1', [session.id, session.title, session.status, session.mode, session.stateRevision, session.inputEpoch, session.beatNumber, session.actionRoundNumber, session.scene, state.directorNotes, state.setup ?? null, state.session.brief ?? null, JSON.stringify(state.locations)]);
  for (const table of ['characters', 'npcs', 'tracks', 'facts'] as const) {
    for (const [ordinal, record] of state[table].entries()) {
      const result = await client.query(`INSERT INTO ${table}(id,session_id,data,ordinal) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data,ordinal=excluded.ordinal${table !== 'facts' ? `,version=${table}.version+1` : ''} WHERE ${table}.session_id=excluded.session_id RETURNING id`, [record.id, session.id, record, ordinal]);
      if (!result.rowCount) conflict('An entity ID is already assigned to another session.');
    }
  }
}

export async function currentBeat(client: PoolClient, sessionId: string): Promise<Beat | null> {
  const result = await client.query('SELECT data FROM beats WHERE session_id=$1 AND phase NOT IN (\'published\',\'aborted\')', [sessionId]);
  return result.rows[0]?.data ?? null;
}
export async function saveBeat(client: PoolClient, beat: Beat) {
  await client.query('INSERT INTO beats(id,session_id,kind,phase,input_revision,draft_revision,snapshot_hash,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,phase=excluded.phase,input_revision=excluded.input_revision,draft_revision=excluded.draft_revision,snapshot_hash=excluded.snapshot_hash,data=excluded.data', [beat.id, beat.sessionId, beat.kind, beat.phase, beat.revision, beat.draftRevision, beat.inputSnapshotHash, beat]);
}
export async function submissions(client: PoolClient, sessionId: string): Promise<Submission[]> {
  return (await client.query(`SELECT s.data FROM submissions s LEFT JOIN (SELECT data->>'submissionId' AS submission_id, min(sequence) AS seq FROM audit_events WHERE session_id=$1 AND kind='save_submission' GROUP BY 1) e ON e.submission_id = s.id WHERE s.session_id=$1 ORDER BY e.seq ASC NULLS FIRST, s.id`, [sessionId])).rows.map((row) => row.data);
}
export async function saveSubmission(client: PoolClient, submission: Submission) {
  await client.query('INSERT INTO submissions(id,session_id,character_id,beat_id,revision,status,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET beat_id=excluded.beat_id,revision=excluded.revision,status=excluded.status,data=excluded.data', [submission.id, submission.sessionId, submission.characterId, submission.contextBeatId, submission.revision, submission.status, submission]);
}
export async function history(client: PoolClient, sessionId: string): Promise<PublishedBeat[]> {
  return (await client.query('SELECT data FROM published_beats WHERE session_id=$1 ORDER BY beat_number', [sessionId])).rows.map((row) => row.data);
}
export async function corrections(client: PoolClient, sessionId: string): Promise<PublicCorrection[]> {
  const result = await client.query("SELECT id,data->'public' AS correction FROM audit_events WHERE session_id=$1 AND kind='correction.recorded' ORDER BY sequence", [sessionId]);
  return result.rows.map(({ id, correction }) => PublicCorrectionSchema.parse({
    id, publishedBeatId: correction.publishedBeatId, beatNumber: correction.beatNumber,
    stateRevision: correction.stateRevision, recordedAt: correction.recordedAt, publicText: correction.publicText,
  }));
}

export interface GalleryStatusSource { status(client: PoolClient, sessionId: string, sessionStatus: string): Promise<GalleryStatus> }
export async function project(client: PoolClient, sessionId: string, actor: Actor, requested?: Role, options: { picturesEnabled?: boolean; defaultPictureModel?: string; gallery?: GalleryStatusSource } = {}): Promise<SessionSnapshot> {
  await authorize(client, sessionId, actor);
  await client.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [sessionId]);
  const role = requested ?? (actor.role === 'host' ? 'director' : actor.role);
  if (role === 'director' && actor.role !== 'host') throw new AppError(403, 'forbidden', 'Director access is required.');
  if (role === 'player' && actor.role !== 'player') throw new AppError(403, 'forbidden', 'A player seat is required.');
  const state = await readState(client, sessionId);
  const beat = await currentBeat(client, sessionId);
  const eventSeq = Number((await client.query('SELECT COALESCE(MAX(sequence),0) AS seq FROM audit_events WHERE session_id=$1', [sessionId])).rows[0].seq);
  const publicBeat: PublicBeat | null = beat ? {
    id: beat.id, kind: beat.kind, phase: beat.phase, revision: beat.revision, locked: ['locked', 'draft_review'].includes(beat.phase),
    stakes: beat.stakesApproved ? beat.contracts.map((contract) => ({
      id: contract.id, version: contract.version, actorCharacterId: contract.actorCharacterId, helperCharacterIds: contract.helperCharacterIds,
      intent: contract.intent, approach: contract.approach, ruling: contract.ruling, trait: contract.trait,
      edge: contract.edge, edgeReason: contract.edgeReason, risk: contract.risk,
      outcomes: { clean: contract.outcomes.clean.publicText, costly: contract.outcomes.costly.publicText, setback: contract.outcomes.setback.publicText, ...(contract.outcomes.critical ? { critical: contract.outcomes.critical.publicText } : {}) },
    })) : [],
  } : null;
  const picturesEnabled = Boolean(options.picturesEnabled);
  const scenePicture = picturesEnabled ? await scenePictureView(client, sessionId, state.session.scene.id) : null;
  const base = {
    schemaVersion: 1 as const, session: state.session, eventSeq, picturesEnabled, scenePicture: scenePicture?.shown ?? null,
    characters: state.characters.filter((character) => role !== 'stage' || character.approved).map(({ id, displayName, traits, strain, appearance, approved, ready, portraitId }) => ({ id, displayName, traits, strain, appearance, approved, ready, portraitId })),
    npcs: state.npcs.map(({ id, displayName, role, appearance, status, voiceProfileId, portraitId }) => ({ id, displayName, role, appearance, status, voiceProfileId, portraitId })),
    tracks: state.tracks.filter((track) => track.visibility === 'public').map(({ id, label, kind, current, max, completionText, enabled }) => ({ id, label, kind, current, max, completionText, enabled })),
    facts: state.facts.filter((fact) => fact.visibility === 'public').map(({ id, text }) => ({ id, text })),
    history: await history(client, sessionId), corrections: await corrections(client, sessionId),
  };
  if (role === 'stage') return SessionSnapshotSchema.parse({ ...base, role, activeBeat: publicBeat });
  const all = await submissions(client, sessionId);
  if (role === 'player') return SessionSnapshotSchema.parse({ ...base, role, activeBeat: publicBeat,
    ownCharacter: state.characters.find((character) => character.id === actor.character_id) ?? null,
    submissions: all.filter((submission) => submission.characterId === actor.character_id), ...(state.setup ? { setup: { ...state.setup, boundaries: [] } } : {}),
  });
  const jobs = (await client.query('SELECT id,beat_id,task,generation,status,error FROM generation_jobs WHERE session_id=$1 ORDER BY created_at', [sessionId])).rows.map((row) => ({ id: row.id, beatId: row.beat_id, task: row.task, generation: row.generation, status: row.status, error: row.error }));
  return SessionSnapshotSchema.parse({ ...base, role, activeBeat: beat, submissions: all, npcDetails: state.npcs, locations: state.locations, characterDetails: state.characters, jobs, directorNotes: state.directorNotes, ...(state.setup ? { setup: state.setup } : {}),
    scenePictureStatus: scenePicture?.status ?? null,
    actionPicture: picturesEnabled && beat?.kind === 'action' && beat.phase === 'draft_review' ? await actionPictureView(client, sessionId, beat.id) : null,
    portraitJobs: picturesEnabled ? await portraitJobsView(client, sessionId, state.npcs.map(npc => npc.id)) : [],
    pictureSettings: picturesEnabled && options.defaultPictureModel ? await pictureSettingsOf(client, state, options.defaultPictureModel) : null,
    lastSceneBeatId: picturesEnabled ? await lastBeatInScene(client, sessionId) : null,
    ...(role === 'director' ? { gallery: options.gallery ? await options.gallery.status(client, sessionId, state.session.status) : null } : {}) });
}
