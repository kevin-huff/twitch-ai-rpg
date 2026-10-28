import { describe, expect, it } from 'vitest';
import { galleryListPage, galleryPage } from '../src/gallery-html';
import type { GalleryListEntry, GalleryPicture, GalleryView } from '../src/gallery-model';

const SLUG = 'A'.repeat(43);
const options = { origin: 'https://tales.example.com/', slug: SLUG, timeZone: 'UTC' };

function picture(id: string, overrides: Partial<GalleryPicture> = {}): GalleryPicture {
  return {
    id, file: `${id}.jpg`, fileHash: `hash-${id}`, contentType: 'image/jpeg', width: 1024, height: 768,
    label: 'The place', line: null, tag: null, model: 'Flux Klein', prompt: `A prompt for ${id}`, ...overrides,
  };
}

function view(overrides: Partial<GalleryView> = {}): GalleryView {
  const scene1 = picture('s1', { label: 'Action round 1', line: 'The gate creaks open.', tag: 'Hidden' });
  const scene2 = picture('s2', { label: 'Beat 2', line: 'A cold wind.' });
  const lia = picture('p1', { label: 'Lia', prompt: 'Lia the ranger' });
  const more = picture('m1', { label: 'Old Tom', prompt: 'Old Tom, younger' });
  return {
    sessionId: 'sess', title: 'The Canal Gate', endedAt: '2026-10-25T23:30:00.000Z',
    cast: [
      { kind: 'player', name: 'Lia', initials: 'L', portrait: lia },
      { kind: 'player', name: 'Mo Vex', initials: 'MV', portrait: null },
    ],
    scenes: [
      { number: 1, title: 'Arrival', pictures: [scene1] },
      { number: 3, title: '', pictures: [scene2] },
    ],
    morePortraits: [{ name: 'Old Tom', pictures: [more] }],
    pending: 0, cover: scene1, ...overrides,
  };
}

const empty = (): GalleryView => view({ cast: [], scenes: [], morePortraits: [], cover: null, endedAt: null });

describe('galleryPage head', () => {
  const html = galleryPage(view(), options);

  it('has the document basics', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<link rel="stylesheet" href="/gallery/gallery.css">');
    expect(html).toContain('<link rel="stylesheet" href="/fonts/fonts.css">');
    expect(html.indexOf('/fonts/fonts.css')).toBeLessThan(html.indexOf('/gallery/gallery.css'));
    expect(html).toContain('<script src="/gallery/viewer.js" defer></script>');
  });

  it('names the page and its share tags', () => {
    expect(html).toContain('<title>The Canal Gate · Gallery</title>');
    expect(html).toContain('<meta property="og:title" content="The Canal Gate · Gallery">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(`<meta property="og:url" content="https://tales.example.com/gallery/${SLUG}/">`);
    expect(html).toContain(`<meta property="og:image" content="https://tales.example.com/gallery/${SLUG}/p/s1.jpg">`);
  });

  it('leaves out og:image without a cover', () => {
    expect(galleryPage(empty(), options)).not.toContain('og:image');
  });

  it('has no inline style or script and no event attributes', () => {
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe('galleryPage body', () => {
  const html = galleryPage(view(), options);

  it('has the heading, the date and the count', () => {
    expect(html).toContain('<h1>The Canal Gate</h1>');
    expect(html).toContain('<p class="gallery-date">Show of <time datetime="2026-10-25T23:30:00.000Z">October 25, 2026</time></p>');
    expect(html).toContain('<p class="gallery-count">4 pictures</p>');
  });

  it('leaves out the date when the show has no end', () => {
    expect(galleryPage(view({ endedAt: null }), options)).not.toContain('gallery-date');
  });

  it('says 1 picture for a single picture', () => {
    const one = view({ cast: [], morePortraits: [], scenes: [{ number: 1, title: 'A', pictures: [picture('x')] }] });
    expect(galleryPage(one, options)).toContain('<p class="gallery-count">1 picture</p>');
  });

  it('has the cast strip with a portrait link and an initials circle', () => {
    expect(html).toContain('<section class="gallery-cast"><h2>Cast</h2><ul class="cast-list">');
    expect(html).toContain(`<li class="cast-member"><a class="gallery-link" href="/gallery/${SLUG}/p/p1.jpg" data-caption="Lia"`);
    expect(html).toContain('<span class="cast-name">Lia</span>');
    expect(html).toContain('<li class="cast-member"><span class="cast-initials" aria-hidden="true">MV</span><span class="cast-name">Mo Vex</span></li>');
  });

  it('leaves out the cast section when there are no members', () => {
    expect(galleryPage(view({ cast: [] }), options)).not.toContain('gallery-cast');
  });

  it('numbers scenes by their place and keeps gaps', () => {
    expect(html).toContain('<h2>Scene 1 · Arrival</h2>');
    expect(html).toContain('<h2>Scene 3</h2>');
    expect(html).not.toContain('Scene 2');
  });

  it('builds each figure with its parts in order', () => {
    const link = `<a class="gallery-link" href="/gallery/${SLUG}/p/s1.jpg" data-caption="Action round 1 “The gate creaks open.” · Hidden" data-model="Flux Klein" data-prompt="A prompt for s1">`;
    expect(html).toContain(link);
    expect(html).toContain(`<img src="/gallery/${SLUG}/p/s1.jpg" alt="A prompt for s1" width="1024" height="768" loading="lazy" decoding="async">`);
    expect(html).toContain('<figcaption><span class="picture-label">Action round 1</span> <span class="picture-line">“The gate creaks open.”</span> <span class="picture-tag">Hidden</span></figcaption>');
    expect(html).toContain('<details class="picture-drawn"><summary>How this was drawn</summary><p class="picture-model">Model: Flux Klein</p><p class="picture-prompt">A prompt for s1</p></details>');
  });

  it('leaves out the line and tag spans when they are absent', () => {
    expect(html).toContain('<figcaption><span class="picture-label">Old Tom</span></figcaption>');
    expect(html).toContain('<figcaption><span class="picture-label">Beat 2</span> <span class="picture-line">“A cold wind.”</span></figcaption>');
  });

  it('shows more portraits grouped by name', () => {
    expect(html).toContain('<section class="gallery-more"><h2>More portraits</h2>');
    expect(html).toContain('<div class="portrait-group"><h3>Old Tom</h3><div class="picture-grid">');
  });

  it('leaves out more portraits when there are none', () => {
    expect(galleryPage(view({ morePortraits: [] }), options)).not.toContain('gallery-more');
  });

  it('has the footer with the link to the list', () => {
    expect(html).toContain('<footer class="gallery-foot"><p>Pictures drawn with Sogni. The model is named under each picture.</p><p><a href="/gallery/">All galleries</a></p></footer>');
  });

  it('does not show the empty sentence when there are pictures', () => {
    expect(html).not.toContain('gallery-empty');
  });

  it('says so when the show has no pictures', () => {
    const page = galleryPage(empty(), options);
    expect(page).toContain('<p class="gallery-empty">No pictures were drawn in this show.</p>');
    expect(page).toContain('<p class="gallery-count">0 pictures</p>');
  });

  it('counts a picture once even when it appears twice', () => {
    const shared = picture('dup');
    const dup = view({
      cast: [{ kind: 'player', name: 'Lia', initials: 'L', portrait: shared }],
      scenes: [{ number: 1, title: 'A', pictures: [shared] }], morePortraits: [],
    });
    expect(galleryPage(dup, options)).toContain('<p class="gallery-count">1 picture</p>');
  });
});

describe('galleryListPage', () => {
  const entry = (slug: string, title: string, endedAt: string | null, pictures: number, cover: GalleryPicture | null): GalleryListEntry =>
    ({ slug, title, endedAt, pictures, cover });
  const entries = [
    entry('old', 'Older Show', '2026-09-01T12:00:00.000Z', 1, null),
    entry('none', 'Undated Show', null, 2, null),
    entry('new', 'Newer Show', '2026-10-25T23:30:00.000Z', 5, picture('c1', { prompt: 'cover prompt' })),
    entry('also-new', 'Alpha Show', '2026-10-25T23:30:00.000Z', 3, null),
  ];
  const html = galleryListPage(entries, { origin: 'https://tales.example.com', timeZone: 'UTC' });

  it('has the head and no script', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Story Table galleries</title>');
    expect(html).toContain('<h1>Story Table galleries</h1>');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<link rel="stylesheet" href="/gallery/gallery.css">');
    expect(html).toContain('<link rel="stylesheet" href="/fonts/fonts.css">');
    expect(html.indexOf('/fonts/fonts.css')).toBeLessThan(html.indexOf('/gallery/gallery.css'));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('sorts newest first, then by title, with undated last', () => {
    const order = [...html.matchAll(/gallery-card-title">([^<]+)</g)].map(m => m[1]);
    expect(order).toEqual(['Alpha Show', 'Newer Show', 'Older Show', 'Undated Show']);
  });

  it('builds cards with the cover, title, date and count', () => {
    expect(html).toContain('<li class="gallery-card"><a href="/gallery/new/"><img class="gallery-card-cover" src="/gallery/new/p/c1.jpg" alt="cover prompt" width="1024" height="768" loading="lazy" decoding="async"><span class="gallery-card-title">Newer Show</span><time class="gallery-card-date" datetime="2026-10-25T23:30:00.000Z">October 25, 2026</time><span class="gallery-card-count">5 pictures</span></a></li>');
    expect(html).toContain('<li class="gallery-card"><a href="/gallery/old/"><span class="gallery-card-title">Older Show</span><time class="gallery-card-date" datetime="2026-09-01T12:00:00.000Z">September 1, 2026</time><span class="gallery-card-count">1 picture</span></a></li>');
    expect(html).toContain('<li class="gallery-card"><a href="/gallery/none/"><span class="gallery-card-title">Undated Show</span><span class="gallery-card-count">2 pictures</span></a></li>');
  });

  it('does not mutate the entries it is given', () => {
    expect(entries.map(e => e.slug)).toEqual(['old', 'none', 'new', 'also-new']);
  });

  it('says so when there are no galleries', () => {
    const page = galleryListPage([], { origin: 'https://tales.example.com', timeZone: 'UTC' });
    expect(page).toContain('<p class="gallery-empty">No galleries yet.</p>');
    expect(page).not.toContain('gallery-list');
  });
});

describe('escaping', () => {
  const nasty = `<script>alert("x")</script> 'q' & "d"`;
  const escaped = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;q&#39; &amp; &quot;d&quot;';

  it('escapes the title, names, lines, tags and prompts of a show page', () => {
    const bad = picture('e1', { label: nasty, line: nasty, prompt: nasty, model: nasty });
    const page = galleryPage({
      sessionId: 's', title: nasty, endedAt: null,
      cast: [
        { kind: 'player', name: nasty, initials: '<S', portrait: bad },
        { kind: 'player', name: nasty, initials: '<S', portrait: null },
      ],
      scenes: [{ number: 1, title: nasty, pictures: [bad] }],
      morePortraits: [{ name: nasty, pictures: [picture('e2', { prompt: nasty })] }],
      pending: 0, cover: bad,
    }, options);
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('alert("x")');
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain(`<h1>${escaped}</h1>`);
    expect(page).toContain(`<title>${escaped} · Gallery</title>`);
    expect(page).toContain(`<h2>Scene 1 · ${escaped}</h2>`);
    expect(page).toContain(`alt="${escaped}"`);
    expect(page).toContain(`data-prompt="${escaped}"`);
    expect(page).toContain(`data-model="${escaped}"`);
    expect(page).toContain(`<span class="picture-line">“${escaped}”</span>`);
    expect(page).toContain(`<span class="cast-name">${escaped}</span>`);
    expect(page).toContain(`<h3>${escaped}</h3>`);
    expect(page).toContain('<span class="cast-initials" aria-hidden="true">&lt;S</span>');
    expect(page).toContain(`data-caption="${escaped}"`);
  });

  it('escapes the origin and slug in the share tags', () => {
    const page = galleryPage(view(), { origin: 'https://a.example/"><b>', slug: 'x"y', timeZone: 'UTC' });
    expect(page).not.toContain('"><b>');
    expect(page).toContain('og:url" content="https://a.example/&quot;&gt;&lt;b&gt;/gallery/x&quot;y/"');
  });

  it('escapes the list page', () => {
    const page = galleryListPage([
      { slug: 'k', title: nasty, endedAt: null, pictures: 1, cover: picture('e3', { prompt: nasty }) },
    ], { origin: 'https://tales.example.com' });
    expect(page).not.toContain('<script');
    expect(page).toContain(`<span class="gallery-card-title">${escaped}</span>`);
    expect(page).toContain(`alt="${escaped}"`);
  });
});

describe('pictures that never aired', () => {
  const draft = picture('d1', { label: 'Earlier draft of action round 1', line: null, tag: 'Not shown on stream', prompt: 'Draft prompt one' });
  const html = galleryPage(view({ scenes: [{ number: 1, title: 'Arrival', pictures: [draft] }], cover: draft }), options);

  it('shows their prompt like every other picture', () => {
    const link = html.match(/<a class="gallery-link" href="[^"]*\/d1\.jpg"[^>]*>/)![0];
    expect(link).toContain('data-prompt="Draft prompt one"');
    expect(html).toContain('alt="Draft prompt one"');
    expect(html).toContain('<p class="picture-prompt">Draft prompt one</p>');
  });
});
