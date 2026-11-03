// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTable } from './table';

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
  window.history.replaceState({}, '', '/sessions/show-1/director');
  transport.snapshot.mockResolvedValue(null);
  transport.subscribe.mockReturnValue(() => {});
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
