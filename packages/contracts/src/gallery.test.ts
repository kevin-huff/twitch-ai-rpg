import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GalleryActionSchema, GallerySlugSchema, GalleryStatusSchema, SessionListEntrySchema } from './index.js';

const slug = randomBytes(32).toString('base64url');
const status = { state: 'on', listed: true, url: 'https://example.test/gallery/x/', listUrl: 'https://example.test/gallery/', pictures: 3, pending: 1, writtenAt: '2026-10-25T20:14:00.000Z', message: null, local: false };

describe('GallerySlugSchema', () => {
  it('accepts a 43-character base64url slug', () => {
    expect(GallerySlugSchema.safeParse(slug).success).toBe(true);
  });

  it('rejects slugs of the wrong length', () => {
    expect(GallerySlugSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(GallerySlugSchema.safeParse('a'.repeat(44)).success).toBe(false);
  });

  it('rejects +, / and =', () => {
    expect(GallerySlugSchema.safeParse(`${'a'.repeat(42)}+`).success).toBe(false);
    expect(GallerySlugSchema.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
    expect(GallerySlugSchema.safeParse(`${'a'.repeat(42)}=`).success).toBe(false);
  });
});

describe('GalleryActionSchema', () => {
  it('accepts each action word', () => {
    for (const action of ['on', 'off', 'new_link', 'list', 'unlist', 'rewrite']) {
      expect(GalleryActionSchema.safeParse({ action }).success).toBe(true);
    }
  });

  it('rejects other words and extra keys', () => {
    expect(GalleryActionSchema.safeParse({ action: 'publish' }).success).toBe(false);
    expect(GalleryActionSchema.safeParse({ action: 'on', slug }).success).toBe(false);
  });
});

describe('GalleryStatusSchema', () => {
  it('accepts a full example for each state', () => {
    for (const state of ['closed', 'off', 'on']) {
      expect(GalleryStatusSchema.safeParse({ ...status, state }).success).toBe(true);
    }
  });

  it('accepts null url, writtenAt and message', () => {
    expect(GalleryStatusSchema.safeParse({ ...status, state: 'off', url: null, writtenAt: null, message: null }).success).toBe(true);
  });

  it('refuses an unknown key', () => {
    expect(GalleryStatusSchema.safeParse({ ...status, slug }).success).toBe(false);
  });

  it('refuses a 301-character message and accepts 300', () => {
    expect(GalleryStatusSchema.safeParse({ ...status, message: 'x'.repeat(301) }).success).toBe(false);
    expect(GalleryStatusSchema.safeParse({ ...status, message: 'x'.repeat(300) }).success).toBe(true);
  });

  it('refuses negative or fractional pictures and pending', () => {
    expect(GalleryStatusSchema.safeParse({ ...status, pictures: -1 }).success).toBe(false);
    expect(GalleryStatusSchema.safeParse({ ...status, pictures: 1.5 }).success).toBe(false);
    expect(GalleryStatusSchema.safeParse({ ...status, pending: -1 }).success).toBe(false);
    expect(GalleryStatusSchema.safeParse({ ...status, pending: 0.5 }).success).toBe(false);
  });
});

describe('SessionListEntrySchema', () => {
  const entry = { id: 'show-1', title: 'Show', status: 'ended' };

  it('accepts gallery null and a gallery with listed and url', () => {
    expect(SessionListEntrySchema.safeParse({ ...entry, gallery: null }).success).toBe(true);
    expect(SessionListEntrySchema.safeParse({ ...entry, gallery: { listed: false, url: 'https://example.test/gallery/x/' } }).success).toBe(true);
  });

  it('refuses extra keys at both levels', () => {
    expect(SessionListEntrySchema.safeParse({ ...entry, gallery: null, extra: 1 }).success).toBe(false);
    expect(SessionListEntrySchema.safeParse({ ...entry, gallery: { listed: true, url: 'u', slug } }).success).toBe(false);
  });
});
