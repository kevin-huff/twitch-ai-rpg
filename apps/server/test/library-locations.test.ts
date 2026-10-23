import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { materializeSession, starterDefinitions } from '../src/library';

it('materializes every authored location with fresh stable references while retaining the original definition snapshot', async () => {
  const { scenario, characters } = starterDefinitions();
  const query = vi.fn(async (_sql: string, values: unknown[]) => ({ rowCount: 1, rows: [{ id: values[2], version: 1, definition: values[1] === 'scenarios' ? scenario : characters[0] }] }));
  const result = await materializeSession({ query } as unknown as PoolClient, 'owner', 'session', { templateId: 'scenario', version: 1 }, [{ templateId: 'character', version: 1 }, { templateId: 'character', version: 1 }]);
  expect(result.state.locations.map(location => location.title)).toEqual(scenario.locations.map(location => location.title));
  expect(result.state.locations.map(location => location.description)).toEqual(scenario.locations.map(location => location.description));
  for (const location of result.state.locations) expect(scenario.locations.some(original => original.id === location.id)).toBe(false);
  expect(new Set(result.state.locations.map(location => location.id)).size).toBe(scenario.locations.length);
  const current = result.state.locations.find(location => location.title === 'Public bar')!;
  expect(result.state.session.scene.locationId).toBe(current.id);
  expect(result.state.npcs.find(npc => npc.displayName === 'Mara Vale')!.locationId).toBe(current.id);
  expect(result.state.npcs.find(npc => npc.displayName === 'Biscuit')!.locationId).toBe(result.state.locations.find(location => location.title === 'Service corridor')!.id);
  expect(result.scenarioSnapshot.definition).toEqual(scenario);
});
