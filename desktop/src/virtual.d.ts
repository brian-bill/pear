declare module 'virtual:bundled-apps' {
  /** Apps that ship with Pear, as `{files}` sources for `bundleInstall` (see vite.config.ts). */
  const apps: Array<{ id: string; name: string; dir: string; build: string; files: Record<string, string> }>
  export default apps
  /** The SDK's standard host process (`main.js` of every UI app that has no process of its own). */
  export const hostSource: string
  /** The SDK as a classic script that sets `window.tiny`, for windows of apps that were not built against it. */
  export const clientSource: string
}
