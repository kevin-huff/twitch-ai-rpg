import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { FakeAiProvider } from '../src/fake-provider';
import { executeCommand } from '../src/commands';
import { AppError } from '../src/repository';

describe('publication credentials during lock waits', () => {
  it('rechecks the selected credential after the session lock and before receipt replay', async () => {
    let acquired!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const lock = new Promise<void>(resolve => { acquired = resolve; });
    const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) { entered(); await lock; return { rows: [{ id: 'session' }], rowCount: 1 }; }
      if (sql.includes('SELECT * FROM sessions')) return { rows: [{ id: 'session', owner_id: 'owner' }], rowCount: 1 };
      if (sql.includes('command_receipts')) return { rows: [{ request_hash: '', response: {} }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }) };
    const authenticate = vi.fn(async () => { throw new AppError(401, 'unauthorized', 'Sign in again.'); });
    const result = executeCommand({ pool: { connect: async () => client } as unknown as Pool, provider: new FakeAiProvider(), rollDie: () => 1, authenticate }, 'session', { actor_id: 'owner', role: 'host', session_id: null, character_id: null }, { type: 'publish_beat', commandId: 'retry', beatId: 'beat', expectedBeatRevision: 3, expectedStateRevision: 1, draftRevision: 2, textOnly: true });
    const rejected = expect(result).rejects.toMatchObject({ status: 401 });
    await waiting;
    expect(authenticate).not.toHaveBeenCalled();
    acquired();
    await rejected;
    expect(authenticate).toHaveBeenCalledWith(client);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('command_receipts'))).toBe(false);
  });
});
