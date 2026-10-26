export type DraftKind = 'say' | 'act' | 'ooc';
export type DraftContext = { epoch: number; beatId: string | null };
export type Draft = { kind: DraftKind; speech: string; intent: string; approach: string; note: string; stageDirection: string; recipient: string; context: DraftContext | null };
export type LoadedDraft = Draft & { legacy?: true };

const key = (sessionId: string, characterId: string) => `rpg-draft:${sessionId}:${characterId}`;
const isBlank = (draft: Draft) => ![draft.speech, draft.intent, draft.approach, draft.note, draft.stageDirection].some(text => text.trim());

export function saveDraft(sessionId: string, characterId: string, draft: Draft) {
  if (isBlank(draft)) return;
  try { sessionStorage.setItem(key(sessionId, characterId), JSON.stringify(draft)); } catch { /* storage can be blocked or full */ }
}

export function loadDraft(sessionId: string, characterId: string): LoadedDraft | null {
  try {
    const raw = sessionStorage.getItem(key(sessionId, characterId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Draft> | null;
    if (!value || typeof value !== 'object') return null;
    if (value.kind !== 'say' && value.kind !== 'act' && value.kind !== 'ooc') return null;
    const text = (field: unknown) => typeof field === 'string' ? field : '';
    const context = value.context && typeof value.context.epoch === 'number' && (value.context.beatId === null || typeof value.context.beatId === 'string') ? { epoch: value.context.epoch, beatId: value.context.beatId } : null;
    const draft: Draft = { kind: value.kind, speech: text(value.speech), intent: text(value.intent), approach: text(value.approach), note: text(value.note), stageDirection: text(value.stageDirection), recipient: text(value.recipient), context };
    if (isBlank(draft)) return null;
    // Drafts saved by the old seat have no note field.
    return 'note' in value ? draft : { ...draft, legacy: true };
  } catch { return null; }
}

export function clearDraft(sessionId: string, characterId: string) {
  try { sessionStorage.removeItem(key(sessionId, characterId)); } catch { /* storage can be blocked */ }
}
