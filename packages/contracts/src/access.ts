import { z } from 'zod';

const id = z.string().min(1).max(128);
const timestamp = z.string();

export const StreamLayoutSchema = z.enum(['scene', 'overlay']);
export type StreamLayout = z.infer<typeof StreamLayoutSchema>;
export const StreamAudioSchema = z.enum(['present', 'listen', 'off']);
export type StreamAudio = z.infer<typeof StreamAudioSchema>;

export const ViewerSchema = z.strictObject({
  role: z.enum(['host', 'producer', 'player', 'stage']),
  sessionId: id.nullable(),
  characterId: id.nullable(),
  producer: z.strictObject({ grantId: id, label: z.string(), expiresAt: timestamp }).nullable(),
  streamLinkId: id.nullable(),
  expiresAt: timestamp,
});
export type Viewer = z.infer<typeof ViewerSchema>;

export const ProducerSummarySchema = z.strictObject({
  id, label: z.string(), createdAt: timestamp, expiresAt: timestamp,
  revokedAt: timestamp.nullable(), lastSignedInAt: timestamp.nullable(),
  activeSignIns: z.number().int().nonnegative(),
});
export type ProducerSummary = z.infer<typeof ProducerSummarySchema>;
export const ProducerLinkSchema = z.strictObject({ producer: ProducerSummarySchema, token: z.string().min(20) });
export type ProducerLink = z.infer<typeof ProducerLinkSchema>;
export const CreateProducerSchema = z.strictObject({ commandId: id, label: z.string().trim().min(1).max(80) });
export type CreateProducer = z.infer<typeof CreateProducerSchema>;
export const ProducerSignInResponseSchema = z.strictObject({
  role: z.literal('producer'), label: z.string(), expiresAt: timestamp,
  identityId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});
export type ProducerSignInResponse = z.infer<typeof ProducerSignInResponseSchema>;

export const StreamLinkSubjectSchema = z.enum(['show', 'host', 'producer', 'player']);
export type StreamLinkSubject = z.infer<typeof StreamLinkSubjectSchema>;
export const StreamLinkSummarySchema = z.strictObject({
  id, sessionId: id, subject: StreamLinkSubjectSchema, label: z.string(),
  characterId: id.nullable(), producerGrantId: id.nullable(), canPresent: z.boolean(),
  createdAt: timestamp, expiresAt: timestamp, revokedAt: timestamp.nullable(),
});
export type StreamLinkSummary = z.infer<typeof StreamLinkSummarySchema>;
export const StreamLinkSchema = z.strictObject({ link: StreamLinkSummarySchema, token: z.string().min(1) });
export type StreamLink = z.infer<typeof StreamLinkSchema>;
export const CreateStreamLinkSchema = z.discriminatedUnion('subject', [
  z.strictObject({ commandId: id, subject: z.literal('show'), label: z.string().trim().min(1).max(80).optional(), canPresent: z.boolean().optional() }),
  z.strictObject({ commandId: id, subject: z.literal('host') }),
  z.strictObject({ commandId: id, subject: z.literal('producer'), producerGrantId: id }),
  z.strictObject({ commandId: id, subject: z.literal('player'), characterId: id }),
]);
export type CreateStreamLink = z.infer<typeof CreateStreamLinkSchema>;
export const StreamAccessRequestSchema = z.strictObject({ token: z.string().min(1).max(1024) });
export type StreamAccessRequest = z.infer<typeof StreamAccessRequestSchema>;
export const StreamAccessResponseSchema = z.strictObject({
  identityId: z.string().regex(/^[a-f0-9]{32}$/),
  sessionId: id,
  link: z.strictObject({ id, label: z.string(), subject: StreamLinkSubjectSchema, characterId: id.nullable(), canPresent: z.boolean() }),
  expiresAt: timestamp,
});
export type StreamAccessResponse = z.infer<typeof StreamAccessResponseSchema>;

export const InviteSummarySchema = z.strictObject({
  id, role: z.enum(['player', 'stage']), characterId: id.nullable(),
  status: z.enum(['waiting', 'joined', 'expired', 'revoked', 'replaced']),
  createdAt: timestamp, expiresAt: timestamp, redeemedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(), replacedBy: id.nullable(), signedIn: z.boolean(),
});
export type InviteSummary = z.infer<typeof InviteSummarySchema>;
export const InviteLinkSchema = z.strictObject({ invite: InviteSummarySchema, token: z.string().min(1) });
export type InviteLink = z.infer<typeof InviteLinkSchema>;
export const ReissueInviteSchema = z.strictObject({ commandId: id, signOutCurrent: z.boolean() });
export type ReissueInvite = z.infer<typeof ReissueInviteSchema>;
