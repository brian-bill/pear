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

const MAIN_APP = `// $NAME — edited in Code, previewed next to the editor.
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

const CONSOLE_MAIN = `// $NAME — a console app. Each command runs this file with tiny.args = [command, ...arguments].
export default async (tiny) => {
  const [, ...args] = tiny.args
  const who = args.length ? args.join(' ') : 'world'
  tiny.stdout.write(\`Hello, \${who}!\\n\`)
  return 0
}
`

const CONSOLE_README = `# $NAME

A console app for Pear, edited in **Code**: a bundle whose program runs in Terminal.

- \`manifest.json\` — identity, permissions and the \`commands\` it declares
- \`main.js\` — the program (\`export default async (tiny) => exitCode\`), a plain JavaScript ES module

Read arguments from \`tiny.args\`, write to \`tiny.stdout\` / \`tiny.stderr\`, and return the exit code.
Use **Run in Terminal** in Code to run \`main.js\` by its full path.

## Networking

Add \`"network"\` to \`permissions\`, then use \`net\` (also \`tiny.net\`), the same object windows get:

\`\`\`js
const res = await net.fetch('https://example.com')
await tiny.stdout.write(await res.text())
\`\`\`

\`net.fetch\` resolves to a standard \`Response\`; HTTP error statuses are responses, not exceptions. \`net.status()\`, \`net.download()\` and \`net.upload()\` are there too.

Only \`http(s)\` and \`ws(s)\` URLs work. There is no raw TCP/UDP, and CORS applies (set \`proxy\` on \`fetch\` to use the proxy).

## Running all the time

Change the manifest to \`"kind": "service"\` with \`"autostart": true\`. The service starts at every normal boot (not in safe mode),
registers a named port with \`tiny.register('com.example.name', port)\`, and answers requests with the \`serve()\` pattern.
Command-line tools reach it with \`tiny.lookup('com.example.name')\` and \`tiny.request\`.
`

export function manifestFor(name: string, templateId = 'web'): string {
  if (templateId === 'console') {
    const command = kebab(name)
    return JSON.stringify(
      {
        id: `com.pear.${command}`,
        name,
        version: '0.1.0',
        kind: 'tool',
        entry: 'main.js',
        permissions: [],
        commands: [{ name: command, summary: `Run ${name}` }],
      },
      null,
      2,
    ) + '\n'
  }
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
    id: 'console',
    label: 'Console App',
    detail: 'A command-line program whose command shows up in the shell.',
    files: {
      'manifest.json': '$MANIFEST',
      'main.js': CONSOLE_MAIN,
      'README.md': CONSOLE_README,
    },
  },
  {
    id: 'web',
    label: 'Web App',
    detail: 'HTML, CSS and JavaScript with a live preview. src/main.ts (AssemblyScript) builds to WebAssembly.',
    files: {
      'manifest.json': '$MANIFEST',
      'Resources/icon.svg': '$ICON',
      'Resources/ui/index.html': INDEX,
      'Resources/ui/style.css': STYLE,
      'Resources/ui/main.js': MAIN_APP,
      'src/main.ts': AS_MAIN,
      'README.md': README + '\n' + README_WASM,
    },
  },
]

export function instantiate(template: TemplateDef, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, content] of Object.entries(template.files)) {
    out[path] = content
      .replaceAll('$MANIFEST', manifestFor(name, template.id))
      .replaceAll('$ICON', icon(name))
      .replaceAll('$NAME', name)
  }
  return out
}
