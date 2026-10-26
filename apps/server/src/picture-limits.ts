import type { PoolClient } from 'pg';
import { ProviderError } from '@rpg/providers';

type PicturePurpose = 'scene' | 'npc' | 'character' | 'card';

export function minutesText(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function hourlyLimitMessage(minutes: number): string {
  return `The picture limit for this hour is used up. Try again in ${minutesText(minutes)}.`;
}

// The sentences people see when a picture cannot be made; the same words reach the director, players and the history log.
export const PICTURE_MESSAGES = {
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
} as const;

export interface PictureLimitSettings {
  hourly: number | null;
}

// A row counts once it is reserved or has reached the picture service, so rows cancelled before the start and limit failures stay free.
const COUNTED = "(status = 'making' OR started_at IS NOT NULL)";
const MINUTES_LEFT = "GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(created_at) + interval '1 hour' - clock_timestamp())) / 60))::int";

interface WindowCount {
  used: number;
  minutes: number | null;
}

async function windowCount(client: PoolClient): Promise<WindowCount> {
  const { rows } = await client.query<{ used: string; minutes: number | null }>(
    `SELECT count(*) AS used, ${MINUTES_LEFT} AS minutes FROM images
     WHERE ${COUNTED} AND created_at > now() - interval '1 hour'`,
  );
  return { used: Number(rows[0]!.used), minutes: rows[0]!.minutes };
}

// Checks the optional hourly limit and returns its sentence when it is used up; null means no limit is set. The caller holds the quota lock.
export async function pictureLimitMessage(client: PoolClient, limits: PictureLimitSettings): Promise<string | null> {
  if (limits.hourly === null) return null;
  const hourly = await windowCount(client);
  return hourly.used >= limits.hourly ? hourlyLimitMessage(hourly.minutes ?? 1) : null;
}

// Turns a provider failure into the status, code and sentence the routes answer with.
export function pictureFailure(error: unknown, purpose: PicturePurpose, moment = false): { status: number; code: string; message: string } {
  const provider = error instanceof ProviderError ? error : null;
  const status = provider?.status;
  if (provider?.reason === 'safety') {
    const message = moment ? PICTURE_MESSAGES.beatSafety : purpose === 'scene' ? PICTURE_MESSAGES.sceneSafety : PICTURE_MESSAGES.portraitSafety;
    return { status: 502, code: 'picture_failed', message };
  }
  if (provider?.reason === 'credit' || status === 402) {
    return { status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.credit };
  }
  if (status === 401 || status === 403 || provider?.code === 'configuration') {
    return { status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.key };
  }
  if (status === 409 || status === 429) {
    return { status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy };
  }
  if (moment) return { status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.beatFailed };
  const message = purpose === 'scene' ? PICTURE_MESSAGES.sceneFailed : purpose === 'npc' ? PICTURE_MESSAGES.npcFailed : PICTURE_MESSAGES.cardFailed;
  return { status: 502, code: 'picture_failed', message };
}
