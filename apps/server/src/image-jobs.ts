import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  MOMENT_MODEL, PICTURE_NEGATIVE_PROMPT, PictureMomentSchema, type AiProvider, type ImageContentType, type ImageProvider, type ImageReference, type PictureMoment,
} from '@rpg/contracts';
import { recordEvent } from './commands';
import { transaction } from './database';
import { readImageFile, storeImage } from './image-files';
import type { ImageSlots } from './image-slots';
import { PICTURE_MESSAGES, pictureFailure } from './picture-limits';
import { cleanDescription, descriptionBudget, fallbackDescription, momentPrompt, pictureDescriptionRequest } from './picture-prompts';
import type { ImageRow } from './picture-views';

export interface ImageJobContext {
  pool: Pool;
  provider: ImageProvider;
  assetDir: string;
  slots: ImageSlots;
  ai?: AiProvider;
}

export type ImageJobOutcome =
  | { status: 'ready' }
  | { status: 'failed' | 'cancelled'; httpStatus: number; code: string; message: string }
  | { status: 'skipped' };

type Ended = { status: 'failed' | 'cancelled'; httpStatus: number; code: string; message: string };

// Events wake every screen of the show; they name the picture, never its prompt.
async function pictureEvent(client: PoolClient, row: ImageRow, kind: string) {
  const session = await client.query<{ version: number }>('SELECT version FROM sessions WHERE id=$1 FOR UPDATE', [row.session_id]);
  if (!session.rowCount) return;
  await recordEvent(client, row.session_id!, { actor_id: row.requested_by, producer_grant_id: row.producer_grant_id }, randomUUID(), kind,
    session.rows[0]!.version, { imageId: row.id, purpose: row.purpose, subjectId: row.subject_id });
}

// Only scene rows and portraits headed for a live non-player character have people waiting on an event.
function failureKind(row: ImageRow): string | null {
  if (row.purpose === 'scene' && row.session_id) return 'picture.failed';
  if (row.attach && row.session_id) return 'portrait.failed';
  return null;
}

async function end(context: ImageJobContext, row: ImageRow, outcome: Ended): Promise<Ended> {
  try {
    await transaction(context.pool, async (client) => {
      const kind = failureKind(row);
      if (kind) await client.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [row.session_id]);
      const updated = await client.query("UPDATE images SET status=$2, message=$3, finished_at=clock_timestamp() WHERE id=$1 AND status='making'",
        [row.id, outcome.status, outcome.message]);
      if (updated.rowCount && kind) await pictureEvent(client, row, kind);
    });
  } catch { /* The row stays making; the next restart fails it. */ }
  return outcome;
}

// A scene picture is only worth making while its scene is still on screen and the show is still running; an action picture also only while its round is open or released; a portrait only while its character is still in the show.
async function stillWanted(pool: Pool, row: ImageRow): Promise<Ended | null> {
  if (row.purpose === 'scene' && row.session_id) {
    const session = await pool.query<{ scene_id: string; status: string }>("SELECT scene->>'id' AS scene_id, status FROM sessions WHERE id=$1", [row.session_id]);
    const current = session.rows[0];
    if (!current || current.status === 'ended' || current.scene_id !== row.subject_id) {
      return { status: 'cancelled', httpStatus: 409, code: 'conflict', message: PICTURE_MESSAGES.superseded };
    }
  }
  if (row.beat_id && row.session_id) {
    // A held picture of a round that closed without being released would never be shown, so it is not worth a call.
    const closed = await pool.query(
      "SELECT 1 FROM images i JOIN beats b ON b.id=i.beat_id AND b.session_id=i.session_id WHERE i.id=$1 AND i.released_at IS NULL AND b.phase IN ('published','aborted')", [row.id]);
    if (closed.rowCount) return { status: 'cancelled', httpStatus: 409, code: 'conflict', message: PICTURE_MESSAGES.actionSuperseded };
  }
  if (row.attach && row.session_id) {
    const npc = await pool.query('SELECT 1 FROM npcs WHERE session_id=$1 AND id=$2', [row.session_id, row.subject_id]);
    if (!npc.rowCount) return { status: 'cancelled', httpStatus: 404, code: 'not_found', message: 'That character is not in this session.' };
  }
  return null;
}

async function finishReady(context: ImageJobContext, row: ImageRow, file: { fileHash: string; contentType: string; byteLength: number }, workflowId: string | null): Promise<boolean> {
  return transaction(context.pool, async (client) => {
    const session = row.session_id
      ? (await client.query<{ scene_id: string }>("SELECT scene->>'id' AS scene_id FROM sessions WHERE id=$1 FOR UPDATE", [row.session_id])).rows[0]
      : undefined;
    const updated = await client.query<Pick<ImageRow, 'attach'>>(
      "UPDATE images SET status='ready', file_hash=$2, content_type=$3, byte_length=$4, workflow_id=$5, message=NULL, finished_at=clock_timestamp() WHERE id=$1 AND status='making' RETURNING attach",
      [row.id, file.fileHash, file.contentType, file.byteLength, workflowId]);
    if (!updated.rowCount) return false;
    if (row.purpose === 'scene' && session) {
      if (session.scene_id === row.subject_id) await pictureEvent(client, row, 'picture.ready');
    } else if (row.purpose === 'npc' && session && updated.rows[0]!.attach) {
      // A later request for the same character wins, even when this one finishes last.
      const newest = await client.query<{ id: string }>(
        "SELECT id FROM images WHERE session_id=$1 AND purpose='npc' AND subject_id=$2 AND attach ORDER BY created_at DESC, id DESC LIMIT 1",
        [row.session_id, row.subject_id]);
      if (newest.rows[0]?.id === row.id) {
        const attached = await client.query("UPDATE npcs SET data=jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2",
          [row.session_id, row.subject_id, row.id]);
        if (attached.rowCount) await pictureEvent(client, row, 'portrait.ready');
      }
    }
    return true;
  });
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The picture job was cancelled.');
  error.name = 'AbortError';
  return error;
}

// Settles with the work, or rejects as soon as the job is stopped.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// The portrait bytes of each numbered person, in cast order; a missing row or file leaves that person out, to be drawn from words.
async function portraitFiles(context: ImageJobContext, moment: PictureMoment): Promise<{ index: number; bytes: Uint8Array }[]> {
  const wanted = moment.cast.flatMap((person, index) => (person.imageNumber !== null && person.portraitId ? [{ index, portraitId: person.portraitId }] : []));
  if (wanted.length === 0) return [];
  const { rows } = await context.pool.query<{ id: string; file_hash: string; content_type: ImageContentType }>(
    "SELECT id, file_hash, content_type FROM images WHERE id = ANY($1::uuid[]) AND status='ready' AND file_hash IS NOT NULL AND content_type IS NOT NULL",
    [wanted.map(person => person.portraitId)]);
  const files = await Promise.all(wanted.map(async (person): Promise<{ index: number; bytes: Uint8Array } | null> => {
    const row = rows.find(candidate => candidate.id === person.portraitId);
    if (!row) return null;
    try {
      return { index: person.index, bytes: new Uint8Array(await readImageFile(context.assetDir, row)) };
    } catch {
      return null;
    }
  }));
  return files.filter((file): file is { index: number; bytes: Uint8Array } => file !== null);
}

// Reads, uploads and numbers the portraits, writes the description and saves the final prompt and model before the picture waits for a slot. The handles live only in memory.
async function prepareMoment(context: ImageJobContext, row: ImageRow, moment: PictureMoment, signal: AbortSignal):
  Promise<{ prompt: string; model: string; references: ImageReference[] } | null> {
  const files = await portraitFiles(context, moment);
  let handles: (ImageReference | null)[] = files.map(() => null);
  if (files.length > 0 && context.provider.prepareReferences) {
    try {
      handles = await untilAborted(context.provider.prepareReferences(files.map(file => file.bytes), { requestId: row.id, signal }), signal);
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const uploaded = new Map<number, ImageReference>();
  files.forEach((file, position) => {
    const handle = handles[position];
    if (handle) uploaded.set(file.index, handle);
  });
  const references: ImageReference[] = [];
  const settled: PictureMoment = {
    ...moment,
    cast: moment.cast.map((person, index) => {
      const handle = uploaded.get(index);
      if (!handle) return { ...person, portraitId: null, imageNumber: null };
      references.push(handle);
      return { ...person, imageNumber: references.length };
    }),
  };
  const withReferences = references.length > 0;
  const budget = descriptionBudget(moment.style, withReferences);
  let description = '';
  if (context.ai?.describePicture) {
    try {
      const reply = await untilAborted(context.ai.describePicture(pictureDescriptionRequest(settled, budget)), signal);
      description = cleanDescription(reply, moment.names, budget);
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  if (description === '') description = fallbackDescription(settled, budget);
  const prompt = momentPrompt(moment.style, description, withReferences);
  const model = withReferences ? MOMENT_MODEL : moment.model;
  const saved = await context.pool.query("UPDATE images SET prompt=$2, model=$3 WHERE id=$1 AND status='making'", [row.id, prompt, model]);
  return saved.rowCount ? { prompt, model, references } : null;
}

function pictureTitle(row: ImageRow): string {
  if (row.beat_id) return 'Action picture';
  if (row.moment) return 'Beat picture';
  return row.purpose === 'scene' ? 'Scene picture' : 'Portrait';
}

// Rows that never reached the picture service (the database hiccuped before the job could read them) end failed with the usual message instead of staying making.
export async function failUnstarted(context: ImageJobContext, imageIds: string[]): Promise<void> {
  try {
    const { rows } = await context.pool.query<ImageRow>("SELECT * FROM images WHERE id = ANY($1::uuid[]) AND status='making' AND started_at IS NULL", [imageIds]);
    for (const row of rows) {
      const failure = pictureFailure(null, row.purpose, row.moment !== null);
      await end(context, row, { status: 'failed', httpStatus: failure.status, code: failure.code, message: failure.message });
    }
  } catch { /* The rows stay making; the next restart fails them. */ }
}

// Runs one reserved picture from the queue to a stored file. Every way out leaves the row finished (or untouched when someone else finished it), and nothing is thrown.
export async function runImageJob(context: ImageJobContext, imageId: string, signal: AbortSignal): Promise<ImageJobOutcome> {
  let row: ImageRow | undefined;
  try {
    row = (await context.pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [imageId])).rows[0];
  } catch {
    await failUnstarted(context, [imageId]);
    return { status: 'skipped' };
  }
  if (!row || row.status !== 'making') return { status: 'skipped' };
  let release: (() => void) | null = null;
  try {
    let drawing: { prompt: string; model: string; references: ImageReference[] } = { prompt: row.prompt, model: row.model, references: [] };
    if (row.moment !== null) {
      const unwanted = await stillWanted(context.pool, row);
      if (unwanted) return await end(context, row, unwanted);
      const moment = PictureMomentSchema.safeParse(row.moment);
      if (!moment.success) {
        const failure = pictureFailure(null, row.purpose, true);
        return await end(context, row, { status: 'failed', httpStatus: failure.status, code: failure.code, message: failure.message });
      }
      const prepared = await prepareMoment(context, row, moment.data, signal);
      if (!prepared) return { status: 'skipped' };
      drawing = prepared;
    }
    release = await context.slots.acquire(row.purpose === 'scene' ? 'scene' : 'normal', signal);
    const unwanted = await stillWanted(context.pool, row);
    if (unwanted) return await end(context, row, unwanted);
    const started = await context.pool.query("UPDATE images SET started_at=clock_timestamp() WHERE id=$1 AND status='making' AND started_at IS NULL", [row.id]);
    if (!started.rowCount) return { status: 'skipped' };
    const result = await context.provider.generate({
      prompt: drawing.prompt, negativePrompt: PICTURE_NEGATIVE_PROMPT, width: row.width, height: row.height, requestId: row.id, model: drawing.model,
      title: pictureTitle(row), signal, ...(drawing.references.length > 0 ? { references: drawing.references } : {}),
    });
    const file = await storeImage(context.assetDir, result.bytes);
    return await finishReady(context, row, file, result.workflowId) ? { status: 'ready' } : { status: 'skipped' };
  } catch (error) {
    const failure = pictureFailure(error, row.purpose, row.moment !== null);
    // A scene picture stopped because the director moved on reads as superseded rather than as a failure.
    const superseded = signal.aborted && row.purpose === 'scene' ? await stillWanted(context.pool, row).catch(() => null) : null;
    return end(context, row, superseded ?? { status: signal.aborted ? 'cancelled' : 'failed', httpStatus: failure.status, code: failure.code, message: failure.message });
  } finally {
    release?.();
  }
}
