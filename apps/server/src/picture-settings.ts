import type { PoolClient } from 'pg';
import { PICTURE_MODELS, type PictureSettings, type ScenarioDefinition, type SessionState } from '@rpg/contracts';
import { pictureStyleOf } from './picture-prompts';

function savedField(saved: unknown, key: 'style' | 'model'): string | undefined {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return undefined;
  const value = (saved as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function effectivePictureSettings(saved: unknown, briefStyle: string | undefined, defaultModel: string): PictureSettings {
  const savedStyle = savedField(saved, 'style');
  const savedModel = savedField(saved, 'model');
  const first = [savedStyle, briefStyle].find((text) => typeof text === 'string' && text.trim() !== '');
  const model = savedModel !== undefined && PICTURE_MODELS.some((entry) => entry.id === savedModel) ? savedModel : defaultModel;
  return { style: pictureStyleOf(first), model };
}

export async function pictureSettingsOf(client: PoolClient, state: SessionState, defaultModel: string): Promise<PictureSettings> {
  const result = await client.query<{ picture_settings: unknown }>('SELECT picture_settings FROM sessions WHERE id = $1', [state.session.id]);
  return effectivePictureSettings(result.rows[0]?.picture_settings, state.session.brief?.pictureStyle, defaultModel);
}

export async function savePictureSettings(client: PoolClient, sessionId: string, settings: { style: string; model: string | null }): Promise<void> {
  await client.query('UPDATE sessions SET picture_settings = $2::jsonb WHERE id = $1', [sessionId, JSON.stringify({ style: settings.style, model: settings.model })]);
}

export function scenarioPictureSettings(scenario: Pick<ScenarioDefinition, 'pictureStyle' | 'pictureModel'>): { style: string; model: string | null } {
  return { style: scenario.pictureStyle?.trim() ?? '', model: scenario.pictureModel ?? null };
}
