import { z } from 'zod';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();

export const DEFAULT_PICTURE_STYLE = 'Painterly digital illustration, rich color, cinematic lighting';
export const PICTURE_NEGATIVE_PROMPT = 'text, letters, words, captions, watermark, signature, logo, frame, border, nudity';
export const PICTURE_STYLE_MAX = 300;
export const SCENE_PICTURE_SIZE = { width: 1344, height: 768 } as const;
export const PORTRAIT_SIZE = { width: 768, height: 768 } as const;
export const PICTURE_LIMITS = { concurrent: 10 } as const;
export const MOMENT_MODEL = 'flux-3-klein';
export const MOMENT_PORTRAIT_MAX = 10;
// Prompt limits in characters. Sogni refuses a FLUX 3 Klein prompt over 6,000 characters, and the model drew a detail from the last sentence of one 5,944 long (measured 2026-10-25).
// A picture drawn from words alone keeps the length the app has always sent: Sogni publishes no limit for Krea 2 Turbo, Z-Image Turbo or Qwen, and the XL models read only about the first 77 tokens.
export const MOMENT_PROMPT_MAX = 6000;
export const PICTURE_PROMPT_MAX = 2000;
export const MAX_IMAGE_BYTES = 8_000_000;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageContentType = typeof IMAGE_CONTENT_TYPES[number];

// Magic-byte sniffing shared by the Sogni adapter, the fake and the server file store.
// JPEG: FF D8 FF. PNG: 89 50 4E 47 0D 0A 1A 0A. WebP: "RIFF" at 0..3 and "WEBP" at 8..11.
export function imageTypeOf(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte)
    && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte)) return 'image/webp';
  return null;
}

export const ImageIdSchema = z.uuid();
export const PictureModelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const PICTURE_MODELS: readonly { id: string; label: string; description: string }[] = [
  { id: 'krea-2-turbo', label: 'Krea 2 Turbo', description: 'Painterly. The default.' },
  { id: 'flux-3-klein', label: 'FLUX 3 Klein', description: 'Photo-real faces unless the style asks for something else.' },
  { id: 'z-turbo', label: 'Z-Image Turbo', description: 'Follows the scene and the style closely.' },
  { id: 'qwen-2512-lightning', label: 'Qwen Image 2512 Lightning', description: 'Follows the scene and the style closely.' },
  { id: 'chroma1-hd', label: 'Chroma1-HD', description: 'Follows the scene and the style, but slower than the others: about a minute a picture.' },
  { id: 'dreamshaper-xl', label: 'DreamShaper XL', description: 'Older model: gets the style right but is loose with what is in the scene.' },
  { id: 'animagine-xl', label: 'Animagine XL 4.0', description: 'Older anime model: rough, and loose with what is in the scene.' },
  { id: 'cyberrealistic-xl', label: 'CyberRealistic XL', description: 'Older model: good cinematic photos, but loose with what is in the scene.' },
];
export const PictureSettingsSchema = z.strictObject({ style: z.string().trim().max(PICTURE_STYLE_MAX), model: PictureModelIdSchema });
export type PictureSettings = z.infer<typeof PictureSettingsSchema>;
export const PortraitDetailsSchema = z.strictObject({
  appearance: z.string().max(1000).default(''),
  role: z.string().max(1000).default(''),      // NPC role, or a player card's specialty
  pronouns: z.string().max(80).default(''),
  name: z.string().max(80).default(''),        // only used to remove the name from the prompt; never sent to Sogni
});
export type PortraitDetails = z.infer<typeof PortraitDetailsSchema>;
export const SeatPortraitRequestSchema = z.strictObject({ expectedCharacterRevision: revision, details: PortraitDetailsSchema });
export type SeatPortraitRequest = z.infer<typeof SeatPortraitRequestSchema>;
export const BuilderPortraitRequestSchema = z.strictObject({ expectedRevision: revision, details: PortraitDetailsSchema });
export type BuilderPortraitRequest = z.infer<typeof BuilderPortraitRequestSchema>;
export const LibraryPortraitRequestSchema = z.strictObject({
  subject: z.enum(['npc', 'card']),
  subjectKey: id,                                // editor NPC id, or the card's template id or editor key
  details: PortraitDetailsSchema,
  pictureStyle: z.string().trim().max(PICTURE_STYLE_MAX).default(''),   // used for subject 'npc' only
  pictureModel: PictureModelIdSchema.optional(),                        // used for subject 'npc' only
});
export type LibraryPortraitRequest = z.infer<typeof LibraryPortraitRequestSchema>;
export const PictureIdResponseSchema = z.strictObject({ imageId: ImageIdSchema });
export type PictureIdResponse = z.infer<typeof PictureIdResponseSchema>;

// Public: the shown scene picture (ready, not hidden, current scene).
export const ScenePictureSchema = z.strictObject({ imageId: ImageIdSchema, sceneId: id });
export type ScenePicture = z.infer<typeof ScenePictureSchema>;
// Director only.
export const ScenePictureStatusSchema = z.strictObject({
  sceneId: id,
  state: z.enum(['none', 'making', 'ready', 'failed']),
  imageId: ImageIdSchema.nullable(),           // newest ready picture of this scene, shown or hidden
  hidden: z.boolean(),
  message: z.string().max(300).nullable(),     // set when state is 'failed'
  drawing: z.enum(['place', 'beat']).nullable().default(null),   // what the picture being made shows; null unless state is 'making'
});
export type ScenePictureStatus = z.infer<typeof ScenePictureStatusSchema>;
// Director only: the picture of the active action round's newest script, held back until the round is published.
export const ActionPictureStatusSchema = z.strictObject({
  beatId: id,
  state: z.enum(['making', 'ready', 'failed']),
  imageId: ImageIdSchema.nullable(),           // set when state is 'ready'
  message: z.string().max(300).nullable(),     // set when state is 'failed'
});
export type ActionPictureStatus = z.infer<typeof ActionPictureStatusSchema>;
export const PortraitJobSchema = z.strictObject({
  npcId: id, state: z.enum(['making', 'failed']), message: z.string().max(300).nullable(),
});
export type PortraitJob = z.infer<typeof PortraitJobSchema>;

export const PictureSceneSchema = z.strictObject({ title: z.string().max(160), description: z.string().max(6000), place: z.string().max(160) });
export type PictureScene = z.infer<typeof PictureSceneSchema>;
export const PictureLineSchema = z.strictObject({
  kind: z.enum(['narration', 'npc_dialogue', 'player_dialogue', 'player_action', 'intent', 'approach', 'outcome']),
  speaker: z.string().max(80).nullable(),
  text: z.string().max(6000),
});
export type PictureLine = z.infer<typeof PictureLineSchema>;
export const PicturePersonSchema = z.strictObject({
  name: z.string().max(80), appearance: z.string().max(1000), role: z.string().max(1000), pronouns: z.string().max(80),
  portraitId: ImageIdSchema.nullable(),
  imageNumber: z.number().int().min(1).max(MOMENT_PORTRAIT_MAX).nullable(),
});
export type PicturePerson = z.infer<typeof PicturePersonSchema>;
export const PictureMomentSchema = z.strictObject({
  style: z.string().max(PICTURE_STYLE_MAX), model: PictureModelIdSchema, scene: PictureSceneSchema,
  lines: z.array(PictureLineSchema), cast: z.array(PicturePersonSchema), names: z.array(z.string().max(80)),
});
export type PictureMoment = z.infer<typeof PictureMomentSchema>;

// An opaque handle that only the provider that made it can read.
export interface ImageReference { readonly provider: string }

export interface ImageRequest {
  prompt: string;            // 1..PICTURE_PROMPT_MAX characters (1..MOMENT_PROMPT_MAX with references), no control characters
  negativePrompt: string;    // PICTURE_NEGATIVE_PROMPT
  width: number;             // multiple of 64, 256..2048
  height: number;
  requestId: string;         // UUID; the images row id; sent as the Sogni Idempotency-Key
  title: string;             // 'Scene picture', 'Action picture', 'Beat picture' or 'Portrait'; never a name
  model?: string;            // defaults to the provider's model
  references?: ImageReference[];   // at most MOMENT_PORTRAIT_MAX, in image-number order
  signal?: AbortSignal;      // abort = superseded or server closing
}
export interface ImageResult {
  bytes: Uint8Array;
  contentType: ImageContentType;   // from sniffing, never from the URL
  width: number;
  height: number;
  workflowId: string | null;
}
export interface ImageProvider {
  readonly name: string;     // 'sogni' | 'fake'
  readonly model: string;
  generate(request: ImageRequest): Promise<ImageResult>;
  // One entry per input, in input order; null means draw that person from words. Rejects only when the signal aborts or the input is invalid.
  prepareReferences?(images: Uint8Array[], options: { requestId: string; signal?: AbortSignal }): Promise<(ImageReference | null)[]>;
}
