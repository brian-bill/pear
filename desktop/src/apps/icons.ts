/// App icons, drawn here as plain SVG so Desktop has no asset licences to track.
const svg = (inner: string) => `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`
const tile = (a: string, b: string, id: string) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#${id})"/>`
/// White page with a folded corner, plus a coloured badge sticker carrying the type's glyph.
const page = (id: string, a: string, b: string, glyph: string) =>
  svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
    `<path d="M14 6h26l12 12v38a2 2 0 01-2 2H14a2 2 0 01-2-2V8a2 2 0 012-2z" fill="#f4f4f6" stroke="#b8b8bd" stroke-width="2"/>` +
    `<path d="M40 6v12h12" fill="#dcdce0" stroke="#b8b8bd" stroke-width="2"/>` +
    `<rect x="13" y="34" width="33" height="20" rx="4" fill="url(#${id})"/>${glyph}`)

const W = `stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"`
const W2 = `stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"`
const WS = `stroke="#fff" stroke-width="1.6" fill="none"`

const filePage = svg(`<path d="M14 6h26l12 12v38a2 2 0 01-2 2H14a2 2 0 01-2-2V8a2 2 0 012-2z" fill="#f4f4f6" stroke="#b8b8bd" stroke-width="2"/><path d="M40 6v12h12" fill="#dcdce0" stroke="#b8b8bd" stroke-width="2"/>`)

export const ICONS: Record<string, string> = {
  terminal: svg(`${tile('#4a4a4e', '#1c1c1e', 'gt')}<path d="M16 22l12 10-12 10" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 44h14" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`),
  about: svg(`${tile('#6cb2ff', '#0a64d6', 'ga')}<circle cx="32" cy="19" r="4" fill="#fff"/><path d="M32 28v18" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`),
  files: svg(`${tile('#7fd1ff', '#2a8de0', 'gf')}<path d="M14 22a3 3 0 013-3h9l4 5h17a3 3 0 013 3v17a3 3 0 01-3 3H17a3 3 0 01-3-3z" fill="#fff"/>`),
  trash: svg(`<defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8e8ea"/><stop offset="1" stop-color="#b4b4b8"/></linearGradient></defs><path d="M16 18h32l-3 38a3 3 0 01-3 3H22a3 3 0 01-3-3z" fill="url(#gr)" stroke="#8a8a8e" stroke-width="1.5"/><rect x="12" y="12" width="40" height="6" rx="3" fill="#cfcfd3" stroke="#8a8a8e" stroke-width="1.5"/><path d="M26 24v28M32 24v28M38 24v28" stroke="#8a8a8e" stroke-width="2" stroke-linecap="round"/>`),
  folder: svg(`<defs><linearGradient id="gfo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6ec3ff"/><stop offset="1" stop-color="#2f8fe6"/></linearGradient></defs><path d="M6 18a4 4 0 014-4h12l5 6h27a4 4 0 014 4v26a4 4 0 01-4 4H10a4 4 0 01-4-4z" fill="url(#gfo)"/>`),
  file: filePage,
  trashFull: svg(`<defs><linearGradient id="gr2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8e8ea"/><stop offset="1" stop-color="#b4b4b8"/></linearGradient></defs><path d="M20 14l6-5 8 4 7-6 6 9z" fill="#fff" stroke="#9a9aa0" stroke-width="1.5"/><path d="M16 18h32l-3 38a3 3 0 01-3 3H22a3 3 0 01-3-3z" fill="url(#gr2)" stroke="#8a8a8e" stroke-width="1.5"/><path d="M26 24v28M32 24v28M38 24v28" stroke="#8a8a8e" stroke-width="2" stroke-linecap="round"/>`),
  apps: svg(`${tile('#f5f5f7', '#c9c9ce', 'gap')}${[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => `<rect x="${14 + c * 13}" y="${14 + r * 13}" width="10" height="10" rx="3" fill="${['#ff5f57', '#febc2e', '#28c840', '#0a84ff', '#bf5af2', '#ff9f0a', '#30b0c7', '#ff375f', '#5e5ce6'][r * 3 + c]}"/>`)).join('')}`),
  pear: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M32 18c-6 0-8 6-10 11-2 5-10 8-10 16 0 9 8 15 20 15s20-6 20-15c0-8-8-11-10-16-2-5-4-11-10-11z" fill="currentColor"/><path d="M32 18c0-5 2-9 5-12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><path d="M35 13c3-6 11-7 16-4-3 6-11 8-16 4z" fill="#34c759"/></svg>`,
  window: svg(`<rect x="8" y="12" width="48" height="40" rx="6" fill="currentColor" opacity="0.25"/><rect x="8" y="12" width="48" height="10" rx="5" fill="currentColor" opacity="0.5"/>`),
}

/**
 * The artwork Desktop draws for a file's type, keyed by the symbolic name launch services reports
 * (`folder`, `app` and `document` fall back to the plain icons). Anything stored anywhere renders
 * through these: Finder, the Open and Save panels, the desktop, the launcher.
 */
export const TYPE_ICONS: Record<string, string> = {
  image: page('ti-image', '#3fd0d4', '#189c9c', `<circle cx="33" cy="40" r="2.6" fill="#fff"/><path d="M18 52l8-9 5 5 4-4 6 8z" fill="#fff"/>`),
  text: page('ti-text', '#9aa4b2', '#5d6675', `<path d="M20 40h18M20 45h14M20 50h18" ${W2}/>`),
  code: page('ti-code', '#4cd48a', '#1fa45e', `<path d="M23 39l-5 5 5 5M39 39l5 5-5 5" ${W}/><path d="M32 38l-2 14" ${W2}/>`),
  json: page('ti-json', '#ffdf6f', '#d8a706', `<path d="M26 38c-3 0-2 6-6 6 4 0 3 6 6 6M38 38c3 0 2 6 6 6-4 0-3 6-6 6M29.5 44h1M34 44h1" ${W2}/>`),
  markdown: page('ti-markdown', '#b28cff', '#7a4ede', `<path d="M17 50V39l6 6 6-6v11M36 40v9M33 46l3 3 3-3" ${W2}/>`),
  html: page('ti-html', '#ff9d5c', '#e8641c', `<path d="M24 39l-6 5 6 5M40 39l6 5-6 5" ${W}/><path d="M31 38h2" ${W2}/>`),
  pdf: page('ti-pdf', '#ff7b6e', '#d92d20', `<path d="M24 39v13l5.5-4 5.5 4V39z" fill="#fff"/>`),
  audio: page('ti-audio', '#ff7aa8', '#e0338d', `<path d="M26 39v9M38 36v9" ${W2}/><path d="M26 39l12-3" stroke="#fff" stroke-width="3" fill="none"/><ellipse cx="23.5" cy="48.5" rx="3.4" ry="2.7" fill="#fff"/><ellipse cx="35.5" cy="45.5" rx="3.4" ry="2.7" fill="#fff"/>`),
  video: page('ti-video', '#5a8cff', '#2846d8', `<rect x="20" y="39" width="24" height="12" rx="2.5" ${W2}/><path d="M29 42l6 3-6 3z" fill="#fff"/><path d="M25 41.5v1.6M25 44.6v1.6M25 47.6v1.6M39 41.5v1.6M39 44.6v1.6M39 47.6v1.6" ${WS}/>`),
  archive: page('ti-archive', '#d9a066', '#9a6a3a', `<rect x="20" y="39" width="24" height="13" rx="2.5" ${W2}/><path d="M32 39.5v12" stroke="#fff" stroke-width="2" stroke-dasharray="2 2" fill="none"/><path d="M28 46h8" ${W2}/>`),
  alias: page('ti-alias', '#b6bcc6', '#7f8794', `<path d="M22 51v-5c0-4 2-6 7-6h3" ${W2}/><path d="M30 34l9 6-9 6z" fill="#fff"/>`),
  // `document` and anything the type hierarchy does not name specially: the plain page
  document: filePage,
}
