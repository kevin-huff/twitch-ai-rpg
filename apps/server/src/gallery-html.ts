import { captionText, galleryPictures, picturesText, type GalleryListEntry, type GalleryPicture, type GalleryView } from './gallery-model';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function galleryMissingPage(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>Gallery not available</title>',
    '<link rel="stylesheet" href="/gallery/gallery.css">',
    '</head>',
    '<body>',
    '<main class="gallery gallery-missing">',
    "<h1>This gallery isn't available.</h1>",
    '<p>The link may have been turned off, or it may be wrong.</p>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export const GALLERY_CSS = `:root {
  color-scheme: dark;
  --bg: #111514;
  --ink: #eeeee6;
  --muted: #a7b2ac;
  --gold: #ddba76;
  --line: #35403b;
  --panel: #1a211e;
  --teal: #91c8b6;
  --serif: Georgia, 'Times New Roman', serif;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; min-width: 320px; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.6; }
a { color: var(--gold); text-underline-offset: 4px; }
a:hover { color: #f0d9a4; }
:focus-visible { outline: 3px solid #a6d9c8; outline-offset: 3px; }
h1, h2, h3, p { margin-top: 0; }
h1, h2 { font-family: var(--serif); font-weight: 400; letter-spacing: -.03em; }
h1 { font-size: clamp(1.9rem, 6vw, 3.2rem); line-height: 1.1; margin-bottom: .6rem; overflow-wrap: anywhere; }
h2 { font-size: clamp(1.3rem, 4vw, 1.8rem); line-height: 1.2; margin-bottom: 1rem; overflow-wrap: anywhere; }
h3 { font-size: 1rem; line-height: 1.4; margin-bottom: .8rem; color: var(--teal); overflow-wrap: anywhere; }
img { display: block; max-width: 100%; }

.gallery { max-width: 1200px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.gallery-head { margin-bottom: 2rem; padding-bottom: 1.2rem; border-bottom: 1px solid var(--line); }
.gallery-date, .gallery-count { margin-bottom: .2rem; color: var(--muted); font-size: .95rem; }
.gallery-count { color: var(--gold); font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
.gallery-cast, .gallery-scene, .gallery-more { margin-bottom: 2.6rem; }
.gallery-empty { color: var(--muted); font-size: 1.05rem; padding: 2rem 0; }

.cast-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.cast-member { display: flex; flex-direction: column; align-items: center; gap: .5rem; width: 92px; text-align: center; }
.cast-member .gallery-link { display: block; width: 76px; height: 76px; border-radius: 50%; overflow: hidden; border: 2px solid var(--line); background: var(--panel); }
.cast-member .gallery-link img { width: 100%; height: 100%; object-fit: cover; }
.cast-initials { display: grid; place-items: center; width: 76px; height: 76px; border-radius: 50%; border: 2px solid var(--line); background: #343c31; color: #e3c58e; font-family: var(--serif); font-size: 1.5rem; }
.cast-name { font-size: .8rem; line-height: 1.3; color: #d6ddd7; overflow-wrap: anywhere; }

.picture-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 1.1rem; align-items: start; }
.portrait-group { margin-bottom: 1.6rem; }
.picture { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.picture .gallery-link { display: block; background: #0c0f0e; }
.picture img { width: 100%; height: auto; }
.picture figcaption { padding: .8rem .9rem .4rem; font-size: .88rem; line-height: 1.5; overflow-wrap: anywhere; }
.picture-label { font-weight: 700; color: var(--ink); }
.picture-line { color: #c9d1ca; font-family: var(--serif); font-style: italic; }
.picture-tag { display: inline-block; margin-top: .2rem; padding: .05rem .55rem; border: 1px solid #7b6746; border-radius: 30px; color: #edc98d; font-size: .72rem; letter-spacing: .03em; white-space: nowrap; }
.picture-drawn { padding: 0 .9rem .8rem; font-size: .8rem; color: var(--muted); }
.picture-drawn summary { cursor: pointer; padding: .3rem 0; color: var(--teal); }
.picture-drawn p { margin: .4rem 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.picture-model { color: #c9d1ca; }

.gallery-foot { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
.gallery-foot p { margin-bottom: .4rem; }

.gallery-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 1.1rem; }
.gallery-card { margin: 0; }
.gallery-card a { display: flex; flex-direction: column; gap: .3rem; height: 100%; padding-bottom: .9rem; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; color: var(--ink); text-decoration: none; }
.gallery-card a:hover { border-color: var(--gold); }
.gallery-card-cover { width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; background: #0c0f0e; margin-bottom: .4rem; }
.gallery-card-title { padding: 0 .9rem; font-family: var(--serif); font-size: 1.2rem; line-height: 1.25; overflow-wrap: anywhere; }
.gallery-card-date, .gallery-card-count { padding: 0 .9rem; color: var(--muted); font-size: .82rem; }
.gallery-card-count { color: var(--gold); }

.gallery-missing { text-align: center; padding-top: 18vh; }
.gallery-missing p { color: var(--muted); }

.gallery-viewer { width: min(96vw, 1100px); max-width: 96vw; max-height: 96vh; padding: 1rem; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; overflow: auto; }
.gallery-viewer::backdrop { background: rgba(5, 8, 7, .88); }
.viewer-figure { margin: 0 0 .8rem; }
.viewer-image { width: auto; max-width: 100%; max-height: 66vh; height: auto; margin: 0 auto; border-radius: 6px; background: #0c0f0e; }
.viewer-caption { margin-top: .7rem; font-size: .95rem; line-height: 1.5; overflow-wrap: anywhere; }
.viewer-model { margin-bottom: .3rem; color: var(--teal); font-size: .82rem; }
.viewer-prompt { margin-bottom: .9rem; color: var(--muted); font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; max-height: 9rem; overflow: auto; }
.viewer-nav { display: flex; flex-wrap: wrap; gap: .6rem; justify-content: center; }
.viewer-nav button { min-height: 44px; min-width: 88px; padding: .6rem 1rem; font: inherit; font-size: .88rem; font-weight: 650; border-radius: 6px; border: 1px solid #526057; background: transparent; color: #e0e5df; cursor: pointer; }
.viewer-nav button:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
.viewer-nav button:disabled { opacity: .4; cursor: not-allowed; }
.viewer-nav .viewer-close { background: var(--gold); border-color: var(--gold); color: #1c211c; }
.viewer-nav .viewer-close:hover { color: #1c211c; filter: brightness(1.08); }

@media (max-width: 420px) {
  .gallery { padding: 1rem .8rem 2.5rem; }
  .picture-grid, .gallery-list { grid-template-columns: 1fr; }
  .cast-list { gap: .8rem; }
  .gallery-viewer { padding: .7rem; }
  .viewer-nav button { flex: 1 1 0; min-width: 0; padding-inline: .4rem; }
}
`;

// Raise this when a change to the page markup, GALLERY_CSS or GALLERY_SCRIPT would leave pages already written looking wrong; the next start rewrites every gallery.
export const GALLERY_PAGE_VERSION = 1;

export const GALLERY_SCRIPT = String.raw`(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('a.gallery-link'));
  if (!links.length) return;
  var dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return;
  dialog.setAttribute('class', 'gallery-viewer');
  dialog.setAttribute('aria-label', 'Picture viewer');

  function make(tag, className, text) {
    var node = document.createElement(tag);
    node.setAttribute('class', className);
    if (text) node.textContent = text;
    return node;
  }

  var figure = make('figure', 'viewer-figure');
  var image = make('img', 'viewer-image');
  var caption = make('figcaption', 'viewer-caption');
  figure.appendChild(image);
  figure.appendChild(caption);
  var model = make('p', 'viewer-model');
  var prompt = make('p', 'viewer-prompt');
  var nav = make('div', 'viewer-nav');
  var prev = make('button', 'viewer-prev', 'Previous');
  var next = make('button', 'viewer-next', 'Next');
  var close = make('button', 'viewer-close', 'Close');
  prev.setAttribute('type', 'button');
  next.setAttribute('type', 'button');
  close.setAttribute('type', 'button');
  nav.appendChild(prev);
  nav.appendChild(next);
  nav.appendChild(close);
  dialog.appendChild(figure);
  dialog.appendChild(model);
  dialog.appendChild(prompt);
  dialog.appendChild(nav);
  document.body.appendChild(dialog);

  var current = -1;

  function setDisabled(button, disabled) {
    if (disabled) button.setAttribute('disabled', '');
    else button.removeAttribute('disabled');
  }

  function show(index) {
    if (index < 0 || index >= links.length) return;
    var link = links[index];
    var promptText = link.getAttribute('data-prompt') || '';
    current = index;
    image.setAttribute('src', link.getAttribute('href') || '');
    image.setAttribute('alt', promptText);
    caption.textContent = link.getAttribute('data-caption') || '';
    model.textContent = 'Model: ' + (link.getAttribute('data-model') || '');
    prompt.textContent = promptText;
    setDisabled(prev, index === 0);
    setDisabled(next, index === links.length - 1);
    if (!dialog.open) dialog.showModal();
  }

  links.forEach(function (link, index) {
    link.addEventListener('click', function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      show(index);
    });
  });

  prev.addEventListener('click', function () { show(current - 1); });
  next.addEventListener('click', function () { show(current + 1); });
  close.addEventListener('click', function () { dialog.close(); });
  function onBackdrop(event) {
    if (event.target !== dialog) return false;
    var r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }
  // Only a press and release both on the backdrop closes, so selecting prompt text and letting go outside keeps the viewer open.
  var pressedBackdrop = false;
  dialog.addEventListener('mousedown', function (event) { pressedBackdrop = onBackdrop(event); });
  dialog.addEventListener('click', function (event) {
    if (pressedBackdrop && onBackdrop(event)) dialog.close();
    pressedBackdrop = false;
  });
  document.addEventListener('keydown', function (event) {
    if (!dialog.open) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      show(current - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      show(current + 1);
    }
  });
})();
`;

function pageHead(title: string, extra: string[] = []): string[] {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    ...extra,
    '<link rel="stylesheet" href="/gallery/gallery.css">',
    '</head>',
    '<body>',
  ];
}

function formatDate(endedAt: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone }).format(new Date(endedAt));
}

function pictureHref(slug: string, picture: GalleryPicture): string {
  return `/gallery/${slug}/p/${picture.file}`;
}

function pictureLink(slug: string, picture: GalleryPicture, caption: string): string {
  const href = escapeHtml(pictureHref(slug, picture));
  const prompt = escapeHtml(picture.prompt);
  return `<a class="gallery-link" href="${href}" data-caption="${escapeHtml(caption)}" data-model="${escapeHtml(picture.model)}" data-prompt="${prompt}">`
    + `<img src="${href}" alt="${prompt}" width="${Math.trunc(picture.width)}" height="${Math.trunc(picture.height)}" loading="lazy" decoding="async"></a>`;
}

function pictureFigure(slug: string, picture: GalleryPicture): string {
  const caption = [`<span class="picture-label">${escapeHtml(picture.label)}</span>`];
  if (picture.line) caption.push(`<span class="picture-line">\u201c${escapeHtml(picture.line)}\u201d</span>`);
  if (picture.tag) caption.push(`<span class="picture-tag">${escapeHtml(picture.tag)}</span>`);
  return '<figure class="picture">'
    + pictureLink(slug, picture, captionText(picture))
    + `<figcaption>${caption.join(' ')}</figcaption>`
    + '<details class="picture-drawn"><summary>How this was drawn</summary>'
    + `<p class="picture-model">Model: ${escapeHtml(picture.model)}</p>`
    + `<p class="picture-prompt">${escapeHtml(picture.prompt)}</p></details></figure>`;
}

export function galleryPage(view: GalleryView, options: { origin: string; slug: string; timeZone?: string }): string {
  const origin = options.origin.replace(/\/+$/, '');
  const slug = options.slug;
  const title = `${view.title} \u00b7 Gallery`;
  const meta = [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${escapeHtml(`${origin}/gallery/${slug}/`)}">`,
  ];
  if (view.cover) meta.push(`<meta property="og:image" content="${escapeHtml(`${origin}${pictureHref(slug, view.cover)}`)}">`);
  meta.push('<script src="/gallery/viewer.js" defer></script>');

  const count = galleryPictures(view).length;
  const out = pageHead(title, meta);
  out.push('<main class="gallery">');
  out.push('<header class="gallery-head">');
  out.push(`<h1>${escapeHtml(view.title)}</h1>`);
  if (view.endedAt) {
    out.push(`<p class="gallery-date">Show of <time datetime="${escapeHtml(view.endedAt)}">${escapeHtml(formatDate(view.endedAt, options.timeZone))}</time></p>`);
  }
  out.push(`<p class="gallery-count">${picturesText(count)}</p>`);
  out.push('</header>');

  if (view.cast.length > 0) {
    out.push('<section class="gallery-cast"><h2>Cast</h2><ul class="cast-list">');
    for (const member of view.cast) {
      const face = member.portrait
        ? pictureLink(slug, member.portrait, member.name)
        : `<span class="cast-initials" aria-hidden="true">${escapeHtml(member.initials)}</span>`;
      out.push(`<li class="cast-member">${face}<span class="cast-name">${escapeHtml(member.name)}</span></li>`);
    }
    out.push('</ul></section>');
  }

  for (const scene of view.scenes) {
    if (scene.pictures.length === 0) continue;
    const heading = scene.title ? `Scene ${scene.number} \u00b7 ${scene.title}` : `Scene ${scene.number}`;
    out.push(`<section class="gallery-scene"><h2>${escapeHtml(heading)}</h2><div class="picture-grid">${scene.pictures.map(p => pictureFigure(slug, p)).join('')}</div></section>`);
  }

  const groups = view.morePortraits.filter(group => group.pictures.length > 0);
  if (groups.length > 0) {
    out.push('<section class="gallery-more"><h2>More portraits</h2>');
    for (const group of groups) {
      out.push(`<div class="portrait-group"><h3>${escapeHtml(group.name)}</h3><div class="picture-grid">${group.pictures.map(p => pictureFigure(slug, p)).join('')}</div></div>`);
    }
    out.push('</section>');
  }

  if (count === 0) out.push('<p class="gallery-empty">No pictures were drawn in this show.</p>');

  out.push('<footer class="gallery-foot"><p>Pictures drawn with Sogni. The model is named under each picture.</p><p><a href="/gallery/">All galleries</a></p></footer>');
  out.push('</main>', '</body>', '</html>', '');
  return out.join('\n');
}

export function galleryListPage(entries: GalleryListEntry[], options: { origin: string; timeZone?: string }): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.endedAt !== b.endedAt) {
      if (a.endedAt === null) return 1;
      if (b.endedAt === null) return -1;
      const diff = new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime();
      if (diff !== 0) return diff;
    }
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  const out = pageHead('Story Table galleries');
  out.push('<main class="gallery">', '<h1>Story Table galleries</h1>');
  if (sorted.length === 0) {
    out.push('<p class="gallery-empty">No galleries yet.</p>');
  } else {
    out.push('<ul class="gallery-list">');
    for (const entry of sorted) {
      const cover = entry.cover
        ? `<img class="gallery-card-cover" src="${escapeHtml(pictureHref(entry.slug, entry.cover))}" alt="${escapeHtml(entry.cover.prompt)}" width="${Math.trunc(entry.cover.width)}" height="${Math.trunc(entry.cover.height)}" loading="lazy" decoding="async">`
        : '';
      const date = entry.endedAt
        ? `<time class="gallery-card-date" datetime="${escapeHtml(entry.endedAt)}">${escapeHtml(formatDate(entry.endedAt, options.timeZone))}</time>`
        : '';
      out.push(`<li class="gallery-card"><a href="/gallery/${escapeHtml(entry.slug)}/">${cover}<span class="gallery-card-title">${escapeHtml(entry.title)}</span>${date}<span class="gallery-card-count">${picturesText(entry.pictures)}</span></a></li>`);
    }
    out.push('</ul>');
  }
  out.push('</main>', '</body>', '</html>', '');
  return out.join('\n');
}
