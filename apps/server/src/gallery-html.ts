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
    '<link rel="stylesheet" href="/fonts/fonts.css">',
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
  --void: #080810;
  --night: #181838;
  --night-raised: #282858;
  --bone: #f8f0d8;
  --dust: #a8a8c8;
  --candle: #f8c838;
  --candle-deep: #a87818;
  --on-candle: #080810;
  --heart: #e84058;
  --herb: #b0f888;
  --mana: #50a8f8;
  --font-body: 'Jersey 20', 'Arial Narrow', system-ui, sans-serif;
  --font-label: Silkscreen, 'Courier New', ui-monospace, monospace;
  --font-display: 'Jacquard 24', Georgia, serif;
  --frame-window: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--bone), inset 0 0 0 6px var(--void);
  --frame-hot: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void);
  --frame-slot: inset 0 0 0 2px var(--void);
  --frame-chip: inset 0 0 0 2px var(--void), inset 0 -4px 0 0 var(--candle-deep);
  --cut-1: polygon(0 4px, 4px 4px, 4px 0, calc(100% - 4px) 0, calc(100% - 4px) 4px, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 4px calc(100% - 4px), 0 calc(100% - 4px));
}
* { box-sizing: border-box; }
html { background: var(--void); }
body { margin: 0; min-width: 320px; color: var(--bone); font-family: var(--font-body); font-size: 20px; font-weight: 400; font-style: normal; font-synthesis: none; letter-spacing: 0; line-height: 24px; }
a { color: var(--candle); text-underline-offset: 4px; }
a:hover { color: var(--bone); }
:focus-visible { outline: 2px solid var(--candle); outline-offset: 2px; }
h1, h2, h3, p { margin-top: 0; font-weight: 400; letter-spacing: 0; }
h1 { font-family: var(--font-display); font-size: 48px; line-height: 56px; margin-bottom: 8px; color: var(--bone); text-shadow: 2px 2px 0 var(--void); overflow-wrap: anywhere; }
h2 { font-family: var(--font-body); font-size: 40px; line-height: 48px; margin-bottom: 16px; color: var(--bone); overflow-wrap: anywhere; }
h3 { font-family: var(--font-label); font-size: 16px; line-height: 24px; margin-bottom: 12px; color: var(--candle); overflow-wrap: anywhere; }
img { display: block; max-width: 100%; }

.gallery { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
.gallery-head { margin-bottom: 32px; padding-bottom: 16px; border-bottom: 2px solid var(--night-raised); }
.gallery-date, .gallery-count { margin-bottom: 4px; color: var(--dust); font-size: 20px; line-height: 24px; }
.gallery-count { color: var(--candle); font-family: var(--font-label); font-size: 16px; line-height: 20px; }
.gallery-cast, .gallery-scene, .gallery-more { margin-bottom: 40px; }
.gallery-empty { color: var(--dust); font-size: 20px; line-height: 24px; padding: 32px 0; }

.cast-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 16px; }
.cast-member { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 96px; text-align: center; }
.cast-member .gallery-link { position: relative; display: block; width: 80px; height: 80px; overflow: hidden; background: var(--night-raised); }
.cast-member .gallery-link::after, .picture .gallery-link::after { content: ''; position: absolute; inset: 0; pointer-events: none; box-shadow: var(--frame-slot); }
.cast-member .gallery-link img { width: 100%; height: 100%; object-fit: cover; }
.cast-initials { display: grid; place-items: center; width: 80px; height: 80px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); color: var(--candle); font-family: var(--font-display); font-size: 48px; line-height: 48px; }
.cast-name { font-size: 20px; line-height: 24px; color: var(--candle); overflow-wrap: anywhere; }

.picture-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 16px; align-items: start; }
.portrait-group { margin-bottom: 24px; }
.picture { position: relative; margin: 0; padding: 8px; min-width: 0; }
.picture::before, .gallery-card a::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.picture .gallery-link { position: relative; display: block; background: var(--void); }
.picture img { width: 100%; height: auto; }
.picture figcaption { padding: 8px 8px 4px; font-size: 20px; line-height: 24px; overflow-wrap: anywhere; }
.picture-label { color: var(--candle); }
.picture-line { color: var(--bone); }
.picture-tag { display: inline-block; margin-top: 4px; padding: 4px 8px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); color: var(--bone); font-family: var(--font-label); font-size: 16px; line-height: 20px; overflow-wrap: anywhere; }
.picture-drawn { padding: 0 8px 8px; font-size: 20px; line-height: 24px; color: var(--dust); }
.picture-drawn summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; padding: 4px 0; color: var(--candle); }
.picture-drawn summary::-webkit-details-marker { display: none; }
.picture-drawn summary::before { content: ''; flex: none; width: 16px; height: 8px; background: var(--candle); clip-path: polygon(0 0, 16px 0, 16px 2px, 14px 2px, 14px 4px, 12px 4px, 12px 6px, 10px 6px, 10px 8px, 6px 8px, 6px 6px, 4px 6px, 4px 4px, 2px 4px, 2px 2px, 0 2px); }
.picture-drawn[open] summary::before { transform: rotate(180deg); }
.picture-drawn p { margin: 8px 0 0; line-height: 24px; overflow-wrap: anywhere; }
.picture-model { color: var(--dust); }

.gallery-foot { margin-top: 48px; padding-top: 16px; border-top: 2px solid var(--night-raised); color: var(--dust); font-size: 20px; line-height: 24px; }
.gallery-foot p { margin-bottom: 8px; }

.gallery-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 16px; }
.gallery-card { margin: 0; }
.gallery-card a { position: relative; display: flex; flex-direction: column; gap: 4px; height: 100%; padding: 8px 8px 16px; color: var(--bone); text-decoration: none; }
.gallery-card a:hover::before { box-shadow: var(--frame-hot); }
.gallery-card-cover { width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; background: var(--void); box-shadow: 0 0 0 2px var(--void); margin-bottom: 8px; }
.gallery-card-title { padding: 0 8px; font-family: var(--font-display); font-size: 24px; line-height: 28px; overflow-wrap: anywhere; }
.gallery-card-date, .gallery-card-count { padding: 0 8px; color: var(--dust); font-size: 20px; line-height: 24px; }
.gallery-card-count { color: var(--candle); font-family: var(--font-label); font-size: 16px; line-height: 20px; }

.gallery-missing { text-align: center; padding-top: 18vh; }
.gallery-missing h1 { font-family: var(--font-body); font-size: 40px; line-height: 48px; text-shadow: none; }
.gallery-missing p { color: var(--dust); }

.gallery-viewer { width: min(96vw, 1100px); max-width: 96vw; max-height: 96vh; padding: 16px; background: var(--void); color: var(--bone); border: 0; overflow: auto; }
.gallery-viewer::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night); box-shadow: var(--frame-window); clip-path: var(--cut-1); }
.gallery-viewer::backdrop { background: var(--void); }
.viewer-figure { margin: 0 0 12px; }
.viewer-image { width: auto; max-width: 100%; max-height: max(120px, min(66vh, calc(100vh - 400px))); height: auto; margin: 0 auto; background: var(--void); box-shadow: 0 0 0 2px var(--void); }
.viewer-caption { margin-top: 12px; font-size: 20px; line-height: 24px; overflow-wrap: anywhere; }
.viewer-model { margin-bottom: 4px; color: var(--dust); font-family: var(--font-label); font-size: 16px; line-height: 20px; overflow-wrap: anywhere; }
.viewer-prompt { margin-bottom: 16px; color: var(--dust); font-size: 20px; line-height: 24px; overflow-wrap: anywhere; max-height: 120px; overflow: auto; }
.viewer-nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.viewer-nav button { position: relative; isolation: isolate; min-height: 48px; min-width: 88px; padding: 12px 16px; font-family: var(--font-body); font-size: 20px; font-weight: 400; line-height: 24px; letter-spacing: 0; border: 0; background: transparent; color: var(--bone); cursor: pointer; }
.viewer-nav button::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); }
.viewer-nav button:hover:not(:disabled) { color: var(--candle); }
.viewer-nav button:hover:not(:disabled)::before { box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle); }
.viewer-nav button:disabled { color: var(--dust); cursor: not-allowed; }
.viewer-nav .viewer-close { color: var(--on-candle); }
.viewer-nav .viewer-close::before { background: var(--candle); box-shadow: var(--frame-chip); }
.viewer-nav .viewer-close:hover:not(:disabled) { color: var(--on-candle); }
.viewer-nav .viewer-close:hover:not(:disabled)::before { background: var(--bone); box-shadow: var(--frame-chip); }

@media (max-width: 420px) {
  .gallery { padding: 16px 12px 40px; }
  h1 { font-size: 24px; line-height: 28px; }
  .picture-grid, .gallery-list { grid-template-columns: 1fr; }
  .cast-list { gap: 12px; }
  .gallery-viewer { padding: 12px; }
  .viewer-nav button { flex: 1 1 0; min-width: 0; padding-inline: 8px; }
}
`;

// Raise this when a change to the page markup, GALLERY_CSS or GALLERY_SCRIPT would leave pages already written looking wrong; the next start rewrites every gallery.
export const GALLERY_PAGE_VERSION = 2;

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
    '<link rel="stylesheet" href="/fonts/fonts.css">',
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
