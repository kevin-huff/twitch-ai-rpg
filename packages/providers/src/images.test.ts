import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, MOMENT_PORTRAIT_MAX, MOMENT_PROMPT_MAX, PICTURE_MODELS, PICTURE_NEGATIVE_PROMPT, PICTURE_PROMPT_MAX, type ImageReference, type ImageRequest } from '@rpg/contracts';
import { ProviderError, SogniImageProvider, type SogniOptions } from './index.js';

const key = 'sogni-private-key-SENTINEL';
const requestId = '3f2b8c1e-7d4a-4f6b-9c2e-1a5d8e7f6b4c';
const artifactUrl = 'https://storage.sogni.test/media/wf-1/image.jpg?signature=abc';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    prompt: 'Painterly digital illustration. A wide view of a foggy dock.', negativePrompt: PICTURE_NEGATIVE_PROMPT,
    width: 1344, height: 768, requestId, title: 'Scene picture', ...overrides,
  };
}

function workflow(status: string, extra: Record<string, unknown> = {}) {
  return Response.json({ status: 'success', data: { workflow: { workflowId: 'wf-1', status, ...extra } } });
}

const completed = () => workflow('completed', {
  steps: [{ id: 'image', artifacts: [{ id: 'a-1', kind: 'image', url: artifactUrl, mimeType: 'image/jpeg', width: 1344, height: 768, toolName: 'generate_image', stepId: 'image' }] }],
});

function sogniFetch(statuses: string[] = ['queued', 'running']) {
  const polls = [...statuses];
  return vi.fn<typeof fetch>(async (url) => {
    const target = String(url);
    if (target === 'https://api.sogni.test/v1/creative-agent/workflows') {
      return Response.json({ status: 'success', data: { workflow: { workflowId: 'wf-1', status: 'queued' } } }, { status: 201 });
    }
    if (target === 'https://api.sogni.test/v1/creative-agent/workflows/wf-1') {
      const next = polls.shift();
      return next ? workflow(next) : completed();
    }
    if (target === artifactUrl) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`unexpected fetch ${target}`);
  });
}

const provider = (fetchMock: typeof fetch) => new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, pollMs: 1 });

describe('SogniImageProvider', () => {
  it('names itself and defaults to the krea-2-turbo model', () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(new SogniImageProvider({ apiKey: key, fetch: fetchMock })).toMatchObject({ name: 'sogni', model: 'krea-2-turbo' });
    expect(new SogniImageProvider({ apiKey: key, model: 'flux-3-klein', fetch: fetchMock }).model).toBe('flux-3-klein');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts one workflow with the exact body, the key and an idempotency key', async () => {
    const fetchMock = sogniFetch();
    await provider(fetchMock).generate(request());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sogni.test/v1/creative-agent/workflows');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': requestId,
    });
    expect(headers['user-agent']).toContain('twitch-ai-rpg');
    expect(JSON.parse(String(init?.body))).toEqual({
      input: {
        title: 'Scene picture',
        steps: [{
          id: 'image', toolName: 'generate_image',
          arguments: {
            prompt: 'Painterly digital illustration. A wide view of a foggy dock.', model: 'krea-2-turbo', width: 1344, height: 768,
            negativePrompt: PICTURE_NEGATIVE_PROMPT, numberOfVariations: 1, outputFormat: 'jpg',
          },
        }],
      },
      confirm_cost: true, safe_content_filter: false, token_type: 'auto', app_source: 'twitch-ai-rpg',
    });
  });

  it('sends safe_content_filter true only when configured, and never a capacity limit', async () => {
    const off = sogniFetch();
    await provider(off).generate(request());
    const offBody = JSON.parse(String(off.mock.calls[0][1]?.body));
    expect(offBody.safe_content_filter).toBe(false);
    expect(offBody).not.toHaveProperty('max_estimated_capacity_units');
    const on = sogniFetch();
    await new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: on, pollMs: 1, safeContentFilter: true }).generate(request());
    const onBody = JSON.parse(String(on.mock.calls[0][1]?.body));
    expect(onBody.safe_content_filter).toBe(true);
    expect(onBody).not.toHaveProperty('max_estimated_capacity_units');
  });

  it('draws with the model on the request and falls back to the provider model', async () => {
    const asked = sogniFetch();
    const chosen = PICTURE_MODELS[PICTURE_MODELS.length - 1]!.id;
    await provider(asked).generate(request({ model: chosen }));
    expect(JSON.parse(String(asked.mock.calls[0][1]?.body)).input.steps[0].arguments.model).toBe(chosen);
    const unasked = sogniFetch();
    await new SogniImageProvider({ apiKey: key, model: 'flux-3-klein', baseUrl: 'https://api.sogni.test', fetch: unasked, pollMs: 1 }).generate(request());
    expect(JSON.parse(String(unasked.mock.calls[0][1]?.body)).input.steps[0].arguments.model).toBe('flux-3-klein');
  });

  it('refuses a model id that is not a model id without fetching', async () => {
    for (const model of ['Bad Model!', '', '-flux', 'a'.repeat(65), 'flux 3']) {
      const fetchMock = vi.fn<typeof fetch>();
      await expect(provider(fetchMock).generate(request({ model }))).rejects.toMatchObject({ code: 'invalid_input' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('accepts a prompt without references up to PICTURE_PROMPT_MAX and refuses a longer one without fetching', async () => {
    await expect(provider(sogniFetch()).generate(request({ prompt: 'a'.repeat(PICTURE_PROMPT_MAX) }))).resolves.toMatchObject({ workflowId: 'wf-1' });
    const fetchMock = vi.fn<typeof fetch>();
    for (const prompt of ['a'.repeat(PICTURE_PROMPT_MAX + 1), 'a'.repeat(MOMENT_PROMPT_MAX)]) {
      await expect(provider(fetchMock).generate(request({ prompt }))).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(provider(fetchMock).generate(request({ prompt, references: [] }))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('with references', () => {
    const uploadHost = 'https://r2.sogni.test/uploads/';
    const downloadLinkFor = (slot: number) => `https://media-input.sogni.test/${requestId}/contextImage${slot}?sig=down-SECRET-${slot}`;
    const withUploads = () => {
      const base = sogniFetch([]);
      return vi.fn<typeof fetch>(async (url, init) => {
        const target = new URL(String(url));
        const slot = Number(target.searchParams.get('type')?.replace('contextImage', '') ?? target.pathname.match(/contextImage(\d+)/)?.[1]);
        if (target.href.startsWith('https://api.sogni.test/v1/image/uploadUrl?')) return Response.json({ data: { uploadUrl: `${uploadHost}${slot}?sig=up-SECRET-${slot}` } });
        if (target.href.startsWith(uploadHost)) return new Response(null, { status: 200 });
        if (target.href.startsWith('https://api.sogni.test/v1/image/downloadUrl?')) return Response.json({ data: { downloadUrl: downloadLinkFor(slot) } });
        return base(url, init);
      });
    };
    const refs = async (fetchMock: typeof fetch, count: number): Promise<ImageReference[]> => {
      const handles = await provider(fetchMock).prepareReferences(Array.from({ length: count }, () => jpeg), { requestId });
      expect(handles.every((handle) => handle !== null)).toBe(true);
      return handles as ImageReference[];
    };
    const startBody = (fetchMock: ReturnType<typeof withUploads>) => {
      const start = fetchMock.mock.calls.find(([url]) => String(url) === 'https://api.sogni.test/v1/creative-agent/workflows');
      return JSON.parse(String(start![1]?.body));
    };

    it('starts an edit_image step with the links as media_references, in reference order', async () => {
      const fetchMock = withUploads();
      const references = await refs(fetchMock, 3);
      await provider(fetchMock).generate(request({ title: 'Beat picture', model: 'flux-3-klein', references }));
      expect(startBody(fetchMock)).toEqual({
        input: {
          title: 'Beat picture',
          steps: [{
            id: 'image', toolName: 'edit_image',
            arguments: {
              prompt: 'Painterly digital illustration. A wide view of a foggy dock.', model: 'flux-3-klein', sourceImageIndex: -1,
              width: 1344, height: 768, numberOfVariations: 1, outputFormat: 'jpg',
            },
          }],
        },
        media_references: [1, 2, 3].map((slot) => ({ kind: 'image', url: downloadLinkFor(slot) })),
        confirm_cost: true, safe_content_filter: false, token_type: 'auto', app_source: 'twitch-ai-rpg',
      });
    });

    it('keeps generate_image and no media_references for an empty list', async () => {
      const fetchMock = withUploads();
      await provider(fetchMock).generate(request({ references: [] }));
      const body = startBody(fetchMock);
      expect(body.input.steps[0].toolName).toBe('generate_image');
      expect(body.input.steps[0].arguments.negativePrompt).toBe(PICTURE_NEGATIVE_PROMPT);
      expect(body).not.toHaveProperty('media_references');
    });

    it("accepts FLUX 3 Klein's longer prompt with references and refuses one past it without starting", async () => {
      const fetchMock = withUploads();
      const references = await refs(fetchMock, 2);
      await provider(fetchMock).generate(request({ prompt: 'a'.repeat(MOMENT_PROMPT_MAX), model: 'flux-3-klein', references }));
      expect(startBody(fetchMock).input.steps[0]).toMatchObject({ toolName: 'edit_image', arguments: { prompt: 'a'.repeat(MOMENT_PROMPT_MAX) } });
      const before = fetchMock.mock.calls.length;
      await expect(provider(fetchMock).generate(request({ prompt: 'a'.repeat(MOMENT_PROMPT_MAX + 1), model: 'flux-3-klein', references })))
        .rejects.toMatchObject({ code: 'invalid_input' });
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it('refuses a handle this provider did not make, without fetching', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      const foreign: ImageReference = Object.freeze({ provider: 'sogni' });
      for (const references of [[foreign], [{ provider: 'fake' }], [null as unknown as ImageReference]]) {
        await expect(provider(fetchMock).generate(request({ references }))).rejects.toMatchObject({ code: 'invalid_input' });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses more references than the portrait limit', async () => {
      const fetchMock = withUploads();
      const references = await refs(fetchMock, MOMENT_PORTRAIT_MAX);
      const before = fetchMock.mock.calls.length;
      await expect(provider(fetchMock).generate(request({ references: [...references, references[0]] }))).rejects.toMatchObject({ code: 'invalid_input' });
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it('never puts a download link in a thrown error', async () => {
      const fetchMock = withUploads();
      const references = await refs(fetchMock, 2);
      const failing = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url) === 'https://api.sogni.test/v1/creative-agent/workflows' && init?.method === 'POST') return new Response('nope', { status: 400 });
        return fetchMock(url, init);
      });
      const error = await provider(failing).generate(request({ references })).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      const text = `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`;
      expect(text).not.toContain('down-SECRET');
      expect(text).not.toContain('media-input.sogni.test');
    });
  });

  it('polls through queued and running, then returns the downloaded picture', async () => {
    const fetchMock = sogniFetch(['queued', 'running']);
    const result = await provider(fetchMock).generate(request());
    expect(result).toEqual({ bytes: jpeg, contentType: 'image/jpeg', width: 1344, height: 768, workflowId: 'wf-1' });
    const targets = fetchMock.mock.calls.map(([url]) => String(url));
    expect(targets).toEqual([
      'https://api.sogni.test/v1/creative-agent/workflows',
      'https://api.sogni.test/v1/creative-agent/workflows/wf-1',
      'https://api.sogni.test/v1/creative-agent/workflows/wf-1',
      'https://api.sogni.test/v1/creative-agent/workflows/wf-1',
      artifactUrl,
    ]);
    for (const [, init] of fetchMock.mock.calls.slice(1, 4)) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
      expect((init?.headers as Record<string, string>)['user-agent']).toContain('twitch-ai-rpg');
    }
  });

  it('never sends the key to the artifact link', async () => {
    const fetchMock = sogniFetch([]);
    await provider(fetchMock).generate(request({ width: 768, height: 768, title: 'Portrait' }));
    const download = fetchMock.mock.calls.find(([url]) => String(url) === artifactUrl);
    expect(download).toBeDefined();
    const [, init] = download!;
    expect(init?.method).toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('accept')).toBe('image/jpeg, image/png, image/webp');
    expect(headers.get('user-agent')).toContain('twitch-ai-rpg');
    expect(JSON.stringify({ url: download![0], init: { ...init, signal: undefined } })).not.toContain(key);
  });

  describe('failure paths', () => {
    const base = 'https://api.sogni.test/v1/creative-agent/workflows';
    const sentinel = 'BODY-SENTINEL-do-not-leak';
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    const started = (status = 201) => Response.json({ status: 'success', data: { workflow: { workflowId: 'wf-1', status: 'queued' } } }, { status });
    const artifact = (overrides: Record<string, unknown> = {}) => workflow('completed', {
      steps: [{ id: 'image', artifacts: [{ id: 'a-1', kind: 'image', url: artifactUrl, mimeType: 'image/jpeg', ...overrides }] }],
    });
    // Routes by method and address; anything unplanned fails the test loudly.
    const script = (handlers: { start?: () => Response | Promise<Response>; poll?: () => Response | Promise<Response>; download?: () => Response | Promise<Response> }) =>
      vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target === base && init?.method === 'POST') return (handlers.start ?? started)();
        if (target === `${base}/wf-1/cancel`) return new Response(null, { status: 200 });
        if (target === `${base}/wf-1`) return (handlers.poll ?? completed)();
        if (target === artifactUrl) return (handlers.download ?? (() => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })))();
        throw new Error(`unexpected fetch ${target}`);
      });
    const cancels = (fetchMock: ReturnType<typeof script>) => fetchMock.mock.calls.filter(([url]) => String(url) === `${base}/wf-1/cancel`);
    const failureOf = async (promise: Promise<unknown>): Promise<ProviderError> => {
      const error = await promise.then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      const failure = error as ProviderError;
      expect(failure.message).not.toContain(key);
      expect(failure.message).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain(key);
      return failure;
    };

    it.each([
      ['safety_review_required', 'safety'],
      ['insufficient_credit', 'credit'],
      ['cost_approval_required', 'credit'],
      ['something_new', undefined],
    ])('cancels a workflow waiting for a person (%s) and reports reason %s', async (waitingReason, reason) => {
      const fetchMock = script({ poll: () => workflow('waiting_for_user', { waitingReason }) });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(error.reason).toBe(reason);
      const [cancel] = cancels(fetchMock);
      expect(cancels(fetchMock)).toHaveLength(1);
      expect(cancel[1]).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(cancel[1]?.body).toBeUndefined();
      expect((cancel[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    });

    it('reports waiting_for_user with no reason when Sogni names none', async () => {
      const error = await failureOf(provider(script({ poll: () => workflow('waiting_for_user') })).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response', reason: undefined });
    });

    it.each(['failed', 'partial_failure', 'cancelled'])('throws invalid_response for a %s workflow', async (status) => {
      const fetchMock = script({ poll: () => workflow(status, { error: sentinel }) });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(error.reason).toBeUndefined();
    });

    it('cancels and fails on a status it does not know', async () => {
      const fetchMock = script({ poll: () => workflow('hovering') });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(cancels(fetchMock)).toHaveLength(1);
    });

    it('fails when a completed workflow has no artifact', async () => {
      const fetchMock = script({ poll: () => workflow('completed', { steps: [{ id: 'image', artifacts: [] }] }) });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it.each([401, 402, 409])('gives http_error %i when the start is refused, with no retry', async (status) => {
      const fetchMock = script({ start: () => new Response(sentinel, { status }) });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'http_error', status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 429 start once and then gives http_error 429', async () => {
      const fetchMock = script({ start: () => new Response(sentinel, { status: 429 }) });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'http_error', status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a 500 start once with the same idempotency key', async () => {
      let attempts = 0;
      const fetchMock = script({ start: () => (++attempts === 1 ? new Response(sentinel, { status: 500 }) : started()) });
      const result = await provider(fetchMock).generate(request());
      expect(result.workflowId).toBe('wf-1');
      const starts = fetchMock.mock.calls.filter(([url]) => String(url) === base);
      expect(starts).toHaveLength(2);
      for (const [, init] of starts) expect((init?.headers as Record<string, string>)['idempotency-key']).toBe(requestId);
      expect(starts[1][1]?.body).toBe(starts[0][1]?.body);
    });

    it('fails when the start reply has no workflow id', async () => {
      const fetchMock = script({ start: () => Response.json({ status: 'success', data: { workflow: {} } }) });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(cancels(fetchMock)).toHaveLength(0);
    });

    it('tolerates three consecutive poll 5xx answers', async () => {
      let polls = 0;
      const fetchMock = script({ poll: () => (++polls <= 3 ? new Response(sentinel, { status: 503 }) : completed()) });
      await expect(provider(fetchMock).generate(request())).resolves.toMatchObject({ workflowId: 'wf-1' });
      expect(polls).toBe(4);
    });

    it('throws on the fourth consecutive poll 5xx answer', async () => {
      let polls = 0;
      const fetchMock = script({ poll: () => { polls += 1; return new Response(sentinel, { status: 503 }); } });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'http_error', status: 503 });
      expect(polls).toBe(4);
      expect(cancels(fetchMock)).toHaveLength(1);
    });

    it('counts a good poll answer as a fresh start for the strikes', async () => {
      const answers = [503, 503, 'running', 503, 503, 503, 'done'];
      const fetchMock = script({
        poll: () => {
          const next = answers.shift();
          if (typeof next === 'number') return new Response(null, { status: next });
          return next === 'running' ? workflow('running') : completed();
        },
      });
      await expect(provider(fetchMock).generate(request())).resolves.toMatchObject({ workflowId: 'wf-1' });
    });

    it('gives http_error for a poll answer that is not retryable', async () => {
      const fetchMock = script({ poll: () => new Response(sentinel, { status: 404 }) });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'http_error', status: 404 });
    });

    it('rejects a picture over the size limit', async () => {
      const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
      big.set(jpeg);
      const error = await failureOf(provider(script({ download: () => new Response(big, { headers: { 'content-type': 'image/jpeg' } }) })).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('rejects an empty picture', async () => {
      const error = await failureOf(provider(script({ download: () => new Response(new Uint8Array(0), { headers: { 'content-type': 'image/jpeg' } }) })).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('rejects a picture served with a disallowed content type', async () => {
      const error = await failureOf(provider(script({ download: () => new Response(jpeg, { headers: { 'content-type': 'text/html' } }) })).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('rejects a declared type that is not an image type', async () => {
      const fetchMock = script({ poll: () => artifact({ mimeType: 'text/html' }) });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock.mock.calls.some(([url]) => String(url) === artifactUrl)).toBe(false);
    });

    // Live Sogni (2026-10-24) labelled every JPEG artifact image/png and served it as image/jpeg.
    it('keeps a picture whose label names another image type, typed by its bytes', async () => {
      const fetchMock = script({ poll: () => artifact({ mimeType: 'image/png' }) });
      await expect(provider(fetchMock).generate(request())).resolves.toMatchObject({ contentType: 'image/jpeg', bytes: jpeg });
    });

    it('keeps a picture whose served type names another image type or a storage default', async () => {
      for (const served of ['image/png', 'image/jpg', 'binary/octet-stream']) {
        const fetchMock = script({ download: () => new Response(jpeg, { headers: { 'content-type': served } }) });
        await expect(provider(fetchMock).generate(request())).resolves.toMatchObject({ contentType: 'image/jpeg', bytes: jpeg });
      }
    });

    it('rejects bytes that are not a picture at all', async () => {
      const text = new TextEncoder().encode(sentinel);
      const error = await failureOf(provider(script({ download: () => new Response(text, { headers: { 'content-type': 'application/octet-stream' } }) })).generate(request()));
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('accepts a matching png served as octet-stream', async () => {
      const fetchMock = script({ poll: () => artifact({ mimeType: 'image/png' }), download: () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }) });
      await expect(provider(fetchMock).generate(request())).resolves.toMatchObject({ contentType: 'image/png', bytes: png });
    });

    it('rejects an http artifact link without fetching it', async () => {
      const fetchMock = script({ poll: () => artifact({ url: 'http://storage.sogni.test/media/image.jpg' }) });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.startsWith('http://'))).toBe(false);
    });

    it('rejects an artifact link that is not a web address', async () => {
      const fetchMock = script({ poll: () => artifact({ url: 'not a link' }) });
      await expect(provider(fetchMock).generate(request())).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('gives http_error when the artifact host refuses', async () => {
      const error = await failureOf(provider(script({ download: () => new Response(sentinel, { status: 403 }) })).generate(request()));
      expect(error).toMatchObject({ code: 'http_error', status: 403 });
    });

    it('cancels and throws timeout when the picture never completes in time', async () => {
      const fetchMock = script({ poll: () => workflow('running') });
      const slow = new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, pollMs: 2, timeoutMs: 40 });
      const error = await failureOf(slow.generate(request()));
      expect(error).toMatchObject({ code: 'timeout' });
      expect(cancels(fetchMock)).toHaveLength(1);
    });

    it('gives the whole picture 300 seconds by default', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = script({ poll: () => workflow('running') });
        const slow = new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, pollMs: 1_000 });
        let outcome: unknown = 'pending';
        void slow.generate(request()).then(() => { outcome = 'done'; }, (caught: unknown) => { outcome = caught; });
        await vi.advanceTimersByTimeAsync(299_000);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(outcome).toBeInstanceOf(ProviderError);
        expect(outcome).toMatchObject({ code: 'timeout' });
        expect(cancels(fetchMock)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels and throws timeout when one status check hangs past its own limit', async () => {
      const fetchMock = script({ poll: () => new Promise<Response>(() => {}) });
      const slow = new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, pollMs: 1, requestTimeoutMs: 5, timeoutMs: 60 });
      await expect(slow.generate(request())).rejects.toMatchObject({ code: 'timeout' });
      expect(cancels(fetchMock)).toHaveLength(1);
    });

    it('cancels and throws invalid_context when the caller aborts mid-poll', async () => {
      const controller = new AbortController();
      let polls = 0;
      const fetchMock = script({ poll: () => { if (++polls === 2) controller.abort(); return workflow('running'); } });
      const error = await failureOf(provider(fetchMock).generate(request({ signal: controller.signal })));
      expect(error).toMatchObject({ code: 'invalid_context' });
      expect(cancels(fetchMock)).toHaveLength(1);
    });

    it('throws invalid_context with no fetch when the signal is already aborted', async () => {
      const fetchMock = script({});
      await expect(provider(fetchMock).generate(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'invalid_context' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops promptly when the caller aborts while the start is in flight', async () => {
      const controller = new AbortController();
      const fetchMock = script({ start: () => { controller.abort(); return new Promise<Response>(() => {}); } });
      await expect(provider(fetchMock).generate(request({ signal: controller.signal }))).rejects.toMatchObject({ code: 'invalid_context' });
      expect(cancels(fetchMock)).toHaveLength(0);
    });

    it('gives network_error when the host cannot be reached on both start attempts', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => { throw new TypeError(`connect ECONNREFUSED ${sentinel}`); });
      const error = await failureOf(provider(fetchMock).generate(request()));
      expect(error).toMatchObject({ code: 'network_error' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each<[string, Partial<SogniOptions>]>([
      ['a blank key', { apiKey: '   ' }],
      ['an empty key', { apiKey: '' }],
      ['a key with a line break', { apiKey: 'abc\ndef' }],
      ['a bad model id', { model: 'Bad Model!' }],
      ['an empty model id', { model: '' }],
      ['a base address with credentials', { baseUrl: 'https://user:pass@api.sogni.test' }],
      ['a base address with a query', { baseUrl: 'https://api.sogni.test?x=1' }],
      ['a base address with a hash', { baseUrl: 'https://api.sogni.test#top' }],
      ['a base address that is not http or https', { baseUrl: 'ftp://api.sogni.test' }],
      ['a base address that is not an address', { baseUrl: 'not a url' }],
      ['a zero call timeout', { requestTimeoutMs: 0 }],
      ['a call timeout over the limit', { requestTimeoutMs: 120_001 }],
      ['a zero picture timeout', { timeoutMs: 0 }],
      ['a picture timeout over the limit', { timeoutMs: 300_001 }],
      ['a fractional picture timeout', { timeoutMs: 1.5 }],
      ['a zero poll interval', { pollMs: 0 }],
      ['a poll interval over the limit', { pollMs: 10_001 }],
      ['a blank user agent', { userAgent: ' ' }],
    ])('refuses %s as a configuration error before any fetch', (_label, options) => {
      const fetchMock = vi.fn<typeof fetch>();
      let error: unknown;
      try { new SogniImageProvider({ apiKey: key, fetch: fetchMock, ...options }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'configuration' });
      expect((error as Error).message).not.toContain(key);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<ImageRequest>]>([
      ['a control character in the prompt', { prompt: 'a foggy dock\u0007 at night' }],
      ['a line break in the prompt', { prompt: 'a foggy dock\nat night' }],
      ['a blank prompt', { prompt: '   ' }],
      ['a prompt without references over PICTURE_PROMPT_MAX', { prompt: 'a'.repeat(PICTURE_PROMPT_MAX + 1) }],
      ['a control character in the negative prompt', { negativePrompt: 'text\u0000' }],
      ['a negative prompt over 1000 characters', { negativePrompt: 'a'.repeat(1001) }],
      ['a width that is not a multiple of 64', { width: 1000 }],
      ['a height that is not a multiple of 64', { height: 700 }],
      ['a width under 256', { width: 192 }],
      ['a height over 2048', { height: 2112 }],
      ['a request id that is not a UUID', { requestId: 'not-a-uuid' }],
      ['a blank title', { title: ' ' }],
      ['a title over 80 characters', { title: 'a'.repeat(81) }],
    ])('refuses %s as invalid input before any fetch', async (_label, overrides) => {
      const fetchMock = vi.fn<typeof fetch>();
      const error = await failureOf(provider(fetchMock).generate(request(overrides)));
      expect(error).toMatchObject({ code: 'invalid_input' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the key and response bodies out of every failure message', async () => {
      const cases = [
        script({ start: () => new Response(`${key} ${sentinel}`, { status: 401 }) }),
        script({ poll: () => new Response(`${key} ${sentinel}`, { status: 404 }) }),
        script({ poll: () => workflow('failed', { message: `${key} ${sentinel}` }) }),
        script({ poll: () => workflow('waiting_for_user', { waitingReason: `${key} ${sentinel}` }) }),
        script({ download: () => new Response(`${key} ${sentinel}`, { status: 500 }) }),
        script({ start: () => new Response(`{"data":"${sentinel}`, { status: 201 }) }),
      ];
      for (const fetchMock of cases) {
        const error = await failureOf(provider(fetchMock).generate(request()));
        expect(error.stack ?? '').not.toContain(sentinel);
      }
    });
  });
});
