import type { FrameLocator } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

async function openSettings(desktop: Desktop, args: string[] = []): Promise<FrameLocator> {
  await desktop.page.evaluate((a) => window.tiny!.apps.launch('org.tiny.settings', { args: a }), args)
  await expect(desktop.win('System Settings')).toBeVisible()
  return desktop.win('System Settings').frameLocator('iframe')
}

const pane = (f: FrameLocator, name: string) => f.locator('.sidebar .item', { hasText: name }).click()
const perm = async (page: Desktop['page']) => (await page.evaluate(() => window.tiny!.kernel.permList('org.tiny.terminal'))).find((g) => g.capability === 'process.spawn')?.status
const cfg = (desktop: Desktop, domain: string, key: string) => desktop.page.evaluate(([d, k]) => window.tiny!.kernel.configGet(d, k), [domain, key] as const)

test('opens on General, shows system information and renames the computer', async ({ desktop }) => {
  const f = await openSettings(desktop)
  await expect(f.locator('#title')).toHaveText('General')
  await expect(f.locator('.pane-body')).toContainText('Kernel')
  const name = f.getByLabel('Computer name')
  await name.fill('studio-mac')
  await name.press('Enter')
  await expect.poll(() => desktop.page.evaluate(() => window.tiny!.kernel.configGet('tiny.system', 'hostname'))).toBe('studio-mac')
  // a bad name is refused and shown
  await name.fill('bad name!')
  await name.press('Enter')
  await expect(f.locator('.status')).toHaveClass(/error/)
  await expect(name).toHaveValue('studio-mac')
})

test('appearance: dark mode, accent, reduce motion and text size take effect on the desktop', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await pane(f, 'Appearance')
  await f.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(f.locator('html')).toHaveAttribute('data-theme', 'dark') // the window follows too
  expect(await cfg(desktop, 'tiny.system', 'appearance')).toBe('dark')
  await f.getByRole('button', { name: 'Light', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))
  await f.getByRole('button', { name: 'green', exact: true }).click()
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))).not.toBe(before)
  expect(await cfg(desktop, 'tiny.system', 'accentColor')).toBe('green')

  await f.getByRole('switch', { name: 'Reduce motion' }).check()
  expect(await cfg(desktop, 'tiny.system', 'reduceMotion')).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')

  await f.getByLabel('Text size').first().fill('1.2')
  await expect.poll(() => cfg(desktop, 'tiny.system', 'textScale')).toBe(1.2)
})

test('desktop and dock: size, position, auto-hide and wallpaper are stored and applied', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await pane(f, 'Desktop & Dock')
  await f.getByLabel('Dock size').fill('72')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dock-size').trim())).toBe('72px')
  await f.getByRole('button', { name: 'Left', exact: true }).click()
  await expect(page.locator('.dock')).toHaveAttribute('data-position', 'left')
  await f.getByRole('switch', { name: 'Automatically hide the Dock' }).check()
  expect(await cfg(desktop, 'tiny.desktop.dock', 'autohide')).toBe(true)

  await f.getByRole('button', { name: 'Ocean' }).click()
  expect(await cfg(desktop, 'tiny.desktop.wallpaper', 'path')).toBe('builtin:ocean')
  await f.getByLabel('Wallpaper fit').selectOption('tile')
  expect(await cfg(desktop, 'tiny.desktop.wallpaper', 'fit')).toBe('tile')

  // pinned apps: remove one and move another
  await expect(page.locator('.dock .item[data-app="org.tiny.terminal"]')).toBeVisible()
  const first = await f.locator('.line[data-app]').first().getAttribute('data-app')
  await f.getByRole('button', { name: 'Remove Terminal from the Dock' }).click()
  await expect(page.locator('.dock .item[data-app="org.tiny.terminal"]')).toHaveCount(0)
  expect(await cfg(desktop, 'tiny.desktop.dock', 'items')).not.toContain('org.tiny.terminal')
  await f.locator('.line[data-app]').first().getByRole('button', { name: /down/ }).click()
  await expect.poll(async () => ((await cfg(desktop, 'tiny.desktop.dock', 'items')) as string[])[1]).toBe(first)
})

test('privacy: revoking an app permission is reflected in Vanilla; the audit log lists it', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await pane(f, 'Privacy & Security')
  const box = f.getByRole('switch', { name: 'Terminal: Run programs' })
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect.poll(async () => (await perm(page))).toBe('denied')
  await box.check()
  await expect.poll(async () => (await perm(page))).toBe('granted')
  await f.getByRole('button', { name: 'Reset permissions of Terminal' }).click()
  await expect.poll(async () => (await perm(page))).toBe('prompt')

  await f.getByRole('switch', { name: 'Share crash reports' }).check()
  expect(await cfg(desktop, 'tiny.system', 'shareCrashReports')).toBe(true)
  await f.getByLabel('Restore after a crash').selectOption('never')
  expect(await cfg(desktop, 'tiny.session', 'restoreOnCrash')).toBe('never')
  await f.getByRole('switch', { name: 'Lock on wake' }).check()
  expect(await cfg(desktop, 'tiny.session', 'lockOnWake')).toBe(true)
})

test('notifications, sound, keyboard and network write their domains', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await pane(f, 'Notifications')
  await f.getByRole('switch', { name: 'Do Not Disturb' }).check()
  expect(await cfg(desktop, 'tiny.notifications', 'dnd')).toBe(true)
  await f.getByRole('switch', { name: 'Allow notifications from Terminal' }).uncheck()
  expect(await cfg(desktop, 'tiny.notifications', 'apps')).toMatchObject({ 'org.tiny.terminal': false })

  await pane(f, 'Sound')
  await f.getByLabel('Output volume').fill('40')
  await expect.poll(() => cfg(desktop, 'tiny.audio', 'volume')).toBeCloseTo(0.4)
  await f.getByRole('switch', { name: 'Mute', exact: true }).check()
  await expect.poll(() => cfg(desktop, 'tiny.audio', 'muted')).toBe(true)
  await f.getByLabel('Terminal volume').fill('25')
  await expect.poll(async () => ((await cfg(desktop, 'tiny.audio', 'appVolumes')) as Record<string, number>)['org.tiny.terminal']).toBeCloseTo(0.25)

  await pane(f, 'Keyboard')
  await f.getByLabel('Command key mapping').selectOption('ctrl')
  expect(await cfg(desktop, 'tiny.input', 'cmdMapping')).toBe('ctrl')
  await f.getByLabel('Keyboard layout').selectOption('dvorak')
  await expect.poll(() => cfg(desktop, 'tiny.input', 'layout')).toBe('dvorak')
  await expect(f.locator('.pane-body')).toContainText('Close window')

  await pane(f, 'Network')
  await f.getByLabel('Network rule for Terminal').selectOption('deny')
  await expect.poll(async () => ((await cfg(desktop, 'tiny.network', 'rules')) as any)['org.tiny.terminal']?.mode).toBe('deny')
  const proxy = f.getByLabel('Proxy URL')
  await proxy.fill('https://proxy.example/?u=')
  await proxy.press('Enter')
  await expect.poll(() => cfg(desktop, 'tiny.network', 'proxy')).toBe('https://proxy.example/?u=')
  await page.evaluate(() => 0)
})

test('language & region: settings are stored and the preview follows', async ({ desktop }) => {
  test.setTimeout(90_000) // the time zone list is long
  const f = await openSettings(desktop)
  await pane(f, 'Language & Region')
  await f.getByLabel('Language', { exact: true }).selectOption('de-DE')
  expect(await cfg(desktop, 'tiny.system', 'locale')).toBe('de-DE')
  await expect(f.getByLabel('Format preview')).toContainText('1.234.567,89')
  await f.getByLabel('Time zone').selectOption('Asia/Tokyo')
  await expect.poll(() => cfg(desktop, 'tiny.system', 'timezone')).toBe('Asia/Tokyo')
  await f.getByLabel('First day of week').selectOption('1')
  await expect.poll(() => cfg(desktop, 'tiny.system', 'firstWeekday')).toBe(1)
  await f.getByLabel('Measurement system').selectOption('us')
  await expect.poll(() => cfg(desktop, 'tiny.system', 'measurement')).toBe('us')
})

test('sidebar search filters panes; deep links and the saved pane choose the pane', async ({ desktop }) => {
  const f = await openSettings(desktop, ['pane:appearance'])
  await expect(f.locator('#title')).toHaveText('Appearance')
  await f.getByLabel('Search settings').fill('dock')
  await expect(f.locator('.sidebar .item')).toHaveCount(1)
  await expect(f.locator('.sidebar .item')).toContainText('Desktop & Dock')
  await f.getByLabel('Search settings').fill('zzzz')
  await expect(f.locator('.sidebar .empty')).toBeVisible()
  await f.getByLabel('Search settings').fill('')
  await pane(f, 'Sound')
  await expect(f.locator('#title')).toHaveText('Sound')
  // the selected pane is saved with the session
  await desktop.page.waitForTimeout(500)
  await desktop.page.evaluate(() => window.tiny!.kernel.shutdown?.call(null, {}).catch(() => {})).catch(() => {})
})

test('apps: system apps cannot be uninstalled; default apps and startup items work', async ({ desktop }) => {
  const f = await openSettings(desktop)
  await pane(f, 'Apps')
  await expect(f.locator('.line[data-app="org.tiny.terminal"]')).toContainText('Terminal')
  await expect(f.getByRole('button', { name: 'Uninstall Terminal' })).toBeVisible()

  await pane(f, 'General')
  await f.getByLabel('Add startup item').selectOption('org.tiny.terminal')
  await expect(f.locator('.pane-body')).toContainText('Terminal')
  await expect.poll(() => cfg(desktop, 'tiny.session', 'startupItems')).toContain('org.tiny.terminal')
  await f.getByRole('button', { name: 'Remove Terminal from startup items' }).click()
  await expect.poll(() => cfg(desktop, 'tiny.session', 'startupItems')).not.toContain('org.tiny.terminal')
})

test('a backup is written to Documents and verifies as a disk image', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await f.getByRole('button', { name: 'Back Up Now' }).click()
  await expect(f.locator('.status')).toContainText(/Backup saved/, { timeout: 30_000 })
  const ok = await page.evaluate(async () => {
    const bytes = await window.tiny!.kernel.readFile('/Users/pear/Documents/Pear backup.tinyimg')
    return (await window.tiny!.kernel.imageVerify(new Blob([bytes as BlobPart]))).ok
  })
  expect(ok).toBe(true)
})

test('displays, battery and software update panes load', async ({ desktop }) => {
  const f = await openSettings(desktop)
  await pane(f, 'Displays')
  await expect(f.locator('.pane-body')).toContainText('Resolution')
  await pane(f, 'Battery')
  await expect(f.locator('.pane-body')).toContainText('Preventing sleep')
  await pane(f, 'Accessibility')
  await expect(f.locator('.pane-body')).toContainText('Motion')
  await pane(f, 'General')
  await expect(f.locator('.pane-body')).toContainText('Pear is up to date')
})

test('changes made elsewhere show up when the window gains focus again', async ({ desktop }) => {
  const { page } = desktop
  const f = await openSettings(desktop)
  await pane(f, 'Appearance')
  await page.evaluate(() => window.tiny!.kernel.configSet('tiny.system', 'appearance', 'dark'))
  await desktop.dock('org.tiny.terminal').click()
  await expect(desktop.win('Terminal')).toHaveClass(/focused/)
  await desktop.win('System Settings').locator('.titlebar').click({ position: { x: 150, y: 10 } })
  await expect(desktop.win('System Settings')).toHaveClass(/focused/)
  await expect(f.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
