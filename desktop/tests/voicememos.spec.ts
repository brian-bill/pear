import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'
const DOCS = `${HOME}/Documents`
const LIB = `${HOME}/Music/Voice Memos`

/** A mono 16-bit WAV: `secs` seconds of a 440 Hz sine at 8 kHz. The `wavBytes` helper copied
 *  verbatim from `desktop/tests/media.spec.ts`. Long enough (6 s) that the memo is still playing
 *  while a loaded machine works through the test's clicks and polls. */
function wavBytes(secs = 6): Uint8Array {
  const rate = 8000
  const samples = Math.round(rate * secs)
  const out = new Uint8Array(44 + samples * 2)
  const view = new DataView(out.buffer)
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  write(0, 'RIFF')
  view.setUint32(4, out.length - 8, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) out[44 + i * 2] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 60) + 128
  return out
}

/** Store bytes in the VFS as if the user had saved or imported them. The kernel worker serves
 *  requests concurrently; two interleaved wasm calls can panic with the aliasing error, and it
 *  never leaves a half-written file behind, so once is enough. Copied verbatim from
 *  `desktop/tests/media.spec.ts` (`put`). */
async function put(desktop: Desktop, p: string, bytes: Uint8Array): Promise<void> {
  await desktop.page.evaluate(
    async ({ p, bytes }) => {
      const k = window.tiny!.kernel
      for (let tries = 0; ; tries++) {
        try {
          await k.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
          await k.writeFile(p, new Uint8Array(bytes))
          await k.chown(p, 501, 20)
          return
        } catch (e) {
          if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') throw e
        }
      }
    },
    { p, bytes: Array.from(bytes) },
  )
}

/** File names in the library folder ([] when the folder is not there yet). */
const listing = (desktop: Desktop) =>
  desktop.page.evaluate(async (dir) => {
    try {
      return (await window.tiny!.kernel.readdir(dir)).map((n) => n.name)
    } catch {
      return [] as string[]
    }
  }, LIB)

test('an imported memo shows with its duration, plays, and renames on disk', async ({ desktop }) => {
  const { page } = desktop
  // the Open panel Desktop draws starts in ~/Documents, so the import file lives there
  await put(desktop, `${DOCS}/memo.wav`, wavBytes())

  await page.evaluate(() => void window.tiny!.apps.launch('org.tiny.voicememos'))
  const win = () => desktop.win('Voice Memos')
  await expect(win(), 'the app window').toBeVisible({ timeout: 20_000 })
  const frame = win().frameLocator('iframe')
  await expect(frame.locator('#import'), 'the app booted').toBeVisible()

  // Import audio… opens the Desktop-drawn Open panel; double-click picks the file
  await frame.getByRole('button', { name: 'Import audio…' }).click()
  const sheet = win().locator('.sheet.picker')
  await expect(sheet, 'the Open panel over Voice Memos').toBeVisible()
  await sheet.locator('.entry', { hasText: 'memo.wav' }).dblclick()

  // the library row carries the name without the extension and the decoded duration (≈0:06)
  const row = frame.locator('.memo', { hasText: 'memo' }).first()
  await expect(row, 'the imported memo in the library').toBeVisible()
  await expect(row.locator('.dur')).toHaveText(/^0:0[5-7](\.\d)?$/)

  // selected row is highlighted, then a play: the audio unlock wants a gesture on the page itself,
  // so click the window's titlebar first (a real desktop click), and only then press Play
  await row.click()
  await expect(row).toHaveClass(/sel/)
  await win().locator('.titlebar').click()
  await frame.getByRole('button', { name: 'Play', exact: true }).click()
  const playBtn = frame.locator('#play')
  await expect(playBtn, 'Play toggles to Stop').toHaveAttribute('aria-label', 'Stop')
  await expect
    .poll(async () => (await frame.locator('#cur').textContent()) ?? '', { timeout: 10_000 })
    .not.toBe('0:00')
  await playBtn.click()
  await expect(playBtn, 'Stop toggles back to Play').toHaveAttribute('aria-label', 'Play')
  await expect(frame.locator('#cur')).toHaveText('0:00')

  // double-click renames through the Desktop prompt; the file on disk follows
  await row.dblclick()
  const promptInput = win().locator('.sheet input')
  await expect(promptInput).toBeVisible()
  await promptInput.fill('First memo')
  await promptInput.press('Enter')
  const renamed = frame.locator('.memo', { hasText: 'First memo' })
  await expect(renamed, 'the row was renamed').toBeVisible()
  // on disk: 'First memo.wav' now, and 'memo.wav' gone (the app keeps only the memos in the folder)
  await expect.poll(async () => (await listing(desktop)).filter((n) => /\.wav$/i.test(n)).sort()).toEqual(['First memo.wav'])

  await page.screenshot({ path: 'test-results/voicememos.png' })
})

test('the record button is honest when the microphone is not available in the shell', async ({ desktop }) => {
  const { page } = desktop
  await page.evaluate(() => void window.tiny!.apps.launch('org.tiny.voicememos'))
  const win = () => desktop.win('Voice Memos')
  await expect(win(), 'the app window').toBeVisible({ timeout: 20_000 })
  const frame = win().frameLocator('iframe')
  await expect(frame.locator('#rec')).toHaveAttribute('aria-label', 'Record')

  // the sandboxed window is not granted the microphone; the app says so instead of pretending
  await frame.getByRole('button', { name: 'Record' }).click()
  const note = frame.locator('#note')
  await expect(note, 'the honest empty state').toContainText('Microphone isn\'t available in this shell yet')

  // the attempt failed benignly: the button is back to Record and nothing was written
  await expect(frame.locator('#rec')).toHaveAttribute('aria-label', 'Record')
  await page.waitForTimeout(1500)
  await expect.poll(async () => await listing(desktop)).toEqual([])
})
