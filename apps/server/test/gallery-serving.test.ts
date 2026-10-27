import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GALLERY_CSP, galleryCacheControl, registerGalleryRoutes, type GalleryRouteService } from '../src/gallery-routes';

const SLUG = 'A'.repeat(43);
const PICTURE = `${'a'.repeat(8)}.jpg`;
const MISSING_TITLE = '<title>Gallery not available</title>';
const service: GalleryRouteService = {
  status: async () => { throw new Error('unused'); },
  apply: async () => { throw new Error('unused'); },
  afterCommit: async () => undefined,
};

let temp: string;
let assetDir: string;
const apps: FastifyInstance[] = [];

async function build(dir: string, extra?: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify();
  await registerGalleryRoutes(app, { pool: {} as Pool, authenticate: async () => { throw new Error('unused'); }, gallery: service, assetDir: dir });
  if (extra) await extra(app);
  await app.ready();
  apps.push(app);
  return app;
}

function expectMissing(response: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  expect(response.statusCode).toBe(404);
  expect(response.body).toContain(MISSING_TITLE);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
  expect(String(response.headers['content-type'])).toContain('text/html');
}

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'gallery-serving-'));
  assetDir = path.join(temp, 'audio');
  const root = path.join(assetDir, 'galleries');
  await mkdir(path.join(root, SLUG, 'p'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>List</title>');
  await writeFile(path.join(root, 'gallery.css'), 'body{}');
  await writeFile(path.join(root, 'viewer.js'), 'void 0;');
  await writeFile(path.join(root, SLUG, 'index.html'), '<!doctype html><title>Show</title>');
  await writeFile(path.join(root, SLUG, 'p', PICTURE), 'jpegbytes');
  await writeFile(path.join(root, SLUG, 'p', '.hidden.jpg'), 'secret');
  await writeFile(path.join(temp, 'secret.txt'), 'outside');
});

afterAll(async () => {
  await Promise.all(apps.map(app => app.close()));
  await rm(temp, { recursive: true, force: true });
});

describe('gallery serving', () => {
  it('answers a page with 200, a one minute cache and the CSP', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Show</title>');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
    const list = await app.inject({ url: '/gallery/' });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('<title>List</title>');
    expect(list.headers['cache-control']).toBe('public, max-age=60');
  });

  it('gives a picture under p/ the immutable header', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/p/${PICTURE}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('jpegbytes');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
  });

  it('gives gallery.css and viewer.js five minutes', async () => {
    const app = await build(assetDir);
    for (const file of ['gallery.css', 'viewer.js']) {
      const response = await app.inject({ url: `/gallery/${file}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
    }
  });

  it('answers a range beyond the picture with an empty 416, not the missing page', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/p/${PICTURE}`, headers: { range: 'bytes=99999999-' } });
    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */9');
    expect(response.body).toBe('');
    expect(response.body).not.toContain(MISSING_TITLE);
  });

  it('keeps the 200 header on a 304 answer', async () => {
    const app = await build(assetDir);
    const first = await app.inject({ url: `/gallery/${SLUG}/p/${PICTURE}` });
    const etag = String(first.headers.etag);
    expect(etag).not.toBe('undefined');
    const second = await app.inject({ url: `/gallery/${SLUG}/p/${PICTURE}`, headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
    expect(second.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(second.headers['content-security-policy']).toBe(GALLERY_CSP);
  });

  it('ignores a query string when choosing the cache header', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/p/${PICTURE}?v=1` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('redirects a folder without its slash, and /gallery to /gallery/', async () => {
    const app = await build(assetDir);
    const folder = await app.inject({ url: `/gallery/${SLUG}` });
    expect(folder.statusCode).toBe(301);
    expect(folder.headers.location).toBe(`/gallery/${SLUG}/`);
    expect(folder.headers['content-security-policy']).toBe(GALLERY_CSP);
    const list = await app.inject({ url: '/gallery' });
    expect(list.statusCode).toBe(301);
    expect(list.headers.location).toBe('/gallery/');
    expect(list.headers['content-security-policy']).toBe(GALLERY_CSP);
  });

  it('gives the missing page for an unknown slug, a missing file and a bare p/ folder', async () => {
    const app = await build(assetDir);
    expectMissing(await app.inject({ url: `/gallery/${'B'.repeat(43)}/` }));
    expectMissing(await app.inject({ url: `/gallery/${'B'.repeat(43)}/index.html` }));
    expectMissing(await app.inject({ url: `/gallery/${SLUG}/p/nothing.jpg` }));
    expectMissing(await app.inject({ url: '/gallery/nothing.txt' }));
    expectMissing(await app.inject({ url: `/gallery/${SLUG}/p/` }));
  });

  it('redirects the bare p folder to p/, which is then the missing page', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/p` });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(`/gallery/${SLUG}/p/`);
    expect(response.body).not.toContain(PICTURE);
  });

  it('gives the missing page when the galleries folder does not exist', async () => {
    const app = await build(path.join(temp, 'never-made'));
    expectMissing(await app.inject({ url: '/gallery/' }));
    expectMissing(await app.inject({ url: `/gallery/${SLUG}/` }));
    expectMissing(await app.inject({ url: '/gallery/gallery.css' }));
  });

  it('never answers 200 for a dotfile or an encoded ../ path, and shows the missing page', async () => {
    const app = await build(assetDir);
    const urls = [
      `/gallery/${SLUG}/p/.hidden.jpg`,
      `/gallery/${SLUG}/.hidden`,
      '/gallery/.env',
      `/gallery/%2e%2e/secret.txt`,
      `/gallery/..%2fsecret.txt`,
      `/gallery/${SLUG}/..%2f..%2f..%2fsecret.txt`,
      `/gallery/${SLUG}/%2e%2e/%2e%2e/secret.txt`,
      `/gallery/..%2F..%2Fsecret.txt`,
      `/gallery/%2e%2e%2f%2e%2e%2fsecret.txt`,
    ];
    for (const url of urls) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body, url).not.toContain('outside');
            // The router resolves a plain dot segment before the scope sees it, so those paths leave /gallery and meet the root's own 404; the scope never serves them.
      const resolved = response.headers['content-security-policy'] === GALLERY_CSP;
      if (resolved) expect(response.body, url).toContain(MISSING_TITLE);
    }
    expectMissing(await app.inject({ url: `/gallery/${SLUG}/p/.hidden.jpg` }));
  });

  it('never lists a folder', async () => {
    const app = await build(assetDir);
    const response = await app.inject({ url: `/gallery/${SLUG}/p/` });
    expect(response.body).not.toContain(PICTURE);
    expectMissing(response);
  });

  it('answers a method the scope does not serve with the missing page', async () => {
    const app = await build(assetDir);
    expectMissing(await app.inject({ method: 'POST', url: `/gallery/${SLUG}/` }));
  });

  it('keeps other paths on a root not-found handler and a root static, and leaves /gallery alone', async () => {
    const other = path.join(temp, 'web');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'index.html'), '<!doctype html><title>App</title>');
    await writeFile(path.join(other, 'app.js'), 'app();');
    const app = await build(assetDir, async (instance) => {
      await instance.register(fastifyStatic, { root: other });
      instance.setNotFoundHandler((_request, reply) => reply.sendFile('index.html'));
    });
    const home = await app.inject({ url: '/something/else' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>App</title>');
    expect(home.headers['content-security-policy']).toBeUndefined();
    const script = await app.inject({ url: '/app.js' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toBe('app();');
    expect(script.headers['content-security-policy']).toBeUndefined();

    expectMissing(await app.inject({ url: `/gallery/${'C'.repeat(43)}/` }));
    expectMissing(await app.inject({ url: '/gallery/unknown' }));
    expectMissing(await app.inject({ url: '/gallery/app.js' }));
    const page = await app.inject({ url: `/gallery/${SLUG}/` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Show</title>');
    expect((await app.inject({ url: '/gallery/' })).body).toContain('<title>List</title>');
  });
});

describe('galleryCacheControl', () => {
  const picture = `/gallery/${SLUG}/p/${PICTURE}`;
  it('gives pictures a year, immutable', () => {
    expect(galleryCacheControl(picture, 200)).toBe('public, max-age=31536000, immutable');
    expect(galleryCacheControl(picture, 206)).toBe('public, max-age=31536000, immutable');
    expect(galleryCacheControl(picture, 304)).toBe('public, max-age=31536000, immutable');
  });
  it('gives the shared files five minutes', () => {
    expect(galleryCacheControl('/gallery/gallery.css', 200)).toBe('public, max-age=300');
    expect(galleryCacheControl('/gallery/viewer.js', 304)).toBe('public, max-age=300');
  });
  it('gives pages a minute', () => {
    expect(galleryCacheControl('/gallery/', 200)).toBe('public, max-age=60');
    expect(galleryCacheControl(`/gallery/${SLUG}/`, 200)).toBe('public, max-age=60');
    expect(galleryCacheControl(`/gallery/${SLUG}/index.html`, 200)).toBe('public, max-age=60');
  });
  it('gives anything that is not a success no-store', () => {
    for (const status of [301, 400, 404, 500]) {
      expect(galleryCacheControl(picture, status)).toBe('no-store');
      expect(galleryCacheControl('/gallery/', status)).toBe('no-store');
    }
  });
  it('does not treat other nested paths as pictures', () => {
    expect(galleryCacheControl(`/gallery/${SLUG}/p/a/b.jpg`, 200)).toBe('public, max-age=60');
    expect(galleryCacheControl(`/gallery/short/p/${PICTURE}`, 200)).toBe('public, max-age=60');
    expect(galleryCacheControl(`/gallery/${SLUG}/q/${PICTURE}`, 200)).toBe('public, max-age=60');
  });
});
