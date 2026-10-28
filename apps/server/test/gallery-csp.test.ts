import { describe, expect, it } from 'vitest';
import { GALLERY_CSP } from '../src/gallery-routes';

describe('gallery content security policy', () => {
  it('allows only the directives it always had plus font-src self', () => {
    expect(GALLERY_CSP.split('; ')).toEqual([
      "default-src 'none'",
      "img-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
  });
});
