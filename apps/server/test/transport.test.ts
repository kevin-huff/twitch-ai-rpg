import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { Pool } from 'pg';
import { buildApp } from '../src/app';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('browser notifications and seed provenance', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let cookie: string;
  let sessionId: string;
  const origin = 'http://localhost:3000';
  beforeAll(async () => {
    const hostToken = 'transport-test-host-credential-32-characters';
    app = await buildApp({ databaseUrl: process.env.TEST_DATABASE_URL!, origin, hostToken });
    const login = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    cookie = String(login.headers['set-cookie']).split(';')[0];
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie }, payload: { commandId: crypto.randomUUID() } });
    sessionId = created.json().sessionId;
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await app?.close(); });
  it('accepts authenticated same-origin polling without an Origin header and delivers invalidations', async () => {
    const client = io(base, { transports: ['polling'], auth: { sessionId }, extraHeaders: { cookie }, reconnection: false, timeout: 2000 });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      const event = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No durable notification delivered.')), 3000);
        client.once('session.snapshot_available', value => { clearTimeout(timeout); resolve(value); });
      });
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/commands`, headers: { origin, cookie }, payload: { commandId: crypto.randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: 0 } });
      const data = await event;
      expect(data.sessionId).toBe(sessionId);
      expect(Object.keys(data).sort()).toEqual(['eventId', 'eventSeq', 'schemaVersion', 'sessionId']);
    } finally { client.disconnect(); }
  });
  it('rejects an explicit foreign Origin even with a valid cookie', async () => {
    const client = io(base, { transports: ['polling'], auth: { sessionId }, extraHeaders: { cookie, Origin: 'https://untrusted.example' }, reconnection: false, timeout: 1000 });
    try { await expect(new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); })).rejects.toThrow(); }
    finally { client.disconnect(); }
  });
  it('backs initial facts, relationships, and knowledge with a persisted audit event', async () => {
    const result = await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie } });
    const state = result.json();
    const ids = new Set<string>(state.npcDetails.flatMap((npc: any) => [...npc.knowledge, ...npc.relationships].map((record: any) => record.sourceEventId)));
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      for (const id of ids) expect((await pool.query('SELECT id FROM audit_events WHERE session_id=$1 AND id=$2', [sessionId, id])).rowCount).toBe(1);
    } finally { await pool.end(); }
  });
});
