// Colour themes: the GitHub VS Code themes (Light Default, Dark Default, Dark Dimmed), expressed
// as one palette each. A palette feeds both the workbench (CSS custom properties `--vsc-*`, see
// style.css) and Monaco's theme, so the chrome and the editor can never drift apart.

export interface Palette {
  id: string
  label: string
  dark: boolean
  // surfaces
  bg: string // editor, panel, active tab
  bgAlt: string // sidebar, inactive tabs, title bar
  bgInset: string // inputs, quiet wells
  border: string
  // text
  fg: string
  fgMuted: string
  fgSubtle: string
  // accents
  accent: string // focus ring, links, badges
  accentFg: string
  tabTop: string // active tab's top border + activity bar marker
  button: string
  buttonHover: string
  // interaction
  hover: string
  select: string // list selection (focused)
  selectInactive: string
  // editor
  selection: string
  lineHighlight: string
  lineNumber: string
  cursor: string
  // semantic
  error: string
  warning: string
  success: string
  // syntax
  syn: {
    comment: string
    keyword: string
    string: string
    number: string
    func: string
    variable: string
    type: string
    tag: string
    attr: string
    constant: string
  }
}

const darkDefault: Palette = {
  id: 'github-dark',
  label: 'GitHub Dark Default',
  dark: true,
  bg: '#0d1117',
  bgAlt: '#010409',
  bgInset: '#0d1117',
  border: '#30363d',
  fg: '#e6edf3',
  fgMuted: '#8b949e',
  fgSubtle: '#6e7681',
  accent: '#1f6feb',
  accentFg: '#58a6ff',
  tabTop: '#f78166',
  button: '#238636',
  buttonHover: '#2ea043',
  hover: 'rgba(110,118,129,0.1)',
  select: 'rgba(110,118,129,0.4)',
  selectInactive: 'rgba(110,118,129,0.25)',
  selection: '#3392ff44',
  lineHighlight: 'rgba(110,118,129,0.1)',
  lineNumber: '#6e7681',
  cursor: '#2f81f7',
  error: '#f85149',
  warning: '#d29922',
  success: '#3fb950',
  syn: { comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', func: '#d2a8ff', variable: '#ffa657', type: '#ffa657', tag: '#7ee787', attr: '#79c0ff', constant: '#79c0ff' },
}

const darkDimmed: Palette = {
  id: 'github-dark-dimmed',
  label: 'GitHub Dark Dimmed',
  dark: true,
  bg: '#22272e',
  bgAlt: '#1c2128',
  bgInset: '#22272e',
  border: '#444c56',
  fg: '#adbac7',
  fgMuted: '#768390',
  fgSubtle: '#636e7b',
  accent: '#316dca',
  accentFg: '#539bf5',
  tabTop: '#ec775c',
  button: '#347d39',
  buttonHover: '#46954a',
  hover: 'rgba(99,110,123,0.1)',
  select: 'rgba(99,110,123,0.4)',
  selectInactive: 'rgba(99,110,123,0.25)',
  selection: '#4c8dff44',
  lineHighlight: 'rgba(99,110,123,0.1)',
  lineNumber: '#636e7b',
  cursor: '#539bf5',
  error: '#e5534b',
  warning: '#c69026',
  success: '#57ab5a',
  syn: { comment: '#768390', keyword: '#f47067', string: '#96d0ff', number: '#6cb6ff', func: '#dcbdfb', variable: '#f69d50', type: '#f69d50', tag: '#8ddb8c', attr: '#6cb6ff', constant: '#6cb6ff' },
}

const lightDefault: Palette = {
  id: 'github-light',
  label: 'GitHub Light Default',
  dark: false,
  bg: '#ffffff',
  bgAlt: '#f6f8fa',
  bgInset: '#ffffff',
  border: '#d0d7de',
  fg: '#1f2328',
  fgMuted: '#57606a',
  fgSubtle: '#8c959f',
  accent: '#0969da',
  accentFg: '#0969da',
  tabTop: '#fd8c73',
  button: '#1f883d',
  buttonHover: '#1a7f37',
  hover: 'rgba(129,139,152,0.12)',
  select: 'rgba(129,139,152,0.25)',
  selectInactive: 'rgba(129,139,152,0.15)',
  selection: '#0969da33',
  lineHighlight: 'rgba(234,238,242,0.5)',
  lineNumber: '#8c959f',
  cursor: '#0969da',
  error: '#cf222e',
  warning: '#9a6700',
  success: '#1a7f37',
  syn: { comment: '#57606a', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', func: '#8250df', variable: '#953800', type: '#953800', tag: '#116329', attr: '#0550ae', constant: '#0550ae' },
}

export const THEMES: Palette[] = [lightDefault, darkDefault, darkDimmed]

/** "auto" follows Pear's appearance: Light Default in light mode, Dark Default in dark mode. */
export const AUTO = 'auto'

let choice = AUTO
let current: Palette = darkDefault

export const themeChoice = (): string => choice
export const currentPalette = (): Palette => current

export function resolveTheme(id: string, hostDark: boolean): Palette {
  return THEMES.find((t) => t.id === id) ?? (hostDark ? darkDefault : lightDefault)
}

const VARS: Array<[string, (p: Palette) => string]> = [
  ['--vsc-bg', (p) => p.bg],
  ['--vsc-bg-alt', (p) => p.bgAlt],
  ['--vsc-bg-inset', (p) => p.bgInset],
  ['--vsc-border', (p) => p.border],
  ['--vsc-fg', (p) => p.fg],
  ['--vsc-fg-muted', (p) => p.fgMuted],
  ['--vsc-fg-subtle', (p) => p.fgSubtle],
  ['--vsc-accent', (p) => p.accent],
  ['--vsc-accent-fg', (p) => p.accentFg],
  ['--vsc-tab-top', (p) => p.tabTop],
  ['--vsc-button', (p) => p.button],
  ['--vsc-button-hover', (p) => p.buttonHover],
  ['--vsc-hover', (p) => p.hover],
  ['--vsc-select', (p) => p.select],
  ['--vsc-select-inactive', (p) => p.selectInactive],
  ['--vsc-error', (p) => p.error],
  ['--vsc-warning', (p) => p.warning],
  ['--vsc-success', (p) => p.success],
  ['--vsc-folder', (p) => (p.dark ? '#7d8590' : '#54aeff')],
]

/** Make `id` (or "auto") the active theme: sets the workbench variables and returns the palette. */
export function applyTheme(id: string, hostDark: boolean): Palette {
  choice = id
  current = resolveTheme(id, hostDark)
  const root = document.documentElement
  for (const [name, get] of VARS) root.style.setProperty(name, get(current))
  root.style.colorScheme = current.dark ? 'dark' : 'light'
  root.dataset.vsc = current.id
  return current
}
