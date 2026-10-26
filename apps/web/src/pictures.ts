import type { ScenePicture, SessionSnapshot } from '@rpg/contracts';
import { identityPath } from './identity';

export type PictureScope = { kind: 'session'; sessionId: string } | { kind: 'library' } | { kind: 'builder' };

export const BATCH_PORTRAIT_CONCURRENCY = 3;

export function pictureUrl(scope: PictureScope, imageId: string): string {
  const id = encodeURIComponent(imageId);
  if (scope.kind === 'session') return identityPath(`/api/sessions/${encodeURIComponent(scope.sessionId)}/images/${id}`);
  if (scope.kind === 'library') return identityPath(`/api/library/images/${id}`);
  return identityPath(`/api/character-builder/images/${id}`);
}

export function portraitAlt(name: string): string {
  return `Portrait of ${name.trim() || 'this character'}`;
}

// Runs the worker over every item, at most `limit` at a time, in order. A failing worker never stops the others.
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch { /* one failure must not stop the rest */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, lane));
}

export function portraitIdFor(snapshot: SessionSnapshot, entityId: string): string | null {
  if (snapshot.picturesEnabled !== true) return null;
  const character = snapshot.characters.find((item) => item.id === entityId);
  if (character) return character.portraitId ?? null;
  return snapshot.npcs.find((item) => item.id === entityId)?.portraitId ?? null;
}

export function shownScenePicture(snapshot: SessionSnapshot): ScenePicture | null {
  if (snapshot.picturesEnabled !== true) return null;
  const picture = snapshot.scenePicture ?? null;
  return picture && picture.sceneId === snapshot.session.scene.id ? picture : null;
}
