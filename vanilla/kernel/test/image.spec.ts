/** Disk images: export the hierarchy to one file and import it back. */
import { expect, test } from './fixtures'

test.use({ system: true })

/** Build a small tree with every kind of entry and attribute the image has to carry. */
const populate = async () => {
  const k = window.kernel
  const enc = new TextEncoder()
  await k.mkdir('/Users/pear/Documents/Sub', { recursive: true })
  await k.writeFile('/Users/pear/Documents/hello.txt', enc.encode('hello'))
  await k.writeFile('/Users/pear/Documents/Sub/bin', new Uint8Array(70000).map((_, i) => (i * 7) & 0xff))
  await k.writeFile('/Users/pear/Documents/empty', new Uint8Array(0))
  await k.symlink('hello.txt', '/Users/pear/Documents/link')
  await k.chown('/Users/pear/Documents/hello.txt', 501, 20)
  await k.chmod('/Users/pear/Documents/hello.txt', 0o640)
  await k.chmod('/Users/pear/Documents/Sub', 0o500)
  await k.utimes('/Users/pear/Documents/hello.txt', 1_000_000, 2_000_000)
  await k.setxattr('/Users/pear/Documents/hello.txt', 'com.apple.tag', 'red')
  await k.writeFile('/tmp/scratch', enc.encode('scratch'))
}

/** A compact description of a tree, for comparing before and after. */
const describe = async (root: string) => {
  const k = window.kernel
  const out: string[] = []
  const walk = async (p: string) => {
    const st = await k.lstat(p)
    const x = await Promise.all((await k.listxattr(p)).map(async (n) => `${n}=${await k.getxattr(p, n)}`))
    let extra = ''
    if (st.kind === 'file') {
      const data = await k.readFile(p)
      extra = ` ${data.length} ${data.reduce((a, b) => (a * 31 + b) >>> 0, 7)}`
    }
    if (st.kind === 'symlink') extra = ` -> ${await k.readlink(p)}`
    out.push(`${p} ${st.kind} ${st.mode.toString(8)} ${st.uid}:${st.gid}${st.kind === 'symlink' ? '' : ` m${st.mtime}`}${extra} ${x.join(',')}`)
    if (st.kind === 'dir') for (const e of await k.readdir(p)) await walk(`${p === '/' ? '' : p}/${e.name}`)
  }
  await walk(root)
  return out
}

test('an image round-trips files, folders, links, owners, modes, times and attributes', async ({ page }) => {
  const out = await page.evaluate(async ([populateSrc, describeSrc]) => {
    const populate = eval(populateSrc) as () => Promise<void>
    const describe = eval(describeSrc) as (r: string) => Promise<string[]>
    const k = window.kernel
    await populate()
    const before = await describe('/Users')
    const image = await k.imageCreate({ include: ['/Users'] })
    const info = await k.imageVerify(image)
    await k.removeAll('/Users/pear/Documents')
    await k.removeAll('/Users/pear/Library')
    const gone = await describe('/Users')
    const res = await k.imageRestore(image, { mode: 'merge' })
    const after = await describe('/Users')
    return { before, gone, after, info, res, plain: (await k.imageVerify(await k.imageCreate({ include: ['/Users'], compress: false }))).compressed }
  }, [`(${populate})`, `(${describe})`] as const)
  expect(out.after).toEqual(out.before)
  expect(out.gone.length).toBeLessThan(out.before.length)
  expect(out.before.join('\n')).toContain('hello.txt file 640 501:20 m2000000')
  expect(out.before.join('\n')).toContain('com.apple.tag=red')
  expect(out.before.join('\n')).toContain('link symlink')
  expect(out.info).toMatchObject({ ok: true, version: 1, osVersion: '1.0', roots: ['/Users'], compressed: true })
  expect(out.info.entries).toBeGreaterThan(10)
  expect(out.info.bytes).toBe(5 + 70000)
  expect(out.res).toMatchObject({ files: 3, symlinks: 1, skipped: {}, restartRequired: false })
  expect(out.plain).toBe(false)
})

test('the default image leaves out scratch space and mounted volumes; include/exclude narrow it', async ({ page, ns }) => {
  const out = await page.evaluate(async ([populateSrc, ns]) => {
    const populate = eval(populateSrc) as () => Promise<void>
    const k = window.kernel
    await populate()
    const root = await navigator.storage.getDirectory()
    const h = await root.getDirectoryHandle(`host-${ns}`, { create: true })
    await k.mount(h, '/Volumes/H')
    await k.writeFile('/Volumes/H/onhost', new Uint8Array([1]))
    const names = async (img: Blob) => {
      await k.removeAll('/Users/pear/Documents') // restore into a clean place and see what shows up
      await k.removeAll('/tmp/scratch').catch(() => {})
      await k.imageRestore(img, { mode: 'merge' })
      return {
        tmp: await k.exists('/tmp/scratch'), docs: await k.exists('/Users/pear/Documents/hello.txt'), host: await k.exists('/Volumes/H/onhost'),
        marker: await k.exists('/var/db/.session'),
      }
    }
    const everything = await k.imageCreate()
    const docsOnly = await k.imageCreate({ include: ['/Users/pear/Documents'], exclude: ['/Users/pear/Documents/Sub'] })
    const res = {
      all: await names(everything),
      info: await k.imageVerify(docsOnly),
      docs: await names(docsOnly),
      subGone: !(await k.exists('/Users/pear/Documents/Sub/bin')),
    }
    await k.unmount('/Volumes/H')
    await root.removeEntry(`host-${ns}`, { recursive: true })
    return res
  }, [`(${populate})`, ns] as const)
  // /tmp and the session marker are not in the default image, and a restore does not remove them either
  expect(out.all).toEqual({ tmp: false, docs: true, host: true, marker: true })
  expect(out.info).toMatchObject({ ok: true, roots: ['/Users/pear/Documents'] })
  expect(out.docs.docs).toBe(true)
  expect(out.subGone).toBe(true)
})

test('replace needs confirmation, wipes first, and asks for a restart', async ({ page }) => {
  const out = await page.evaluate(async ([populateSrc]) => {
    const populate = eval(populateSrc) as () => Promise<void>
    const k = window.kernel
    const enc = new TextEncoder()
    await populate()
    const image = await k.imageCreate({ include: ['/Users'] })
    await k.writeFile('/Users/pear/Documents/new-since.txt', enc.encode('after the backup'))
    await k.removeAll('/Users/pear/Documents/Sub')
    const events: string[] = []
    k.onEvent((e) => e.type === 'image' && e.event === 'restored' && events.push(`${e.mode}:${e.restartRequired}`))
    const unconfirmed = await k.imageRestore(image, { mode: 'replace' }).catch((e) => e.code)
    const untouched = await k.exists('/Users/pear/Documents/new-since.txt')
    const res = await k.imageRestore(image, { mode: 'replace', confirm: true })
    const procs = (await k.listProcesses()).filter((p) => p.state === 'running').length
    return {
      unconfirmed, untouched, res, events, procs,
      newGone: !(await k.exists('/Users/pear/Documents/new-since.txt')),
      subBack: await k.exists('/Users/pear/Documents/Sub/bin'),
      sys: await k.exists('/etc/passwd'),
    }
  }, [`(${populate})`] as const)
  expect(out.unconfirmed).toBe('EPERM')
  expect(out.untouched).toBe(true)
  expect(out.res).toMatchObject({ restartRequired: true, skipped: {} })
  expect(out.events).toEqual(['replace:true'])
  expect(out.procs).toBe(0)
  expect(out.newGone).toBe(true)
  expect(out.subBack).toBe(true)
  expect(out.sys).toBe(true)
})

test('damaged, truncated, foreign and too-new images are refused before anything changes', async ({ page }) => {
  const out = await page.evaluate(async ([populateSrc]) => {
    const populate = eval(populateSrc) as () => Promise<void>
    const k = window.kernel
    await populate()
    const image = await k.imageCreate({ include: ['/Users/pear/Documents'] })
    const bytes = new Uint8Array(await image.arrayBuffer())
    const flip = bytes.slice()
    flip[Math.floor(flip.length / 2)]! ^= 0xff
    const newer = bytes.slice()
    new DataView(newer.buffer).setUint16(8, 99, true)
    const res: Record<string, unknown> = {}
    const cases: Record<string, Blob> = {
      flipped: new Blob([flip]), truncated: new Blob([bytes.slice(0, bytes.length - 40)]), newer: new Blob([newer]),
      foreign: new Blob(['just some text, long enough to have a header and a trailer in it']), tiny: new Blob(['x']),
    }
    for (const [name, blob] of Object.entries(cases)) {
      const info = await k.imageVerify(blob)
      res[name] = [info.ok, info.error]
      res[`${name}Restore`] = await k.imageRestore(blob, { mode: 'replace', confirm: true }).catch((e) => e.code)
    }
    res.stillThere = await k.exists('/Users/pear/Documents/hello.txt')
    res.procs = (await k.listProcesses()).filter((p) => p.state === 'running').length > 0
    return res
  }, [`(${populate})`] as const)
  expect(out.flipped).toEqual([false, expect.stringContaining('checksum')])
  expect(out.truncated).toEqual([false, expect.stringMatching(/incomplete|damaged/)])
  expect(out.newer).toEqual([false, expect.stringContaining('version 99')])
  expect((out.foreign as unknown[])[0]).toBe(false)
  expect((out.tiny as unknown[])[0]).toBe(false)
  expect(out.flippedRestore).toBe('EIO')
  expect(out.newerRestore).toBe('EINVAL')
  expect(out.foreignRestore).toBe('EINVAL')
  expect(out.stillThere).toBe(true)
  expect(out.procs).toBe(true) // a refused replace did not end the services
})

test('merge keeps what is there, overwrites files, and reports what cannot be placed', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    await k.mkdir('/tmp/img/dir', { recursive: true })
    await k.writeFile('/tmp/img/file', enc.encode('from image'))
    await k.writeFile('/tmp/img/dir/inner', enc.encode('inner'))
    await k.writeFile('/tmp/img/ln-target', enc.encode('t'))
    const image = await k.imageCreate({ include: ['/tmp/img'] })
    await k.writeFile('/tmp/img/file', enc.encode('changed since'))
    await k.writeFile('/tmp/img/extra', enc.encode('extra'))
    await k.removeAll('/tmp/img/dir')
    await k.writeFile('/tmp/img/dir', enc.encode('a file where the image has a folder'))
    const res = await k.imageRestore(image, { mode: 'merge' })
    return {
      res, file: dec.decode(await k.readFile('/tmp/img/file')), extra: await k.exists('/tmp/img/extra'),
      dir: (await k.stat('/tmp/img/dir')).kind, restored: await k.exists('/tmp/img/ln-target'),
    }
  })
  expect(out.file).toBe('from image')
  expect(out.extra).toBe(true)
  expect(out.dir).toBe('file')
  expect(out.restored).toBe(true)
  expect(Object.keys(out.res.skipped)).toContain('/tmp/img/dir')
  expect(Object.keys(out.res.skipped)).toContain('/tmp/img/dir/inner')
  expect(out.res.restartRequired).toBe(false)
})

test('progress events arrive and an export can be canceled', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    for (let i = 0; i < 1000; i++) await k.writeFile(`/tmp/f${i}`, enc.encode(`file ${i}`))
    const progress: number[] = []
    const off = k.onEvent((e) => e.type === 'image' && e.event === 'progress' && progress.push(e.entries))
    await k.imageCreate({ include: ['/tmp'] })
    const first = progress.slice()
    // cancel on the first progress event
    const unsub = k.onEvent((e) => e.type === 'image' && e.event === 'progress' && void k.imageCancel())
    const err = await k.imageCreate({ include: ['/tmp'] }).catch((e) => e.code)
    off()
    unsub()
    return { first, err }
  })
  expect(out.first.length).toBeGreaterThanOrEqual(3)
  expect(out.first[0]).toBe(50)
  expect(out.err).toBe('ECANCELED')
})
