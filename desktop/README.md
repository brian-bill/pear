# Desktop

Desktop is the macOS-inspired user interface of [Pear](../README.md), a lightweight web-based operating system. It runs on top of [Vanilla](../vanilla/README.md), the core OS, and provides the windows, menu bar, dock, file browser, and bundled apps that users interact with.

> Status: working prototype. Window manager, shell (menu bar, dock, launcher, notifications, lock screen), the Desktop SDK and nine apps run on the real Vanilla kernel. WebGL effects are not built.

## What Desktop is

- A window manager and compositor
- A menu bar with app menus and system status items
- A dock with pinned apps, running indicators, and minimize targets
- A Finder-like file browser over Vanilla's virtual file system
- A Spotlight-style launcher for apps and files
- A set of small bundled apps (Terminal, Text Editor, Settings, ...)

## What Desktop is not

- Not a pixel-perfect clone of macOS. It is inspired by it, keeping the conventions (menu bar, dock, traffic-light window controls, keyboard shortcuts) that make it familiar.
- Not a privileged layer. It is a client of Vanilla and uses the same syscall interface as any other app.

## Architecture

```
┌──────────────────────────────────────────┐
│  Apps (Finder, Terminal, Editor, ...)    │
├──────────────────────────────────────────┤
│  Desktop shell                           │
│  menu bar · dock · launcher · notifs     │
├──────────────────────────────────────────┤
│  Window manager + compositor (WebGL)     │
├──────────────────────────────────────────┤
│  Desktop SDK (app API)                   │
├──────────────────────────────────────────┤
│  Vanilla syscall interface               │
└──────────────────────────────────────────┘
```

Desktop never touches OPFS or LocalStorage directly. Files go through the VFS syscalls and settings go through `config_get` / `config_set`.

### Window manager and compositor

- Each window is a surface owned by an app process.
- The compositor draws surfaces with **WebGL**: shadows, blur/translucency, and animations such as minimize and window open/close.
- Handles focus, stacking order, move, resize, minimize, maximize/fullscreen, and snapping.
- Falls back to a 2D canvas or DOM path where WebGL is unavailable.

### Menu bar

- Shows the active app's name and menus, plus system status items (clock, volume, theme).
- Apps register their menus and keyboard shortcuts; the menu bar renders them.

### Dock

- Pinned apps, running-app indicators, and a trash.
- Minimized windows animate to the dock.
- Layout is persisted via Vanilla's configuration service.

### Launcher

- Keyboard-invoked search over installed apps and files (`Cmd+Space` or similar; the browser may reserve some combinations, so the binding is configurable).

### Apps

| App | Purpose |
|-----|---------|
| Finder | Browse, open, move, copy, and delete files in the VFS |
| Terminal | Run the Vanilla shell and userland utilities |
| Text Editor | Create and edit plain-text files |
| Settings | Theme, dock, wallpaper, and system preferences |

Apps are packaged under `/Applications` in the VFS and launched through Vanilla's launch service.

### Desktop SDK

A small API that wraps Vanilla syscalls for UI work:

- Create and manage windows
- Register menus and shortcuts
- Open file pickers and dialogs
- Read and write files and settings
- Post notifications

Bundled apps use the same SDK that third-party apps would.

## Theming

- Light and dark appearance, following the system preference by default.
- Wallpaper, accent color, and dock size/position are configurable.
- Theme values are CSS custom properties, so apps pick them up automatically.

## Input and accessibility

- Mouse, touch, and keyboard are first-class; every action reachable by pointer is also reachable by keyboard.
- Standard roles and labels on UI elements for screen readers.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

## Performance goals

- Interactive desktop shortly after Vanilla finishes booting.
- Apps lazy-loaded on launch, not at boot.
- Redraw only when something changes; no idle animation loops.
- Compositing stays within a 60 fps frame budget on typical hardware.

## Session restore

Desktop saves window positions, open apps, and dock layout through Vanilla's configuration service and restores them on the next visit.

## What exists

| Piece | Where | Notes |
|-------|-------|-------|
| Window manager | `src/wm/windows.ts` | DOM windows: move, resize, focus and stacking, minimize to the dock, maximize, close with a guard (unsaved changes), Cmd+W / Cmd+M / Cmd+\` / Alt+Tab |
| Menu bar | `src/shell/menubar.ts`, `statusbar.ts` | Pear menu, the focused app's menus (apps set them through the SDK), Window menu, status items (search, volume, network, battery, notifications), clock |
| Dock | `src/shell/dock.ts` | Pinned and running apps, minimized windows, Trash (full/empty), context menu, size / position / auto-hide / magnification from settings |
| Launcher | `src/shell/launcher.ts` | Alt+Space: apps, files, settings panes, calculator and unit conversion through `tiny.search` |
| Notifications | `src/shell/notifications.ts` | Banners, Notification Center, Do Not Disturb and per-app switches |
| Mission Control, lock screen | `missioncontrol.ts`, `lock.ts` | Ctrl+Up; lock screen over `tiny.session` with optional password |
| Desktop surface | `src/shell/surface.ts` | Wallpapers (built-in or a picture), icons of `~/Desktop`, context menu, host files dropped on it |
| App host and SDK | `src/apphost.ts`, `sdk/`, `docs/sdk.md` | Apps are bundles: a Vanilla process plus sandboxed iframe windows; see the SDK guide |
| Apps (`apps/*.app`) | Finder, Terminal, TextEdit, Settings, Calculator, Preview, Activity Monitor, Console, Profile, About, Music, QuickTime Player, Safari, Notes, Reminders, Clock, Maps, Voice Memos, Books, Weather, Stocks, News, Freeform | Installed into `/Applications` at first boot. Profile is the résumé and project story app, pinned first in the default Dock and opened on first boot. Music plays every audio file into the `tiny.audio` mixer (the desktop page's `AudioContext`, so playback waits for a click after an app launch); QuickTime opens every video file in a `<video>` element (and audio files when asked). Together they make Music the default app for audio and QuickTime for video, so files of every kind open somewhere. Safari is the web browser: pages are fetched through `tiny.network` and shown in a sandboxed iframe with their own styles, scripts, iframes and workers, while a small bridge routes link clicks, forms and title changes to the app and stands in for `fetch`/`XMLHttpRequest`/`sendBeacon` (each page request runs through `tiny.network` under the app's network permission); it keeps history and bookmarks, and is the system handler for `http`/`https` links (a story opened from News lands in Safari). Page scripts run with an opaque origin and `connect-src 'none'`, so they cannot reach the app, the kernel, or connect anywhere themselves. Notes edits plain text and names each file after its first line (it opens outside text files through its own panel, so TextEdit stays the default editor for `.txt`); Reminders, Clock, Maps, Books and Freeform keep their state in the VFS; Weather, Stocks and News read live feeds (and show friendly error cards offline); Voice Memos imports and plays audio, and its record button explains the missing microphone bridge (see `docs/requests.md`) |
| Session | `src/desktop.ts` | Windows and per-window app state saved through `tiny.session`; crash prompt |

**Safari and CORS.** A browser cannot read a cross-origin response without the site's CORS headers, and cannot fetch `http` from an `https` page. Safari tries the address directly first; when the browser refuses it (the reader shows `EACCES`), it retries through the deployment's stateless `/api/proxy` endpoint (Vite middleware in development, `api/proxy.ts` on Vercel). Same-origin pages and CORS-friendly APIs still go direct, and a plain static host without the endpoint keeps the original error. The proxy stores nothing and refuses private addresses in production. The page document may always take the proxy; a page's own bridge requests may only use it for the page's own host, so a third-party script gains no CORS-free ride to other sites. Bare hosts are opened as `https` (like a browser). The page document and the page's bridge requests go through `tiny.network`: once in the sandbox, the page's own `<link>`, `<script>`, image and font URLs load directly from their origins (subresources need no CORS), using the final URL as their base. An `http` page loaded from an `https` desktop still has its subresources blocked as mixed content.

Not built: WebGL effects (window content is DOM and iframes, which cannot be snapshotted into a texture, so minimize is a CSS animation and Mission Control shows cards instead of live thumbnails), drag and drop between windows and the desktop, mounting host folders, submenus, shared Web Components. See `docs/requests.md` for the list the app authors collected.
