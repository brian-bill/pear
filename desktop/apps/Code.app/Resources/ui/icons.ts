// Icons for the workbench, drawn after VS Code's codicons (16×16, one colour, `currentColor`) and
// a small set of file-type icons in the style of the GitHub/Material icon themes. Plain SVG strings:
// nothing to download and no licence to track.

const S = 'fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"'
const F = 'fill="currentColor"'

const CODICONS = {
  files: `<g ${S}><path d="M5.5 1.5h5l3 3v7h-8z"/><path d="M10.5 1.5v3h3"/><path d="M3.5 4.5v10h7"/></g>`,
  extensions: `<g ${S}><rect x="2.5" y="6.5" width="4" height="4"/><rect x="6.5" y="6.5" width="4" height="4"/><rect x="2.5" y="10.5" width="4" height="4"/><rect x="6.5" y="10.5" width="4" height="4"/><path d="M11.2 1.8l2.7 2.7-2.7 2.7-2.7-2.7z"/></g>`,
  'chevron-right': `<path ${S} d="M6 3.5l4.5 4.5L6 12.5"/>`,
  'chevron-left': `<path ${S} d="M10 3.5L5.5 8l4.5 4.5"/>`,
  'chevron-down': `<path ${S} d="M3.5 6L8 10.5 12.5 6"/>`,
  close: `<path ${S} d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>`,
  add: `<path ${S} d="M8 2.5v11M2.5 8h11"/>`,
  'new-file': `<g ${S}><path d="M9.5 14.5h-6v-13h6l3 3v3"/><path d="M9.5 1.5v3h3"/><path d="M12 10.5v4M10 12.5h4"/></g>`,
  'new-folder': `<g ${S}><path d="M7 12.5H2.5v-9h3.7l1.3 1.5h5.5v2.5"/><path d="M12 9.5v4M10 11.5h4"/></g>`,
  refresh: `<g ${S}><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></g>`,
  'expand-all': `<g ${S}><rect x="3.5" y="4.5" width="9" height="9"/><path d="M5.5 2.5h7a1 1 0 0 1 1 1v7M8 7v4M6 9h4"/></g>`,
  'collapse-all': `<g ${S}><rect x="3.5" y="4.5" width="9" height="9"/><path d="M5.5 2.5h7a1 1 0 0 1 1 1v7"/><path d="M5.5 9h5"/></g>`,
  ellipsis: `<g ${F}><circle cx="3" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="13" cy="8" r="1.1"/></g>`,
  play: `<path ${F} d="M4 2.4v11.2a.4.4 0 0 0 .6.35l9-5.6a.4.4 0 0 0 0-.7l-9-5.6a.4.4 0 0 0-.6.35z"/>`,
  package: `<g ${S}><path d="M8 1.5l6 3v7l-6 3-6-3v-7z"/><path d="M2 4.5l6 3 6-3M8 7.5v7"/></g>`,
  save: `<g ${S}><path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v3.5h5.5V2.5"/><rect x="4.5" y="9" width="7" height="4.5"/></g>`,
  'folder-opened': `<g ${S}><path d="M2.5 13.5v-10h3.7l1.3 1.5h5v2"/><path d="M2.5 13.5l2-6h10l-2 6z"/></g>`,
  search: `<g ${S}><circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l4 4"/></g>`,
  settings: `<g ${S}><path d="M2 4.5h6M11.5 4.5H14M2 8h2.5M8 8h6M2 11.5h7M12.5 11.5H14"/><circle cx="9.7" cy="4.5" r="1.7"/><circle cx="6.2" cy="8" r="1.7"/><circle cx="11" cy="11.5" r="1.5"/></g>`,
  'clear-all': `<g ${S}><path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h5"/><path d="M11 10.5l3 3M14 10.5l-3 3"/></g>`,
  output: `<g ${S}><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6l2.2 2L4 10M8 10.5h4"/></g>`,
  eye: `<g ${S}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></g>`,
  'split-horizontal': `<g ${S}><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11"/></g>`,
  check: `<path ${S} d="M3 8.5l3.2 3.2L13 4.8"/>`,
  error: `<g ${S}><circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></g>`,
  bell: `<g ${S}><path d="M3.5 11.5h9l-1.2-1.6V6.3a3.3 3.3 0 0 0-6.6 0v3.6z"/><path d="M6.7 13.3a1.4 1.4 0 0 0 2.6 0"/></g>`,
  'terminal-cmd': `<path ${S} d="M3 4.5l4 3.5-4 3.5M8.5 12h4.5"/>`,
  edit: `<g ${S}><path d="M2.5 13.5l.7-3L11 2.7a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L5.5 12.8z"/><path d="M9.8 4l2.2 2.2"/></g>`,
  trash: `<g ${S}><path d="M3 4.5h10M6.5 4.5v-2h3v2M4.2 4.5l.6 9h6.4l.6-9"/><path d="M6.8 7v4M9.2 7v4"/></g>`,
  warning: `<g ${S}><path d="M8 2l6.3 11.5H1.7z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r=".6" ${F}/></g>`,
  pin: `<g ${S}><path d="M9.5 1.8l4.7 4.7-2 .6-2.4 2.4-.2 2.4-1.2 1.2-3.2-3.2L2.5 13.5M6.3 6.3l3.4-3.4"/></g>`,
  'zoom-in': `<g ${S}><circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l4 4M6.8 5v3.6M5 6.8h3.6"/></g>`,
  'zoom-out': `<g ${S}><circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l4 4M5 6.8h3.6"/></g>`,
  info: `<g ${S}><circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.7"/><circle cx="8" cy="5.2" r=".6" ${F}/></g>`,
  'git-branch': `<g ${S}><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2-7 4"/></g>`,
  layout: `<g ${S}><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M5.5 2.5v11"/></g>`,
  'layout-panel': `<g ${S}><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 9.5h13"/></g>`,
} as const

export type IconName = keyof typeof CODICONS

/** A codicon-style icon as an SVG string; it takes its colour from the surrounding text. */
export function icon(name: IconName, size = 16): string {
  return `<svg class="codicon" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${CODICONS[name]}</svg>`
}

// ---- file and folder icons

/** A small rounded badge carrying a short label, the way icon themes mark source files. */
const badge = (bg: string, text: string, fg = '#fff', size = 7): string =>
  `<svg class="fileicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="12" rx="2.2" fill="${bg}"/><text x="8" y="10.9" text-anchor="middle" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-weight="700" font-size="${size}" fill="${fg}">${text}</text></svg>`

const glyph = (bg: string, inner: string): string =>
  `<svg class="fileicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="12" rx="2.2" fill="${bg}"/>${inner}</svg>`

const PLAIN = `<svg class="fileicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.2L12.5 4.8V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5z" fill="none" stroke="var(--vsc-fg-muted)" stroke-width="1"/><path d="M9 1.8v3.2h3.2" fill="none" stroke="var(--vsc-fg-muted)" stroke-width="1"/></svg>`

const FILE_ICONS: Record<string, string> = {
  js: badge('#f1c40f', 'JS', '#1b1f23'),
  mjs: badge('#f1c40f', 'JS', '#1b1f23'),
  ts: badge('#3178c6', 'TS'),
  json: glyph('#c2a10f', `<path d="M6.4 5c-1 0-1 .8-1 1.6s-.5 1.4-1 1.4c.5 0 1 .6 1 1.4S5.4 11 6.4 11M9.6 5c1 0 1 .8 1 1.6s.5 1.4 1 1.4c-.5 0-1 .6-1 1.4S10.6 11 9.6 11" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>`),
  html: glyph('#e34c26', `<path d="M6.3 5.5L4 8l2.3 2.5M9.7 5.5L12 8l-2.3 2.5" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`),
  css: badge('#8957e5', '#', '#fff', 10),
  scss: badge('#cd6799', 'S'),
  md: glyph('#4493f8', `<path d="M4 10.4V5.6l2 2.4 2-2.4v4.8M10.6 5.6v4.2m-1.5-1.5l1.5 1.7 1.5-1.7" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`),
  svg: glyph('#e8912d', `<circle cx="8" cy="8" r="2.6" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M8 3.6v1.5M8 10.9v1.5M3.6 8h1.5M10.9 8h1.5" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>`),
  wasm: badge('#654ff0', 'WA'),
  wat: badge('#654ff0', 'WA'),
  sh: badge('#4d5a66', '$_', '#fff', 7.5),
  yml: badge('#cb171e', 'Y'),
  yaml: badge('#cb171e', 'Y'),
  png: glyph('#3fb950', `<circle cx="5.8" cy="6" r="1.1" fill="#fff"/><path d="M3.5 11.5l3-3 2 2 1.5-1.5 2.5 2.5" fill="none" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>`),
}
FILE_ICONS.tsx = FILE_ICONS.ts!
FILE_ICONS.jsx = FILE_ICONS.js!
FILE_ICONS.jpg = FILE_ICONS.png!
FILE_ICONS.gif = FILE_ICONS.png!
FILE_ICONS.webp = FILE_ICONS.png!

const folder = (open: boolean): string =>
  open
    ? `<svg class="fileicon folder" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 12.5v-8.5a1 1 0 0 1 1-1h3.2l1.3 1.5h5.5a1 1 0 0 1 1 1V6H4.2a1 1 0 0 0-.95.68z" fill="var(--vsc-folder)" opacity=".7"/><path d="M3.3 6.5h11.7a.5.5 0 0 1 .48.64l-1.5 5.5a1 1 0 0 1-.96.74H2.5z" fill="var(--vsc-folder)"/></svg>`
    : `<svg class="fileicon folder" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.2L7 4.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="var(--vsc-folder)"/></svg>`

/** The icon for a project entry. `.app` bundles get the Pear-style package icon. */
export function fileIcon(name: string, kind: 'file' | 'dir', open = false): string {
  if (kind === 'dir') return folder(open)
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return FILE_ICONS[ext] ?? PLAIN
}

/** A human-readable language name for the status bar. */
const LANG_NAMES: Record<string, string> = {
  js: 'JavaScript', mjs: 'JavaScript', jsx: 'JavaScript React', ts: 'TypeScript', tsx: 'TypeScript React', json: 'JSON',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', md: 'Markdown', svg: 'SVG', xml: 'XML', wasm: 'WebAssembly Text',
  wat: 'WebAssembly Text', sh: 'Shell Script', yml: 'YAML', yaml: 'YAML',
}
export const languageName = (path: string): string => LANG_NAMES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'Plain Text'
