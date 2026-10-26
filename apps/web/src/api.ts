import { CharacterBuilderFieldGenerationRequestSchema, FieldGenerationCharacterContextSchema } from '@rpg/contracts';
import { ViewerSchema, ProducerSummarySchema, ProducerLinkSchema, ProducerSignInResponseSchema, StreamLinkSchema, StreamLinkSummarySchema, StreamAccessResponseSchema, InviteSummarySchema, InviteLinkSchema, PlaybackSnapshotSchema } from '@rpg/contracts';
import type { Viewer, ProducerSummary, ProducerLink, ProducerSignInResponse, StreamLink, StreamLinkSummary, CreateStreamLink, StreamAccessResponse, InviteSummary, InviteLink, PlaybackSnapshot } from '@rpg/contracts';
import { io } from 'socket.io-client';
import type { Command, SessionSnapshot, CreateSessionResponse, RedeemResponse, Library, ScenarioDefinition, CharacterCardDefinition, TemplateVersion, TemplateRef, SaveScenario, SaveCharacterTemplate, FieldGenerationRequest, FieldGenerationResponse } from '@rpg/contracts';
import type { CharacterBuilderAccess, CharacterBuilderFieldGenerationRequest, CharacterBuilderLink, CharacterBuilderSnapshot, CharacterBuilderSummary, CreateCharacterBuilder, SaveCharacterBuilder } from '@rpg/contracts';
import { getIdentity, identityHeaders, selectIdentity } from './identity';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, body?: unknown, selectedIdentity = true): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { ...(selectedIdentity ? identityHeaders() : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.message || data.error || `Request failed (${response.status}).`, response.status);
  return data as T;
}

export const api = {
  characterBuilders: () => request<{ builders: CharacterBuilderSummary[] }>('/character-builders'),
  createCharacterBuilder: (value: Omit<CreateCharacterBuilder, 'instructions'> & { instructions?: string }) => request<CharacterBuilderLink>('/character-builders', value),
  characterBuilderLink: (id: string) => request<CharacterBuilderLink>(`/character-builders/${encodeURIComponent(id)}/link`),
  revokeCharacterBuilder: (id: string, value: { commandId: string }) => request<CharacterBuilderSummary>(`/character-builders/${encodeURIComponent(id)}/revoke`, value),
  accessCharacterBuilder: (token: string) => request<CharacterBuilderAccess>('/character-builder/access', { token }, false),
  characterBuilder: () => request<CharacterBuilderSnapshot>('/character-builder'),
  generateCharacterBuilderField: ({ expectedRevision, field, seed, characterContext }: CharacterBuilderFieldGenerationRequest) => request<FieldGenerationResponse>('/character-builder/generate-field', CharacterBuilderFieldGenerationRequestSchema.parse({ expectedRevision, field, seed, characterContext })),
  saveCharacterBuilder: (value: SaveCharacterBuilder) => request<CharacterBuilderSnapshot>('/character-builder/save', value),
  submitCharacterBuilder: (value: SaveCharacterBuilder) => request<CharacterBuilderSnapshot>('/character-builder/submit', value),
  logoutCharacterBuilder: () => request<{ ok: true }>('/character-builder/logout', {}),
  login: async (token: string) => {
    const result = await request<{ role: 'host'; identityId: string }>('/auth/host', { token, tab: true });
    selectIdentity(result.identityId);
    return result;
  },
  redeem: async (token: string) => {
    const result = await request<RedeemResponse>('/auth/redeem', { token, tab: true });
    selectIdentity(result.identityId);
    return result;
  },
  testSeat: (id: string, characterId: string) => request<RedeemResponse>(`/sessions/${encodeURIComponent(id)}/test-seat`, { characterId }),
  create: (title: string) => request<CreateSessionResponse>('/sessions', { commandId: crypto.randomUUID(), title }),
  library: () => request<Library>('/library'),
  starter: () => request<{ scenario: ScenarioDefinition; characters: CharacterCardDefinition[] }>('/library/starter'),
  generateField: ({ field, seed, premise, characterContext }: FieldGenerationRequest) => request<FieldGenerationResponse>('/authoring/generate-field', { field, seed, ...(premise === undefined ? {} : { premise }), ...(characterContext === undefined ? {} : { characterContext: FieldGenerationCharacterContextSchema.parse(characterContext) }) }),
  saveScenario: (value: Omit<SaveScenario, 'commandId'>) => request<TemplateVersion<ScenarioDefinition>>('/library/scenarios', { commandId: crypto.randomUUID(), ...value }),
  saveCharacterTemplate: (value: Omit<SaveCharacterTemplate, 'commandId'>) => request<TemplateVersion<CharacterCardDefinition>>('/library/characters', { commandId: crypto.randomUUID(), ...value }),
  createCustom: (title: string, scenarioRef: TemplateRef, characterRefs: TemplateRef[]) => request<CreateSessionResponse>('/sessions', { commandId: crypto.randomUUID(), title, scenario: scenarioRef, characters: characterRefs }),
  sessions: () => request<Array<{ id: string; title: string }>>('/sessions'),
  snapshot: (id: string, view?: string) => request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}${view ? `?view=${encodeURIComponent(view)}` : ''}`),
  me: async (): Promise<Viewer> => ViewerSchema.parse(await request('/auth/me')),
  producerSignIn: async (token: string): Promise<ProducerSignInResponse> => {
    const result = ProducerSignInResponseSchema.parse(await request('/auth/producer', { token, tab: true }));
    selectIdentity(result.identityId);
    return result;
  },
  producers: async (): Promise<{ producers: ProducerSummary[] }> => {
    const data = await request<{ producers: unknown[] }>('/producers');
    return { producers: data.producers.map(item => ProducerSummarySchema.parse(item)) };
  },
  createProducer: async (label: string): Promise<ProducerLink> => ProducerLinkSchema.parse(await request('/producers', { commandId: crypto.randomUUID(), label })),
  producerLink: async (id: string): Promise<ProducerLink> => ProducerLinkSchema.parse(await request(`/producers/${encodeURIComponent(id)}/link`)),
  revokeProducer: async (id: string): Promise<ProducerSummary> => ProducerSummarySchema.parse(await request(`/producers/${encodeURIComponent(id)}/revoke`, { commandId: crypto.randomUUID() })),
  streamLinks: async (sessionId: string): Promise<{ links: StreamLinkSummary[] }> => {
    const data = await request<{ links: unknown[] }>(`/sessions/${encodeURIComponent(sessionId)}/stream-links`);
    return { links: data.links.map(item => StreamLinkSummarySchema.parse(item)) };
  },
  createStreamLink: async (sessionId: string, body: DistributiveOmit<CreateStreamLink, 'commandId'>): Promise<StreamLink> => StreamLinkSchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/stream-links`, { commandId: crypto.randomUUID(), ...body })),
  streamLink: async (sessionId: string, linkId: string): Promise<StreamLink> => StreamLinkSchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/stream-links/${encodeURIComponent(linkId)}/link`)),
  revokeStreamLink: async (sessionId: string, linkId: string): Promise<StreamLinkSummary> => StreamLinkSummarySchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/stream-links/${encodeURIComponent(linkId)}/revoke`, { commandId: crypto.randomUUID() })),
  streamAccess: async (token: string): Promise<StreamAccessResponse> => StreamAccessResponseSchema.parse(await request('/stream/access', { token }, false)),
  invites: async (sessionId: string): Promise<{ invites: InviteSummary[] }> => {
    const data = await request<{ invites: unknown[] }>(`/sessions/${encodeURIComponent(sessionId)}/invites`);
    return { invites: data.invites.map(item => InviteSummarySchema.parse(item)) };
  },
  inviteLink: async (sessionId: string, inviteId: string): Promise<InviteLink> => InviteLinkSchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/invites/${encodeURIComponent(inviteId)}/link`)),
  reissueInvite: async (sessionId: string, inviteId: string, signOutCurrent: boolean): Promise<InviteLink> => InviteLinkSchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/invites/${encodeURIComponent(inviteId)}/reissue`, { commandId: crypto.randomUUID(), signOutCurrent })),
  playback: async (sessionId: string): Promise<PlaybackSnapshot> => PlaybackSnapshotSchema.parse(await request(`/sessions/${encodeURIComponent(sessionId)}/playback`)),
  command: (id: string, command: Command) => request(`/sessions/${encodeURIComponent(id)}/commands`, command),
};

export function subscribeToSession(sessionId: string, refresh: () => void, connection: (connected: boolean) => void) {
  const identityId = getIdentity();
  const socket = io({ auth: { sessionId, ...(identityId ? { identityId } : {}) }, withCredentials: true });
  socket.on('connect', () => { connection(true); refresh(); });
  socket.on('disconnect', () => connection(false));
  socket.on('connect_error', () => connection(false));
  socket.on('session.snapshot_available', () => refresh());
  return () => socket.disconnect();
}
