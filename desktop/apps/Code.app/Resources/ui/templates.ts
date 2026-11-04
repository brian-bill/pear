// The templates a new project can be scaffolded from. A project is an ordinary `.app` bundle
// (see docs/sdk.md) living in the user's files: manifest.json, Resources/, and scripts.

export interface TemplateDef {
  id: string
  label: string
  detail: string
  /** Files by path relative to the project root. `$NAME` is replaced with the project's name. */
  files: Record<string, string>
}

const kebab = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'

const icon = (name: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="#3a6ea5"/>
  <text x="32" y="41" font-family="system-ui" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${name.slice(0, 1).toUpperCase()}</text>
</svg>
`

const INDEX = `<!doctype html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body>
  <div class="app">
    <h1>Hello, Pear</h1>
    <p id="msg" class="dim">$NAME is running.</p>
    <button id="count" class="primary">Count: 0</button>
  </div>
  <script src="main.js"></script>
</body>
</html>
`

const STYLE = `/* The preview pane and real app windows share Pear's theme variables. */
body { margin: 0; font: 13px/1.4 var(--font, system-ui); color: var(--text, #1a1a1a); }
.app { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
h1 { font-size: 22px; font-weight: 600; margin: 0; }
.dim { color: var(--text-dim, #7a7a7a); }
button { padding: 6px 16px; border-radius: 7px; border: 0.5px solid var(--separator, #ccc); background: var(--window-bg, #fff); color: inherit; font: inherit; }
button.primary { background: var(--accent, #3a6ea5); color: #fff; border-color: transparent; }
`

const MAIN = `// $NAME — edited in Code, previewed next to the editor, served like a real app window.
let n = 0
const button = document.getElementById('count')
const message = document.getElementById('msg')

button.addEventListener('click', () => {
  n++
  button.textContent = \`Count: \${n}\`
  if (n === 5) message.textContent = 'At five already. Save the file and watch the preview rebuild.'
})
`

const README = `# $NAME

An app project for Pear, edited in **Code**.

- \`manifest.json\` — identity, window hints, permissions
- \`Resources/ui/index.html\` — the page each window shows
- \`main.js\`, \`style.css\` — the script and styles that page loads

Preview with the ▶ Preview button (Cmd+R). Files in the preview run as Code,
with Code's permissions, for as long as the preview is open.
`

const README_WASM = `Build \`src/main.ts\` (**AssemblyScript**) with Code's Build button (Cmd+Shift+B)
to produce \`src/main.wasm\`, which main.js loads when it exists.
`

const AS_MAIN = `// AssemblyScript compiles to WebAssembly — a strict TypeScript variant.
// Build it in Code (Cmd+Shift+B) to produce src/main.wasm.
export function add(a: i32, b: i32): i32 {
  return a + b
}

export function fib(n: i32): i32 {
  if (n < 2) return n
  return fib(n - 1) + fib(n - 2)
}
`

const MAIN_WASM = `// $NAME — edited in Code, previewed next to the editor.
// If src/main.wasm was built with the AssemblyScript extension, the buttons below run natively.
let add = (a, b) => a + b
let fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2))

async function loadWasm() {
  try {
    const bytes = await tiny.readFile('src/main.wasm')
    const { instance } = await WebAssembly.instantiate(bytes, {})
    const wasm = /** @type {any} */ (instance.exports)
    add = wasm.add
    fib = wasm.fib
    document.getElementById('msg').textContent = 'The wasm module is loaded (built by Code).'
  } catch (e) {
    document.getElementById('msg').textContent = 'Running plain JavaScript — build src/main.ts in Code to get src/main.wasm.'
  }
}
void loadWasm()

let n = 0
const button = document.getElementById('count')
button.addEventListener('click', () => {
  n++
  button.textContent = \`fib(\${n}) = \${fib(n)} — \${add(n, n)}\`
})
`

export function manifestFor(name: string): string {
  return JSON.stringify(
    {
      id: `com.pear.${kebab(name)}`,
      name,
      version: '0.1.0',
      kind: 'app',
      icon: 'Resources/icon.svg',
      ui: 'Resources/ui/index.html',
      window: { width: 480, height: 320, minWidth: 240, minHeight: 160 },
      permissions: ['fs.user', 'network'],
    },
    null,
    2,
  ) + '\n'
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'web',
    label: 'Web App',
    detail: 'HTML, CSS and JavaScript — edit and preview right away.',
    files: {
      'manifest.json': '$MANIFEST',
      'Resources/icon.svg': '$ICON',
      'Resources/ui/index.html': INDEX,
      'Resources/ui/style.css': STYLE,
      'Resources/ui/main.js': MAIN,
      'README.md': README,
    },
  },
  {
    id: 'wasm',
    label: 'Web App + AssemblyScript',
    detail: 'The same, plus src/main.ts compiled to WebAssembly in the browser (Build button).',
    files: {
      'manifest.json': '$MANIFEST',
      'Resources/icon.svg': '$ICON',
      'Resources/ui/index.html': INDEX,
      'Resources/ui/style.css': STYLE,
      'Resources/ui/main.js': MAIN_WASM,
      'src/main.ts': AS_MAIN,
      'README.md': README + '\n' + README_WASM,
    },
  },
]

export function instantiate(template: TemplateDef, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, content] of Object.entries(template.files)) {
    out[path] = content
      .replaceAll('$MANIFEST', manifestFor(name))
      .replaceAll('$ICON', icon(name))
      .replaceAll('$NAME', name)
  }
  return out
}
