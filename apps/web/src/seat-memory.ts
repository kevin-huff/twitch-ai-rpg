export type RememberedSeat = { token: string; identityId: string; sessionId: string; role: 'player' | 'stage' };

export const USED_INVITATION = 'This invitation has already been used or has expired. Ask your host for a new link.';

const KEY = 'story-table-seats';

function validSeat(value: unknown): value is RememberedSeat {
  if (!value || typeof value !== 'object') return false;
  const seat = value as Record<string, unknown>;
  return typeof seat.token === 'string' && typeof seat.sessionId === 'string'
    && typeof seat.identityId === 'string' && /^[a-f0-9]{32}$/.test(seat.identityId)
    && (seat.role === 'player' || seat.role === 'stage');
}

function load(): RememberedSeat[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(validSeat) : [];
  } catch { return []; }
}

function save(seats: RememberedSeat[]) {
  try { window.localStorage.setItem(KEY, JSON.stringify(seats)); } catch { /* Storage can be blocked; the seat then simply is not remembered. */ }
}

export function rememberSeat(seat: RememberedSeat) {
  if (!validSeat(seat)) return;
  const entry: RememberedSeat = { token: seat.token, identityId: seat.identityId, sessionId: seat.sessionId, role: seat.role };
  save([...load().filter(item => item.token !== entry.token && item.identityId !== entry.identityId), entry]);
}

export function seatForInvitation(token: string): RememberedSeat | null {
  return load().find(item => item.token === token) ?? null;
}

export function seatsForShow(sessionId: string): RememberedSeat[] {
  return load().filter(item => item.sessionId === sessionId);
}

export function forgetSeat(identityId: string): boolean {
  const seats = load();
  const kept = seats.filter(item => item.identityId !== identityId);
  if (kept.length === seats.length) return false;
  save(kept);
  return true;
}
