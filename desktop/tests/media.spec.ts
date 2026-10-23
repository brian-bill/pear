import type { Page } from '@playwright/test'
import { expect, test, type Desktop } from './fixtures'

const HOME = '/Users/pear'
const DOCS = `${HOME}/Documents`
const AUDIO = `${HOME}/Music`

/** A mono 16-bit WAV: `secs` seconds of a 440 Hz sine at 8 kHz. Long enough (6 s) that the song
 *  is still playing while a loaded machine works through the test's clicks and polls. */
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

const textBytes = (s: string) => new TextEncoder().encode(s)

/** Store bytes in the VFS as if the user had saved or imported them. */
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
          // The kernel worker serves requests concurrently; two interleaved wasm calls can
          // panic with this aliasing error. It never leaves a half-written file behind, so once is enough.
          if (tries > 0 || !(e instanceof Error) || !/unsafe aliasing/.test(e.message) || e.name !== 'KernelError') throw e
        }
      }
    },
    { p, bytes: Array.from(bytes) },
  )
}

/** Ask the launch services to open a file, optionally naming an app. */
const open = (desktop: Desktop, path: string, app?: string) =>
  desktop.page.evaluate((g) => window.tiny!.kernel.launchOpen(g.p, { app: g.app }), { p: path, app })

/** Does the mixer say Music is sounding? (writing audible frames marks an app playing) */
const isPlaying = (page: Page) =>
  page.evaluate(async () => {
    const tiny = window.tiny!
    const port = await tiny.kernel.lookup('tiny.audio')
    const res = (await tiny.kernel.request(port, { op: 'state' }, { timeout: 3000 })) as {
      data: { ok?: boolean; result?: { playing?: Array<{ appId: string | null }> } }
    }
    return (res.data.result?.playing ?? []).some((x) => x.appId === 'org.tiny.music')
  })

test('Music opens and plays a WAV: the mixer reports it, pause stops it', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${AUDIO}/tone.wav`, wavBytes())
  await open(desktop, `${AUDIO}/tone.wav`)
  const win = () => desktop.win('tone.wav')
  // the launch boots the app and decodes before the window carries the song's name
  await expect(win()).toBeVisible({ timeout: 15_000 })
  const frame = win().frameLocator('iframe')
  await expect(frame.locator('#title')).toHaveText('tone.wav')
  await expect(frame.locator('#sub')).toContainText('AUDIO/WAV')

  // nothing should sound yet: a launched file waits for a click
  await expect.poll(() => isPlaying(page), { timeout: 3000 }).toBe(false)
  await frame.getByRole('button', { name: 'Play' }).click()

  // a click on the Music window's titlebar is a real desktop gesture (page DOM, not the app's
  // iframe), so the driver's audio unlock fires; Music keeps focus and the transport stays usable
  await win().locator('.titlebar').click()
  await expect.poll(() => isPlaying(page), { timeout: 10_000 }).toBe(true)
  await expect.poll(async () => await frame.locator('#cur').textContent(), { timeout: 8000 }).not.toBe('0:00')
  await frame.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => isPlaying(page), { timeout: 8000 }).toBe(false)
})

test('Music queues the audio around the song and steps between them', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${AUDIO}/set-a.wav`, wavBytes())
  await put(desktop, `${AUDIO}/set-b.wav`, wavBytes())
  await open(desktop, `${AUDIO}/set-a.wav`)
  const win = () => desktop.win(/set-(a|b)\.wav/)
  // the launch boots the app and decodes before the window carries the song's name
  await expect(win()).toBeVisible({ timeout: 15_000 })
  const frame = win().frameLocator('iframe')
  await expect(frame.locator('#title')).toHaveText('set-a.wav')
  await expect(frame.locator('#queue .qrow')).toHaveCount(2)
  await expect(frame.locator('#queue .qrow.cur', { hasText: 'set-a.wav' })).toBeVisible()

  // pick the other song from the queue; the window is then about set-b.wav
  await frame.locator('#queue .qrow', { hasText: 'set-b.wav' }).click()
  await expect(frame.locator('#title')).toHaveText('set-b.wav')
  await expect(frame.locator('#queue .qrow.cur', { hasText: 'set-b.wav' })).toBeVisible()

  // Next Track wraps around the queue without spawning a window
  await page.keyboard.press('Meta+ArrowRight')
  await expect(frame.locator('#title')).toHaveText('set-a.wav')
  await expect(desktop.windows().filter({ hasText: /set-(a|b)\.wav/ })).toHaveCount(1)
})

test('QuickTime plays what it is given, and refuses a codec it does not have', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${AUDIO}/tone2.wav`, wavBytes())
  await open(desktop, `${AUDIO}/tone2.wav`, 'org.tiny.quicktime')
  const win = () => desktop.win('tone2.wav')
  // the launch boots the app and reads the movie before the window carries its name
  await expect(win()).toBeVisible({ timeout: 15_000 })
  const frame = win().frameLocator('iframe')
  await expect(frame.locator('#rest')).toHaveText('-0:06')
  await expect(frame.locator('#play')).toBeEnabled()
  await frame.locator('#play').click()
  await expect
    .poll(async () => await frame.locator('#video').evaluate((v: HTMLVideoElement) => v.currentTime > 0), { timeout: 8000 })
    .toBe(true)
  await expect(frame.locator('#help')).toBeHidden()

  // a container the browser cannot decode: the sheet names the extension, and the window,
  // having nothing to show, is back to its empty state and its default name
  await put(desktop, `${AUDIO}/broken.mp4`, textBytes('this is not an mp4'))
  await open(desktop, `${AUDIO}/broken.mp4`, 'org.tiny.quicktime')
  const qt = () => desktop.win('QuickTime Player')
  await expect(qt()).toBeVisible({ timeout: 15_000 })
  const sheet = qt().locator('.sheet')
  await expect(sheet).toContainText('could not be opened')
  await expect(sheet).toContainText('MP4')
  await sheet.getByRole('button', { name: 'OK' }).click()
  await expect(qt().frameLocator('iframe').locator('#empty')).toBeVisible()
})

test('files of every kind carry a type icon in Finder and in the Open panel', async ({ desktop }) => {
  const { page } = desktop
  await put(desktop, `${DOCS}/song.mp3`, textBytes('audio-ish bytes'))
  await put(desktop, `${DOCS}/clip.mp4`, textBytes('video-ish bytes'))
  await put(desktop, `${DOCS}/note.txt`, textBytes('text bytes'))

  await desktop.dock('org.tiny.finder').click()
  // the Finder frame is titled by the app name; the window itself follows the folder
  const finder = page.frameLocator('iframe[title="Finder"]').first()
  await expect(finder.locator('#sidebar')).toBeVisible({ timeout: 15_000 })
  await finder.locator('#sidebar .item', { hasText: 'Documents' }).click()
  for (const name of ['song.mp3', 'clip.mp4', 'note.txt'])
    await expect(finder.locator('#files .item', { hasText: name })).toBeVisible()

  // the art is a data URL the frame paints from the type hierarchy: decode it back
  const artOf = (name: string) =>
    finder
      .locator('#files .item', { hasText: name })
      .first()
      .locator('img')
      .first()
      .evaluate((i) => {
        const src = (i as HTMLImageElement).getAttribute('src') ?? ''
        return /data:image\/svg\+xml;base64/.test(src) ? atob((src.split(',')[1] ?? '').replace(/\s/g, '')) : src
      })
  await expect.poll(() => artOf('song.mp3'), 'audio artwork').toContain('ti-audio')
  await expect.poll(() => artOf('clip.mp4'), 'video artwork').toContain('ti-video')
  await expect.poll(() => artOf('note.txt'), 'text artwork').toContain('ti-text')

  // the Open panel Desktop draws for Music: same marks next to the names
  await page.evaluate(() => void window.tiny!.apps.launch('org.tiny.music'))
  const music = page.frameLocator('iframe[title="Music"]').first()
  await expect(music.locator('#now')).toBeVisible({ timeout: 20_000 })
  await music.locator('#now').click() // nothing loaded: the cover button opens File > Open
  const sheet = page.locator('.sheet.picker')
  await expect(sheet, 'the Open panel over Music').toBeVisible()
  const slotOf = (name: string) => sheet.locator('.entry', { hasText: name }).first().innerHTML()
  await expect.poll(() => slotOf('song.mp3'), 'audio in the panel').toContain('ti-audio')
  await expect.poll(() => slotOf('note.txt'), 'text in the panel').toContain('ti-text')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})
