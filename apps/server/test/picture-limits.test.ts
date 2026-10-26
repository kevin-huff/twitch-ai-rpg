import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ProviderError } from '@rpg/providers';
import { createPool, migrate } from '../src/database';
import {
  PICTURE_MESSAGES, hourlyLimitMessage, minutesText, pictureFailure, pictureLimitMessage,
  type PictureLimitSettings,
} from '../src/picture-limits';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const limits: PictureLimitSettings = { hourly: 5 };

describe('picture sentences', () => {
  it('writes minutes in plain words', () => {
    expect(minutesText(1)).toBe('1 minute');
    expect(minutesText(2)).toBe('2 minutes');
    expect(hourlyLimitMessage(1)).toBe('The picture limit for this hour is used up. Try again in 1 minute.');
    expect(hourlyLimitMessage(12)).toBe('The picture limit for this hour is used up. Try again in 12 minutes.');
  });

  it('holds the agreed sentences', () => {
    expect(PICTURE_MESSAGES).toEqual({
      sceneFailed: 'The picture could not be made. Press Draw the place to try again.',
      npcFailed: 'The portrait could not be made. Press Create portrait to try again.',
      cardFailed: 'The portrait could not be made. Press Try again.',
      busy: 'Pictures are busy right now. Try again in a minute.',
      off: 'Pictures are off on this server.',
      sceneSafety: 'The picture service would not draw this scene. Press Draw the place to try again.',
      beatFailed: 'The picture of the last beat could not be made. Press Draw the last beat to try again.',
      beatSafety: 'The picture service would not draw this beat. Press Draw the last beat to try again.',
      startedOver: 'A newer picture was asked for before this one was made.',
      portraitSafety: 'The picture service would not draw this portrait. Change the appearance, then try again.',
      credit: 'The picture service account is out of credit. Ask the host to check it.',
      key: "The picture service did not accept this server's key. Ask the host to check the setup.",
      superseded: 'The scene changed before the picture was made.',
      actionSuperseded: 'The action round changed before its picture was shown.',
      newerMoment: 'A newer moment reached the stream before this picture was made.',
    });
  });
});

describe('pictureFailure', () => {
  const failed = (message: string) => ({ status: 502, code: 'picture_failed', message });

  it('explains a refused picture by what was drawn', () => {
    const refused = new ProviderError('http_error', 'Sogni', 200, 'safety');
    expect(pictureFailure(refused, 'scene')).toEqual(failed(PICTURE_MESSAGES.sceneSafety));
    for (const purpose of ['npc', 'character', 'card'] as const) {
      expect(pictureFailure(refused, purpose)).toEqual(failed(PICTURE_MESSAGES.portraitSafety));
    }
  });

  it('gives the beat sentences for a beat picture', () => {
    const refused = new ProviderError('http_error', 'Sogni', 200, 'safety');
    const generic = new ProviderError('http_error', 'Sogni', 500);
    expect(pictureFailure(refused, 'scene', true)).toEqual(failed(PICTURE_MESSAGES.beatSafety));
    expect(pictureFailure(generic, 'scene', true)).toEqual(failed(PICTURE_MESSAGES.beatFailed));
    expect(pictureFailure(new Error('boom'), 'scene', true)).toEqual(failed(PICTURE_MESSAGES.beatFailed));
    expect(pictureFailure(refused, 'scene')).toEqual(failed(PICTURE_MESSAGES.sceneSafety));
    expect(pictureFailure(generic, 'scene')).toEqual(failed(PICTURE_MESSAGES.sceneFailed));
  });

  it('keeps credit, key and busy answers for a beat picture', () => {
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 200, 'credit'), 'scene', true)).toEqual(failed(PICTURE_MESSAGES.credit));
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 401), 'scene', true)).toEqual(failed(PICTURE_MESSAGES.key));
    expect(pictureFailure(new ProviderError('configuration', 'Sogni'), 'scene', true)).toEqual(failed(PICTURE_MESSAGES.key));
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 429), 'scene', true))
      .toEqual({ status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
  });

  it('reports an account out of credit', () => {
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 200, 'credit'), 'scene')).toEqual(failed(PICTURE_MESSAGES.credit));
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 402), 'npc')).toEqual(failed(PICTURE_MESSAGES.credit));
  });

  it('reports a key the service did not accept', () => {
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 401), 'card')).toEqual(failed(PICTURE_MESSAGES.key));
    expect(pictureFailure(new ProviderError('http_error', 'Sogni', 403), 'scene')).toEqual(failed(PICTURE_MESSAGES.key));
    expect(pictureFailure(new ProviderError('configuration', 'Sogni'), 'npc')).toEqual(failed(PICTURE_MESSAGES.key));
  });

  it('answers busy for a crowded or rate limited service', () => {
    for (const status of [409, 429]) {
      expect(pictureFailure(new ProviderError('http_error', 'Sogni', status), 'scene'))
        .toEqual({ status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
    }
  });

  it('falls back to the sentence for the kind of picture', () => {
    const other = [new ProviderError('http_error', 'Sogni', 500), new ProviderError('network_error', 'Sogni'), new Error('boom'), 'oops', null];
    for (const error of other) {
      expect(pictureFailure(error, 'scene')).toEqual(failed(PICTURE_MESSAGES.sceneFailed));
      expect(pictureFailure(error, 'npc')).toEqual(failed(PICTURE_MESSAGES.npcFailed));
      expect(pictureFailure(error, 'character')).toEqual(failed(PICTURE_MESSAGES.cardFailed));
      expect(pictureFailure(error, 'card')).toEqual(failed(PICTURE_MESSAGES.cardFailed));
    }
  });
});

suite('picture limits', () => {
  let pool: Pool;
  let client: PoolClient;
  let sessionId: string;

  interface Row {
    purpose?: 'scene' | 'npc' | 'character' | 'card';
    sessionId?: string | null;
    limitKey?: string;
    status?: 'making' | 'ready' | 'failed' | 'cancelled';
    ageMinutes?: number;
    ageSeconds?: number;
    started?: boolean;
  }

  async function insert(count: number, row: Row = {}) {
    const purpose = row.purpose ?? 'card';
    const status = row.status ?? 'ready';
    const session = row.sessionId === undefined ? (purpose === 'scene' || purpose === 'character' ? sessionId : null) : row.sessionId;
    const age = (row.ageMinutes ?? 0) * 60 + (row.ageSeconds ?? 0);
    for (let index = 0; index < count; index += 1) {
      await pool.query(
        `INSERT INTO images (id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model,
           requested_by, file_hash, content_type, byte_length, created_at, started_at)
         VALUES ($1, 'owner', $2, $3, 'subject', $4, $5, 'a prompt', 768, 768, 'fake', 'fake-image', 'owner',
           $6, $7, $8, clock_timestamp() - make_interval(secs => $9), CASE WHEN $10 THEN clock_timestamp() - make_interval(secs => $9) END)`,
        [
          randomUUID(), session, purpose, row.limitKey ?? `library:owner:${randomUUID()}`, status,
          status === 'ready' ? 'a'.repeat(64) : null, status === 'ready' ? 'image/jpeg' : null, status === 'ready' ? 1000 : null,
          age, row.started ?? (status !== 'cancelled' && status !== 'failed'),
        ],
      );
    }
  }

  const check = (_request: unknown = {}, settings: PictureLimitSettings = limits) => pictureLimitMessage(client, settings);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    client = await pool.connect();
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    sessionId = `limits-${randomUUID()}`;
    await pool.query(`INSERT INTO sessions (id, owner_id, title, scene) VALUES ($1, 'owner', 'Limits', '{}'::jsonb)`, [sessionId]);
  });

  it('allows a request when nothing has been made', async () => {
    expect(await check({})).toBeNull();
    expect(await check({ sessionId, purpose: 'scene', limitKey: `scene:${sessionId}` })).toBeNull();
  });

  it('stops at the hourly limit and says when to try again', async () => {
    await insert(4, { ageMinutes: 10 });
    expect(await check({})).toBeNull();
    await insert(1, { ageMinutes: 30 });
    expect(await check({})).toBe(hourlyLimitMessage(30));
  });

  it('rounds the wait up to whole minutes and never below one', async () => {
    await insert(5, { ageSeconds: 59 * 60 + 30 });
    expect(await check({})).toBe('The picture limit for this hour is used up. Try again in 1 minute.');
    await pool.query('DELETE FROM images');
    await insert(1, { ageSeconds: 50 * 60 + 5 });
    await insert(4, { ageMinutes: 1 });
    expect(await check({})).toBe(hourlyLimitMessage(10));
    await pool.query('DELETE FROM images');
    await insert(5, { ageSeconds: 3599 });
    expect(await check({})).toBe(hourlyLimitMessage(1));
  });

  it('uses the oldest counted row in the window for the wait', async () => {
    await insert(1, { ageMinutes: 50 });
    await insert(4, { ageMinutes: 5 });
    expect(await check({})).toBe(hourlyLimitMessage(10));
  });

  it('ignores rows older than an hour for the hourly limit', async () => {
    await insert(5, { ageMinutes: 61 });
    expect(await check({})).toBeNull();
  });

  it('counts making rows and rows that reached the service, failures and cancellations included', async () => {
    await insert(1, { status: 'making', started: false });
    await insert(1, { status: 'ready' });
    await insert(1, { status: 'failed', started: true });
    await insert(1, { status: 'cancelled', started: true });
    expect(await check({})).toBeNull();
    await insert(1, { status: 'making', started: false });
    expect(await check({})).toBe(hourlyLimitMessage(60));
  });

  it('does not count rows cancelled before starting or limit failures', async () => {
    await insert(3, { status: 'cancelled', started: false });
    await insert(3, { status: 'failed', started: false });
    expect(await check({})).toBeNull();
    expect(await check({}, { hourly: 1 })).toBeNull();
  });

  it('refuses nothing when no hourly limit is set', async () => {
    await insert(300, { purpose: 'scene', limitKey: `scene:${sessionId}` });
    await insert(30, { purpose: 'card', limitKey: 'library:owner:alice' });
    expect(await check({ sessionId, purpose: 'scene' }, { hourly: null })).toBeNull();
    expect(await check({ purpose: 'card' }, { hourly: null })).toBeNull();
  });
});
