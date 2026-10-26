import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { z } from 'zod';
import { imageTypeOf, MOMENT_PORTRAIT_MAX, MOMENT_PROMPT_MAX, PICTURE_PROMPT_MAX } from '@rpg/contracts';
import type { ImageProvider, ImageReference, ImageRequest, ImageResult } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';

export interface FakeImageOptions {
  delayMs?: number;
  hold?: () => Promise<void>;
  fail?: (request: ImageRequest) => ProviderError | null;
  failUpload?: (index: number) => boolean;
}

const size = z.number().int().multipleOf(64).min(256).max(2048);
const RequestSchema = z.object({
  prompt: z.string().min(1).max(MOMENT_PROMPT_MAX).regex(/^[^\p{Cc}]*$/u),
  negativePrompt: z.string().max(1000),
  model: z.string().min(1).optional(),
  references: z.array(z.object({ provider: z.string() })).max(MOMENT_PORTRAIT_MAX).optional(),
  width: size,
  height: size,
  requestId: z.uuid(),
  title: z.string().min(1).max(80),
}).refine((request) => (request.references?.length ?? 0) > 0 || request.prompt.length <= PICTURE_PROMPT_MAX);

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

export function fakeImageBytes(request: Pick<ImageRequest, 'prompt' | 'width' | 'height'>): Uint8Array {
  const width = Math.max(8, Math.round(request.width / 16));
  const height = Math.max(8, Math.round(request.height / 16));
  const color = createHash('sha256').update(request.prompt).digest().subarray(0, 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(color, 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// Rejects promptly when the signal aborts; otherwise resolves after ms (or when the promise settles).
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ProviderError('invalid_context', 'Sogni'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class FakeImageProvider implements ImageProvider {
  readonly name = 'fake';
  readonly model = 'fake-image';
  readonly requests: ImageRequest[] = [];

  readonly uploads: { requestId: string; count: number }[] = [];

  constructor(private readonly options: FakeImageOptions = {}) {}

  async prepareReferences(
    images: Uint8Array[], options: { requestId: string; signal?: AbortSignal },
  ): Promise<(ImageReference | null)[]> {
    if (options.signal?.aborted) throw new ProviderError('invalid_context', 'Sogni');
    this.uploads.push({ requestId: options.requestId, count: images.length });
    return images.map((bytes, index) => (
      this.options.failUpload?.(index) || !imageTypeOf(bytes)
        ? null
        : Object.freeze({ provider: 'fake', requestId: options.requestId, index })
    ));
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (!RequestSchema.safeParse(request).success) throw new ProviderError('invalid_input', 'Sogni');
    if (request.signal?.aborted) throw new ProviderError('invalid_context', 'Sogni');
    this.requests.push(request);
    const delayMs = this.options.delayMs ?? 0;
    if (delayMs > 0) await abortable(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), request.signal);
    if (this.options.hold) await abortable(this.options.hold(), request.signal);
    const failure = this.options.fail?.(request);
    if (failure) throw failure;
    return {
      bytes: fakeImageBytes(request), contentType: 'image/png', width: request.width, height: request.height,
      workflowId: `fake-${request.requestId}`,
    };
  }
}
