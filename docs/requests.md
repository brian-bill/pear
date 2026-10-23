
## From Activity Monitor and Console

- **Clipboard for admin apps.** Console copies rows with `navigator.clipboard` and falls back to `execCommand('copy')` because it has no `clipboard` permission. An admin way to write the clipboard (`tiny.admin.service('tiny.clipboard', ...)` with a documented item shape) would be cleaner.
- **Filtered export.** `logExport` takes only a time range and private flag, no level/subsystem/text filter, and is capped at 5000 entries. Console exports everything it returns; "export what is shown" needs a filter argument.
- **Parent reaping.** Processes killed from outside stay listed as `zombie` until their parent waits. Activity Monitor shows them dimmed; Desktop or init could reap orphans spawned from outside.
- **User names.** `ProcessInfo` has only `uid`; Activity Monitor hard-codes 0 = root, 501 = tiny. A `userName` field (or a `getpwuid` call) would remove that.
- **Live log events.** `logSubscribe` events are not reachable through `tiny.admin`; Console polls `logQuery({since})` every second instead.

## From Settings (org.tiny.settings)

- **Downloads in app windows**: the app iframe sandbox is `allow-scripts allow-forms`, so `<a download>` with a blob URL is blocked. Settings writes the backup to `~/Documents/Pear backup.tinyimg` and calls `tiny.host.exportPath` instead. Adding `allow-downloads` would allow a direct download.
- **Wallpaper**: Desktop should render `tiny.desktop.wallpaper` `path`: `builtin:one-piece` (the bundled default picture) or `builtin:aurora|dusk|graphite|forest|ocean` (gradients; Settings previews: aurora `#0f2027 -> #2c7a7b -> #6bd0a0`, dusk `#2b1055 -> #7597de -> #f8b195`, graphite `#1c1c1e -> #48484a`, forest `#0b3d2e -> #2f7d4f -> #a8c66c`, ocean `#03045e -> #0077b6 -> #90e0ef`, all 135deg) or an image path in the VFS, with `fit` (fill, fit, stretch, center, tile). An unset `path` shows `builtin:one-piece`.
- **Notifications**: Desktop should honor `tiny.notifications` `dnd` (boolean) and `apps` (object appId -> boolean; missing means allowed).
- **Deep link event**: Desktop could send `openPane` (`tiny.on('openPane', id)`) to a running Settings window; Settings also reads `pane:<id>` launch args. Pane ids: general appearance desktop displays sound keyboard language notifications privacy network apps accessibility power.
- **Dock default**: `tiny.desktop.dock` `items` is empty until the user edits it, while Desktop pins a built-in default list. Settings mirrors that list (finder, terminal, textedit, settings); Desktop should write the default into the setting at first run.
- **Other settings Settings writes** that Desktop/Vanilla may honor: `tiny.system` `shareCrashReports`, `highContrast`.
- **Window title**: Settings keeps the title "System Settings"; the pane name is shown inside the window.

## From TextEdit / Calculator / Preview

- **App-initiated session save.** `Desktop.scheduleSave()` runs on window-manager events only, so an unsaved draft typed after the last such event (move, focus, `setEdited` flip) is not in the saved session until something else triggers it, and may be lost on a quick reload or crash. Wanted: `tiny.app.stateChanged()` (SDK) that asks Desktop to `scheduleSave()`. TextEdit's `onSaveState` already returns the draft; the test calls `window.tiny.saveNow()` to force it.
- **Menu items with submenus** (for "Open Recent"). TextEdit lists recent documents inline under a disabled "Recent Documents" item instead.
- **Menu shortcut `Cmd++`.** `setMenus` rewrites `++` to `+`, so "Cmd++" cannot be declared; TextEdit declares `Cmd+=` and handles `Cmd+Shift+=` itself.

## From Finder

- **Context menu submenus.** `tiny.shell.contextMenu` items have no `items` for a submenu, so Finder's "Open With" and "Tags" are flat entries ("Open With <App>", "Tags…" opens a prompt).
- **Events to a window that is still loading.** `shell.reveal` / `deliver` to a Finder that has no window opens one and posts the event at once; the iframe has not loaded yet, so the `reveal` event is lost (Finder opens at Home instead). Deliver after the window's `ready` note, or pass the path as the new window's `args`.
- **Clipboard permission.** Finder declares `clipboard` in addition to `fs.user`/`fs.all`, because file references go on the `general` pasteboard (`application/x-tiny-file-ref`); without it Finder falls back to a file in its container.
- **Window title lookup.** Finder's window title follows the folder, so tests find its frame by `iframe[title="Finder"]`.
- **Drag between windows / from the desktop** is not in the SDK; Finder uses plain HTML5 DnD inside a window (and host files dropped on the window) only.

## From Safari, Notes, Reminders, Clock, Maps, Voice Memos, Books, Weather/Stocks/News and Freeform

- **Microphone for app windows.** Voice Memos can import and play audio, but recording cannot work: the app window is an opaque-origin sandbox with no permissions policy, so `getUserMedia` is refused, and `tiny.audio`'s `inputRequest` hands out a kernel port that window scripts cannot create (the SDK client deliberately has no port calls). Wanted: an SDK path that requests a microphone stream on behalf of a window (with a permission prompt in Desktop) and delivers PCM or an audio port to it. The app already captures with `MediaRecorder` and decodes to PCM when a stream is granted, so the missing piece is the host bridge.
- **Menu shortcuts while the window chrome has focus.** Menu accelerators are matched inside the app document (`sdk/client.ts`). After a click on a window's titlebar, keyboard focus is in Desktop's document, so Cmd+N / Cmd+O / Cmd+S never reach the app and do nothing. macOS sends menu commands to the active app whichever part of its window is focused. Wanted: Desktop forwards unhandled Cmd-key events to the focused window's app (the reverse direction already exists as the `key` note), or the menu bar matches accelerators itself.
- **Concurrent kernel calls.** Two interleaved wasm calls can panic with `recursive use of an object detected which would lead to unsafe aliasing in rust` (wasm-bindgen reentrancy). Apps retry the call — matching the message, since app-side errors arrive as `SysError`, not `KernelError` — but a retry can be starved by another caller polling quickly (a test polling a file every 100 ms can keep a rename failing). Serializing calls in the kernel worker/client would remove this whole class of flakes; until then, app-side retries wait ~250 ms between attempts.
- **Safari page scripts have no storage or real address.** The network bridge now stands in for `fetch`/`XMLHttpRequest`/`sendBeacon` (each request runs through `tiny.network`, so pages can call their APIs), and a page's `history.pushState`/`document.cookie` are quiet no-ops instead of `SecurityError`s. But the frame still has an opaque origin: `localStorage`, `sessionStorage`, cookies and IndexedDB are unavailable, and `location` reads as `about:srcdoc`, so sites that boot from a storage call (or route on the address bar) still stop early. Giving the frame a real origin (and with it same-origin storage, cookies and a URL) needs a host-rendered web view or a frame-capable app sandbox.
- **Map tiles and geocoding.** Maps is an offline SVG world with a built-in city list (search, zoom, pins, a saved picture). Real maps need a tile/geocoding endpoint reachable through `tiny.network`; the app's view state and picture export would stay the same.
- **Location.** Weather asks for a city by name because there is no location service; a `tiny.location`-style API (or a system region setting) would let Weather and Maps start where the user is.
- **Books and file ownership.** Books reads `.txt`/`.md` but must not claim them (TextEdit owns those extensions), so double-clicking a text file still opens TextEdit. Opening a book uses `launchOpen(path, { app })` or Books' Open panel. A per-app "Open With" / default-app exception would make plain-text books open in Books when the user asks for it. Notes is in the same position: it edits outside text files through its own Open panel (which grants write access) without claiming `.txt`/`.md`, so TextEdit stays the default editor.
- **Dense filesystem polling in tests.** `expect.poll` on the kernel at its default 100 ms cadence competes with the app's writes (see the aliasing note above). The specs poll at 300–1000 ms for file changes; that is a workaround, not a contract.
