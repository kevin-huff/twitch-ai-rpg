import { describe, expect, it } from 'vitest';
import { CommandSchema, SessionSnapshotSchema } from './index';

const base = { commandId: 'cmd', expectedStateRevision: 4, reason: 'The party follows the clue.', discardQueuedInput: true };
const profile = { displayName: 'The Courier', role: 'Messenger', locationId: 'platform', status: 'present', voiceProfileId: 'voice_narrator' };
const scene = { type: 'change_scene', ...base, title: 'Midnight departure', description: 'A train waits.', location: { kind: 'existing', locationId: 'platform' }, presentNpcIds: ['courier'] };
const save = { type: 'save_npc', ...base, expectedNpcVersion: 0, profile };
const reveal = { type: 'reveal_npc', ...base, npcId: 'courier', expectedNpcVersion: 1, source: { kind: 'secret', index: 0 }, publicText: 'The courier carries the key.', witnessNpcIds: ['courier'] };

describe('live director control contracts', () => {
  it('accepts an explicit scene transition to an existing or server-created location', () => {
    expect(CommandSchema.safeParse(scene).success).toBe(true);
    expect(CommandSchema.safeParse({ ...scene, location: { kind: 'new', title: 'The platform', description: 'An empty station.' } }).success).toBe(true);
    for (const changes of [{ presentNpcIds: ['courier', 'courier'] }, { location: { kind: 'new', id: 'forged', title: 'Platform', description: '' } }, { title: ' ' }]) {
      expect(CommandSchema.safeParse({ ...scene, ...changes }).success).toBe(false);
    }
  });

  it('creates and edits bounded NPC profiles without accepting fabricated memory or identity', () => {
    expect(CommandSchema.safeParse(save).success).toBe(true);
    expect(CommandSchema.safeParse({ ...save, npcId: 'courier', expectedNpcVersion: 3 }).success).toBe(true);
    for (const extra of [{ id: 'forged' }, { version: 99 }, { knowledge: [] }, { relationships: [] }, { partyRelationship: null }, { secrets: Array(11).fill('secret') }]) {
      expect(CommandSchema.safeParse({ ...save, profile: { ...profile, ...extra } }).success).toBe(false);
    }
    expect(CommandSchema.safeParse({ ...save, npcId: 'courier' }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...save, expectedNpcVersion: 1 }).success).toBe(false);
  });

  it('requires a precise private source and deliberate public wording for a reveal', () => {
    expect(CommandSchema.safeParse(reveal).success).toBe(true);
    expect(CommandSchema.safeParse({ ...reveal, source: { kind: 'identity' } }).success).toBe(true);
    for (const changes of [{ source: { kind: 'secret', index: -1 } }, { source: { kind: 'identity', index: 0 } }, { publicText: ' ' }, { witnessNpcIds: ['courier', 'courier'] }, { sourceEventId: 'forged' }]) {
      expect(CommandSchema.safeParse({ ...reveal, ...changes }).success).toBe(false);
    }
  });

  it('requires a reason, captured revision, and acknowledgement of queued input cancellation', () => {
    for (const command of [scene, save, reveal]) {
      for (const changes of [{ reason: ' ' }, { discardQueuedInput: false }, { expectedStateRevision: -1 }, { role: 'director' }]) {
        expect(CommandSchema.safeParse({ ...command, ...changes }).success).toBe(false);
      }
      const { discardQueuedInput: _discard, ...missing } = command;
      expect(CommandSchema.safeParse(missing).success).toBe(false);
    }
  });

  it('never adds the private location catalog to a stage projection', () => {
    const stage = { schemaVersion: 1, role: 'stage', eventSeq: 0, session: { id: 'session', title: 'Show', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'Bar', description: '', locationId: 'bar' } }, characters: [], npcs: [], tracks: [], facts: [], history: [], activeBeat: null };
    expect(SessionSnapshotSchema.safeParse(stage).success).toBe(true);
    expect(SessionSnapshotSchema.safeParse({ ...stage, locations: [{ id: 'vault', title: 'Private vault', description: 'Hidden treasure.' }] }).success).toBe(false);
  });
});
