// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_STILL_WORKING, createTable } from './table';
import { USED_INVITATION, rememberSeat } from './seat-memory';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn() }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));

type Settle = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

function holdCommands() {
  const held: Settle[] = [];
  transport.command.mockImplementation(() => new Promise((resolve, reject) => { held.push({ resolve, reject }); }));
  return held;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const plan = { type: 'plan_beat', commandId: 'c-plan' } as never;
const render = { type: 'render_beat', commandId: 'c-render' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/sessions/show-1/director');
  transport.snapshot.mockResolvedValue(null);
  transport.subscribe.mockReturnValue(() => {});
});

describe('table after a dropped AI request', () => {
  const director = (status: string) => ({ role: 'director', activeBeat: { id: 'beat-1', generation: 3 }, jobs: [{ id: 'job-1', beatId: 'beat-1', task: 'plan', generation: 3, status, error: null }] });

  it('refreshes and waits quietly when the connection drops while the AI is still working', async () => {
    transport.command.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    transport.snapshot.mockResolvedValue(director('running'));
    const table = createTable();
    await expect(table.send(plan)).resolves.toBeUndefined();
    expect(transport.snapshot).toHaveBeenCalled();
    expect(table.notice.value).toBe(AI_STILL_WORKING);
    expect(table.aiWorking.value).toBe(false);
  });

  it('treats a gateway timeout from the host the same way', async () => {
    transport.command.mockRejectedValueOnce(Object.assign(new Error('Request failed (504).'), { status: 504 }));
    transport.snapshot.mockResolvedValue(director('running'));
    const table = createTable();
    await expect(table.send(render)).resolves.toBeUndefined();
    expect(table.notice.value).toBe(AI_STILL_WORKING);
  });

  it('reports the dropped request when the server is not still working on it', async () => {
    transport.command.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    transport.snapshot.mockResolvedValue(director('failed'));
    const table = createTable();
    await expect(table.send(plan)).rejects.toThrow('Failed to fetch');
    expect(table.notice.value).toBe('');
  });

  it('reports an error the app itself sent, as before', async () => {
    transport.command.mockRejectedValueOnce(Object.assign(new Error('This beat is already locked.'), { status: 409 }));
    transport.snapshot.mockResolvedValue(director('running'));
    const table = createTable();
    await expect(table.send(plan)).rejects.toThrow('This beat is already locked.');
  });

  it('reports a dropped request for commands that are not plan or render requests', async () => {
    transport.command.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    transport.snapshot.mockResolvedValue(director('running'));
    const table = createTable();
    await expect(table.send({ type: 'set_guidance', commandId: 'c-guidance', standingNote: '' } as never)).rejects.toThrow('Failed to fetch');
  });
});

describe('table aiWorking', () => {
  it('stays true until both of two overlapping AI requests have ended', async () => {
    const held = holdCommands();
    const table = createTable();
    expect(table.aiWorking.value).toBe(false);
    const first = table.send(plan);
    const second = table.send(render);
    expect(held).toHaveLength(2);
    expect(table.aiWorking.value).toBe(true);
    held[0]!.resolve(null);
    await settle();
    expect(table.aiWorking.value).toBe(true);
    held[1]!.resolve(null);
    await Promise.all([first, second]);
    expect(table.aiWorking.value).toBe(false);
  });

  it('stays true when the older request ends last, and when the first one fails', async () => {
    const held = holdCommands();
    const table = createTable();
    const first = table.send(plan).catch(() => {});
    const second = table.send(plan);
    held[0]!.reject(new Error('The AI could not finish.'));
    await first;
    expect(table.aiWorking.value).toBe(true);
    held[1]!.resolve(null);
    await second;
    expect(table.aiWorking.value).toBe(false);
  });

  it('is not raised by commands that are not plan or render requests', async () => {
    const held = holdCommands();
    const table = createTable();
    const sending = table.send({ type: 'set_guidance', commandId: 'c-guidance', standingNote: '' } as never);
    expect(table.aiWorking.value).toBe(false);
    held[0]!.resolve(null);
    await sending;
    expect(table.aiWorking.value).toBe(false);
  });
});

describe('table after a request that never reached the server', () => {
  it('treats status 0 like a dropped connection and waits quietly while the AI works', async () => {
    transport.command.mockRejectedValueOnce(Object.assign(new Error('Could not reach the show.'), { status: 0 }));
    transport.snapshot.mockResolvedValue({ role: 'director', activeBeat: { id: 'beat-1', generation: 3 }, jobs: [{ id: 'job-1', beatId: 'beat-1', task: 'plan', generation: 3, status: 'running', error: null }] });
    const table = createTable();
    await expect(table.send(plan)).resolves.toBeUndefined();
    expect(table.notice.value).toBe(AI_STILL_WORKING);
  });
});

describe('table connectionLost', () => {
  const connect = () => { let report: (value: boolean) => void = () => {}; transport.subscribe.mockImplementation((_id: string, _refresh: () => void, connection: (value: boolean) => void) => { report = connection; return () => {}; }); return (value: boolean) => report(value); };

  it('is false while the first connection is still being made', async () => {
    connect();
    transport.snapshot.mockResolvedValue({ role: 'player', characters: [] });
    const table = createTable();
    await table.restoreSession();
    expect(table.connected.value).toBe(false);
    expect(table.connectionLost.value).toBe(false);
  });

  it('turns on after a failed first attempt and off again on connect', async () => {
    const report = connect();
    transport.snapshot.mockResolvedValue({ role: 'player', characters: [] });
    const table = createTable();
    await table.restoreSession();
    report(false);
    expect(table.connectionLost.value).toBe(true);
    report(true);
    expect(table.connectionLost.value).toBe(false);
    expect(table.connected.value).toBe(true);
  });

  it('turns on when a connection that was up drops', async () => {
    const report = connect();
    transport.snapshot.mockResolvedValue({ role: 'player', characters: [] });
    const table = createTable();
    await table.restoreSession();
    report(true);
    expect(table.connectionLost.value).toBe(false);
    report(false);
    expect(table.connectionLost.value).toBe(true);
  });
});

describe('table seat return', () => {
  const sessionId = 'show-1';
  const seat = (identityId: string, role: 'player' | 'stage' = 'player', session = sessionId) => rememberSeat({ token: `token-${identityId}`, identityId, sessionId: session, role });
  const idA = 'a'.repeat(32);
  const idB = 'b'.repeat(32);

  it('opens the one remembered player seat when the play page has no identity', async () => {
    seat(idA);
    window.history.replaceState({}, '', '/sessions/show-1/play');
    transport.snapshot.mockResolvedValue(null);
    const table = createTable();
    await table.restoreSession();
    expect(window.location.search).toBe(`?identity=${idA}`);
  });

  it('does nothing with no remembered seat, with two, or for another show', async () => {
    window.history.replaceState({}, '', '/sessions/show-1/play');
    await createTable().restoreSession();
    expect(window.location.search).toBe('');
    seat(idA); seat(idB);
    await createTable().restoreSession();
    expect(window.location.search).toBe('');
    window.localStorage.clear();
    seat(idA, 'player', 'other-show'); seat(idB, 'stage');
    await createTable().restoreSession();
    expect(window.location.search).toBe('');
  });

  it('leaves an address that already carries an identity, and the other views, alone', async () => {
    seat(idA);
    window.history.replaceState({}, '', `/sessions/show-1/play?identity=${idB}`);
    await createTable().restoreSession();
    expect(window.location.search).toBe(`?identity=${idB}`);
    window.history.replaceState({}, '', '/sessions/show-1/director');
    await createTable().restoreSession();
    expect(window.location.search).toBe('');
  });

  it('leaves a test seat address alone', async () => {
    seat(idA);
    window.history.replaceState({}, '', '/sessions/show-1/play?testCharacterId=c1');
    const testSeat = vi.fn().mockRejectedValue(new Error('no'));
    (transport as Record<string, unknown>).testSeat = testSeat;
    await createTable().restoreSession();
    expect(window.location.search).toBe('?testCharacterId=c1');
  });

  it('forgets the seat and shows the used-invitation message when the seat answers 401', async () => {
    seat(idA);
    window.history.replaceState({}, '', `/sessions/show-1/play?identity=${idA}`);
    transport.snapshot.mockRejectedValue(Object.assign(new Error('Sign in again.'), { status: 401 }));
    const table = createTable();
    await table.refresh();
    expect(table.error.value).toBe(USED_INVITATION);
    window.history.replaceState({}, '', '/sessions/show-1/play');
    transport.snapshot.mockResolvedValue(null);
    await createTable().restoreSession();
    expect(window.location.search).toBe('');
  });

  it('keeps the server words for a 401 when nothing was remembered', async () => {
    window.history.replaceState({}, '', `/sessions/show-1/play?identity=${idA}`);
    transport.snapshot.mockRejectedValue(Object.assign(new Error('Sign in again.'), { status: 401 }));
    const table = createTable();
    await table.refresh();
    expect(table.error.value).toBe('Sign in again.');
  });
});

describe('table publicationLines for a rescue', () => {
  const effect = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, characterId: 'rook', ...extra });
  const lines = (groups: unknown[][]) => {
    transport.snapshot.mockResolvedValue(null);
    const table = createTable();
    table.snapshot.value = { role: 'director', characters: [{ id: 'rook', displayName: 'Rook', strain: 8, condition: 'down' }], npcs: [], tracks: [] } as never;
    return table.publicationLines({ rolls: [], outcomes: [], effects: groups.flat(), effectGroups: groups } as never);
  };

  it('shows the rescue result without a past-full flag when a strain hit lands in the same group', () => {
    const result = lines([[effect('strain_delta', { delta: 1 }), effect('character_rescue')]]);
    expect(result).toContain('Rook strain 8 to 6 of 8');
    expect(result.join('\n')).not.toContain('past full');
  });

  it('still flags a strain hit on a downed character who is not rescued', () => {
    expect(lines([[effect('strain_delta', { delta: 1 })]])).toContain('Rook strain 8 to 8 of 8 · 1 past full');
  });
});
