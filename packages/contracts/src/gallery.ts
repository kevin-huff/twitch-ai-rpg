import { z } from 'zod';

export const GallerySlugSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const GalleryActionSchema = z.strictObject({ action: z.enum(['on', 'off', 'new_link', 'list', 'unlist', 'rewrite']) });
export const GalleryStatusSchema = z.strictObject({
  state: z.enum(['closed', 'off', 'on']),        // closed: the show has not ended
  listed: z.boolean(),
  url: z.string().nullable(),                    // the private link while on
  listUrl: z.string(),                           // the public list
  pictures: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),       // pictures of the show still being made
  writtenAt: z.string().nullable(),              // ISO time of the last successful write
  message: z.string().max(300).nullable(),       // the last write failure
  local: z.boolean(),                            // APP_ORIGIN is this computer only
});
export const SessionListEntrySchema = z.strictObject({
  id: z.string(), title: z.string(), status: z.string(),
  gallery: z.strictObject({ listed: z.boolean(), url: z.string() }).nullable(),
});

export type GallerySlug = z.infer<typeof GallerySlugSchema>;
export type GalleryAction = z.infer<typeof GalleryActionSchema>;
export type GalleryStatus = z.infer<typeof GalleryStatusSchema>;
export type SessionListEntry = z.infer<typeof SessionListEntrySchema>;
