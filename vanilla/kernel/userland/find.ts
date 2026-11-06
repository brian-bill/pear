import { joinPath, main, reason, type Pear } from './lib'

type St = Awaited<ReturnType<Pear['lstat']>>
type Ctx = { path: string; st: St; depth: number; root: string }
type Expr = (c: Ctx) => Promise<boolean>

const glob = (pat: string, flags = ''): RegExp => {
  let re = '^'
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = pat.indexOf(']', i + 2)
      if (end < 0) re += '\\['
      else {
        let body = pat.slice(i + 1, end)
        const neg = body[0] === '!' || body[0] === '^'
        if (neg) body = body.slice(1)
        re += `[${neg ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        i = end
      }
    } else if (c === '\\') re += (pat[++i] ?? '\\').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else re += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
  }
  return new RegExp(`${re}$`, `s${flags}`)
}

const sizeTest = (spec: string): ((bytes: number) => boolean) => {
  const m = /^([+-]?)(\d+)([ckMGb]?)$/.exec(spec)
  if (!m) throw new Error(`invalid size: ${spec}`)
  const unit = { '': 512, b: 512, c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[3] as '' | 'b' | 'c' | 'k' | 'M' | 'G']
  const n = Number(m[2])
  return (bytes) => {
    const blocks = Math.ceil(bytes / unit)
    return m[1] === '+' ? blocks > n : m[1] === '-' ? blocks < n : blocks === n
  }
}

export default function (tiny: Pear): Promise<number> {
  return main('find', tiny, async () => {
    const args = [...tiny.args]
    const roots: string[] = []
    while (args.length && !args[0]!.startsWith('-') && args[0] !== '(' && args[0] !== '!') roots.push(args.shift()!)
    if (!roots.length) roots.push('.')
    let maxDepth = Infinity
    let minDepth = 0
    let acted = false
    let status = 0
    const out: string[] = []
    const pruned = new Set<string>()

    let at = 0
    const peek = () => args[at]
    const need = (what: string): string => {
      const v = args[at++]
      if (v === undefined) throw new Error(`missing argument to ${what}`)
      return v
    }
    const primary = (): Expr => {
      const tok = args[at++]!
      switch (tok) {
        case '(': {
          const e = or()
          if (args[at++] !== ')') throw new Error('unmatched (')
          return e
        }
        case '!': case '-not': {
          const e = primary()
          return async (c) => !(await e(c))
        }
        case '-name': { const re = glob(need(tok)); return async (c) => re.test(c.path.split('/').pop() || c.path) }
        case '-iname': { const re = glob(need(tok), 'i'); return async (c) => re.test(c.path.split('/').pop() || c.path) }
        case '-path': case '-wholename': { const re = glob(need(tok)); return async (c) => re.test(c.path) }
        case '-ipath': { const re = glob(need(tok), 'i'); return async (c) => re.test(c.path) }
        case '-regex': { const re = new RegExp(`^${need(tok)}$`); return async (c) => re.test(c.path) }
        case '-type': {
          const t = need(tok)
          const kind = { f: 'file', d: 'dir', l: 'symlink' }[t]
          if (!kind) throw new Error(`unknown type: ${t}`)
          return async (c) => c.st.kind === kind
        }
        case '-maxdepth': maxDepth = Number(need(tok)); return async () => true
        case '-mindepth': minDepth = Number(need(tok)); return async () => true
        case '-empty':
          return async (c) => (c.st.kind === 'dir' ? (await tiny.readdir(c.path)).length === 0 : c.st.kind === 'file' && c.st.size === 0)
        case '-size': { const t = sizeTest(need(tok)); return async (c) => c.st.kind === 'file' && t(c.st.size) }
        case '-mtime': case '-atime': case '-ctime': {
          const m = /^([+-]?)(\d+)$/.exec(need(tok))
          if (!m) throw new Error('invalid time')
          const field = tok === '-mtime' ? 'mtime' : tok === '-atime' ? 'atime' : 'ctime'
          return async (c) => {
            const days = Math.floor((Date.now() - c.st[field]) / 86400000)
            return m[1] === '+' ? days > Number(m[2]) : m[1] === '-' ? days < Number(m[2]) : days === Number(m[2])
          }
        }
        case '-mmin': {
          const m = /^([+-]?)(\d+)$/.exec(need(tok))!
          return async (c) => {
            const mins = Math.floor((Date.now() - c.st.mtime) / 60000)
            return m[1] === '+' ? mins > Number(m[2]) : m[1] === '-' ? mins < Number(m[2]) : mins === Number(m[2])
          }
        }
        case '-newer': { const ref = tiny.stat(need(tok)); return async (c) => c.st.mtime > (await ref).mtime }
        case '-perm': {
          const spec = need(tok)
          const mode = parseInt(spec.replace(/^[-/]/, ''), 8)
          return async (c) => (spec[0] === '-' ? (c.st.mode & mode) === mode : (c.st.mode & 0o7777) === mode)
        }
        case '-user': case '-group': need(tok); return async () => true
        case '-prune': return async (c) => (pruned.add(c.path), true)
        case '-print': case '-print0': acted = true; return async (c) => (out.push(c.path + (tok === '-print0' ? '\0' : '\n')), true)
        case '-delete':
          acted = true
          return async (c) => {
            try {
              if (c.st.kind === 'dir') await tiny.rmdir(c.path)
              else await tiny.unlink(c.path)
            } catch (e) {
              await tiny.stderr.write(`find: ${c.path}: ${reason(e)}\n`)
              status = 1
            }
            return true
          }
        case '-exec': case '-execdir': case '-ok': {
          const cmd: string[] = []
          let batch = false
          for (;;) {
            const a = args[at++]
            if (a === undefined) throw new Error('missing argument to -exec')
            if (a === ';') break
            if (a === '+' && cmd[cmd.length - 1] === '{}') { batch = true; break }
            cmd.push(a)
          }
          acted = true
          if (batch) {
            const paths: string[] = []
            pending.push(async () => {
              if (paths.length) await run([...cmd.slice(0, -1), ...paths])
            })
            return async (c) => (paths.push(c.path), true)
          }
          return async (c) => (await run(cmd.map((a) => a.split('{}').join(c.path)))) === 0
        }
        case '-true': return async () => true
        case '-false': return async () => false
        default:
          throw new Error(`unknown predicate: ${tok}`)
      }
    }
    const pending: Array<() => Promise<void>> = []
    const run = async (argv: string[]): Promise<number> => {
      if (out.length) {
        await tiny.stdout.write(out.join(''))
        out.length = 0
      }
      const pid = await tiny.spawn('/bin/sh', { args: ['-c', 'exec "$@"', 'find', ...argv], stdio: { stdin: 'null', stdout: 'inherit', stderr: 'inherit' } })
      return (await tiny.wait(pid)).code ?? 1
    }
    const and = (): Expr => {
      let e = primary()
      while (at < args.length && peek() !== '-o' && peek() !== ')') {
        if (peek() === '-a' || peek() === '-and') at++
        const l = e
        const r = primary()
        e = async (c) => (await l(c)) && (await r(c))
      }
      return e
    }
    const or = (): Expr => {
      let e = and()
      while (peek() === '-o' || peek() === '-or') {
        at++
        const l = e
        const r = and()
        e = async (c) => (await l(c)) || (await r(c))
      }
      return e
    }
    let expr: Expr
    if (args.length) {
      expr = or()
      if (at < args.length) throw new Error(`unexpected '${args[at]}'`)
    } else expr = async () => true
    const print: Expr = async (c) => (out.push(c.path + '\n'), true)
    const prim = args.length ? expr : print
    const final: Expr = acted || !args.length ? prim : async (c) => ((await expr(c)) ? (out.push(c.path + '\n'), true) : false)

    const visit = async (path: string, depth: number, root: string): Promise<void> => {
      let st: St
      try {
        st = await tiny.lstat(path)
      } catch (e) {
        await tiny.stderr.write(`find: ${path}: ${reason(e)}\n`)
        status = 1
        return
      }
      const ctx: Ctx = { path, st, depth, root }
      if (depth >= minDepth) await final(ctx)
      if (out.length > 200) {
        await tiny.stdout.write(out.join(''))
        out.length = 0
      }
      if (st.kind === 'dir' && depth < maxDepth && !pruned.has(path)) {
        let names: string[] = []
        try {
          names = (await tiny.readdir(path)).map((e) => e.name).sort()
        } catch (e) {
          await tiny.stderr.write(`find: ${path}: ${reason(e)}\n`)
          status = 1
        }
        for (const n of names) await visit(joinPath(path, n), depth + 1, root)
      }
    }
    for (const r of roots) await visit(r, 0, r)
    for (const p of pending) await p()
    if (out.length) await tiny.stdout.write(out.join(''))
    return status
  })
}
