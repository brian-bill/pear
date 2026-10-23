# Desktop SDK

How to write an app for Pear. The apps that ship with Pear (Finder, Terminal, Text Editor, Settings...) are built exactly this way.

## What an app is

An app is a Vanilla **bundle** (`Name.app/`, see `contracts/app-bundles.md`) with a window UI:

```
Notes.app/
├── manifest.json           identity, permissions, document types, window hints, "ui"
├── Resources/
│   ├── icon.svg            shown in the Dock, Finder, launcher
│   └── ui/
│       ├── index.html      the page shown in each window
│       ├── main.ts         compiled to main.js; <script src="main.js"> in index.html
│       └── style.css       <link rel="stylesheet" href="style.css">
└── main.ts (optional)      a custom process; normally omitted (the SDK's standard host is used)
```

Apps that ship with Pear live in `desktop/apps/<Name>.app/`. At first boot (and when the build changes) Desktop installs them into `/Applications` with their permissions granted. `.ts` files are compiled by `vite.config.ts` (the `tiny-apps` plugin); `@tiny/sdk` resolves to `sdk/client.ts` and is bundled into each app.

### How it runs (so you know what you can and cannot do)

* The **process** is the standard host (`sdk/host.ts`): an ordinary Vanilla app process, confined by Vanilla to the app's container and the permissions in the manifest.
* Each **window** is a sandboxed iframe (opaque origin, no network, CSP: inline scripts and styles, `data:`/`blob:` images only). It cannot touch Vanilla or the page.
* Every `tiny.readFile(...)`, `tiny.configGet(...)`, `tiny.service(...)` from a window travels window -> Desktop -> the app's process and runs **as the app**. Vanilla's permissions apply exactly: an app with only `fs.container` gets `EACCES` outside its container. Files the user picks with the Open/Save panel are the exception: Desktop grants the app those paths.
* One process per app; many windows. When the last window closes the process ends. Per-window state lives in the window; share state through files or settings.

### manifest.json

```json
{
  "id": "org.tiny.textedit",
  "name": "TextEdit",
  "version": "1.0.0",
  "kind": "app",
  "icon": "Resources/icon.svg",
  "ui": "Resources/ui/index.html",
  "window": { "width": 640, "height": 480, "minWidth": 320, "minHeight": 200, "resizable": true },
  "permissions": ["fs.user", "clipboard", "notifications"],
  "documentTypes": [{ "ext": ["txt", "md"], "role": "editor", "uti": "public.plain-text", "icon": "Resources/doc.svg" }],
  "urlSchemes": []
}
```

`permissions`: `fs.container` (default sandbox), `fs.user` (the user's files), `fs.picker`, `fs.all`, `clipboard`, `notifications`, `network`, `process.spawn`, `audio.input`, `video.input`, `location`, `display.capture`. Ask for the least you need.

## The `tiny` object

```ts
import { tiny } from '@tiny/sdk'
await tiny.ready            // resolves when Desktop has sent the window its identity and theme
```

### Files, settings, permissions, launching: `tiny.<call>`

Everything a Vanilla process can do (`contracts/filesystem.md`, `configuration.md`, `launch-services.md`), returning promises: `readFile writeFile writeFileAtomic readdir stat lstat exists mkdir rmdir unlink removeAll rename copy trash restore emptyTrash symlink readlink realpath chmod chown utimes statfs getxattr setxattr listxattr removexattr open close read write lseek truncate flock configGet configSet configList configWatch permCheck permRequest launchOpen launchApps launchAppsFor launchDefaultFor launchTypeOf launchIconFor launchRecents bundleList bundleInfo spawn pipe openpty ...` (see `vanilla/kernel/src/runtime.ts`, minus process control and ports). Errors carry a Vanilla errno in `code` (`ENOENT`, `EACCES`, `EEXIST`...). Binary data is `Uint8Array`.

`tiny.readFile('/Users/pear/Documents/a.txt')`, `tiny.trash(path)`, `tiny.stat(path)` (`kind` is `file | dir | symlink`, times in ms), `tiny.readdir(dir)` (`[{name, kind, ino}]`).

### Services: `tiny.service(name, msg)`

Request/reply to a system service as this app: `tiny.service('tiny.search', {op: 'query', q: 'report'})`, `tiny.service('tiny.clipboard', ...)`, `tiny.service('tiny.notifications', {op: 'post', title, body})`, `tiny.service('tiny.settings', ...)`, `tiny.service('tiny.network', {op: 'fetch', url})`, `tiny.service('tiny.audio', ...)`. The request set of each service is in `contracts/*.md` ("Implementation status"). `tiny.system.info('snapshot')` is shorthand for `tiny.system` reads.

### Windows: `tiny.window`

`setTitle(t)`, `setMenus(menus)`, `close()`, `minimize()`, `toggleMaximize()`, `focus()`, `resize(w, h)`, `setEdited(bool)` (dot in the close button), `onCloseRequest(fn)` (return `false` to keep the window open; ask the user first), `list()`.

**Menus.** The first menu is the app menu (Desktop appends Close Window and Quit). Items run their `action` when chosen *or* when the shortcut is pressed in the window (`'Cmd+S'`, `'Cmd+Shift+Z'`):

```ts
tiny.window.setMenus([
  { title: 'Notes', items: [{ label: 'About Notes', action: about }] },
  { title: 'File', items: [{ label: 'New', shortcut: 'Cmd+N', action: newDoc }, { separator: true }, { label: 'Save', shortcut: 'Cmd+S', action: save, disabled: !dirty }] },
])
```
Call `setMenus` again whenever enabled state changes. Cmd+W, Cmd+M, Cmd+`, Cmd+Q and Alt+Tab belong to Desktop. Ctrl is yours.

### The app: `tiny.app`

`id`, `name`, `args` (files/URLs it was launched with), `state` (what this window saved), `onOpenFile(fn)` (a file was opened with the app while it runs), `onOpenURL`, `onSaveState(fn)` (return JSON-safe state; it is kept for the next session), `openWindow(state?)`, `quit()`.

Document apps: handle both `tiny.app.args` at startup and `onOpenFile` later; a second document opens in a new window with `tiny.app.openWindow({path})`.

### Dialogs: `tiny.dialogs`

`alert({message, detail?, buttons?, danger?})` -> index of the button; `confirm(message, opts?)` -> boolean; `prompt(message, {value?, title?})` -> string | null; `openFile({startIn?, filters?, multiple?, title?})` -> paths | null; `openFolder()`; `saveFile({name?, startIn?, filters?})` -> path | null. They are drawn by Desktop; the app may use exactly what the user picked.

### Host files: `tiny.host`

`importFiles(destFolder, {directory?})` opens the real computer's file picker and copies the choice into a folder the app may write; `exportPath(path, {saveAs?})` downloads a file (a folder becomes a zip).

### Shell: `tiny.shell`

`open(target, {app?})` (path, URL or app id, like a double-click), `reveal(path)` (show in Finder), `openApp(id)`, `apps()`, `icon(target)` -> `{name, url, description}` (a `data:` URL you can put in `<img>`), `contextMenu(items, {x, y})` (items have `action`s; coordinates are in the window), `notify(title, body)`.

### Events: `tiny.on(name, fn)`

`focus`, `blur`, `theme` (theme object), `openFile`, `openURL`, `reveal` (Finder), `menu` handled for you. Return values of `save-state` and `close-request` handlers are answers to Desktop; use `tiny.app.onSaveState` and `tiny.window.onCloseRequest`.

### Admin: `tiny.admin` (Settings, Activity Monitor, Console, Finder only)

`tiny.admin.kernel('permList')`, `tiny.admin.kernel('configSet', domain, key, value)`, `tiny.admin.service('tiny.network', {op: 'rules.set', ...})`: calls that run as the system. Allowed kernel calls are listed in `src/apphost.ts` (`ADMIN_KERNEL`). Other apps get `EPERM`.

### Helpers

`html\`...\``, `escapeHtml`, `dirname`, `basename`, `joinPath`, `formatBytes`, `textOf(bytes)`, `bytesOf(text)`, `SysError`.

## Look and feel

Desktop injects `sdk/base.css` and the theme (`--accent`, `--text`, `--text-dim`, `--window-bg`, `--window-titlebar`, `--separator`, `--font`, `--mono`, light/dark via `:root[data-theme]`). The window itself is the translucent background: leave `body` transparent. Base classes: `.toolbar`, `.sidebar` (+ `.item`, `h4`), `.layout`, `.content`, `.scroll`, `table.list`, `.segmented`, `button.primary|plain|icon|danger`, `.switch` (checkbox), `.dim`, `.row`, `.stack`, `.grow`, `.card`, `kbd`. Respect `prefers-reduced-motion` (`:root[data-reduce-motion=true]`). Every control reachable by keyboard; give interactive elements roles and labels.

## Testing an app

End-to-end tests live in `desktop/tests/<app>.spec.ts` and use the fixture in `tests/fixtures.ts` (a booted desktop on a private file system). An app's window is `desktop.win('Title')`; its content is `desktop.win('Title').frameLocator('iframe')`. Launch via the Dock (`desktop.dock('org.tiny.x')`) or `page.evaluate(() => window.tiny.apps.launch('org.tiny.x'))`. Files can be prepared through `window.tiny.kernel` (the page's kernel, acting as the system: `chown(path, 501, 20)` for files the user should own). Run with `pnpm exec playwright test tests/<name>`.

## Not in the SDK (yet)

Shared Web Components; drag and drop between windows and the desktop; mounting host folders; per-app notification settings. If you need one of these, note it in `desktop/docs/requests.md` and work around it.
