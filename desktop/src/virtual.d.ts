declare module 'virtual:bundled-apps' {
  /** Apps that ship with Pear, as `{files}` sources for `bundleInstall` (see vite.config.ts). */
  const apps: Array<{ id: string; name: string; dir: string; build: string; files: Record<string, string> }>
  export default apps
}
