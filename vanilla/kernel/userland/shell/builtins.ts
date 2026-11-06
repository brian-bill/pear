/// More builtins: printf, getopts, declare/typeset/readonly, let, pushd/popd/dirs, hash, command -v/-V, type flags.
/// `Shell.builtin` falls through to `extraBuiltin` for any name in `EXTRA`.
import { evalArith } from './arith'
import type { Io, Shell } from './shell'
import { reason } from '../lib'
import { format, shellQuote, splitWords, unescape } from './escapes'
import { arrayKeys, type ShellArray } from './expand'
export { format, shellQuote, unescape }

export const EXTRA = new Set(['printf', 'getopts', 'declare', 'typeset', 'readonly', 'let', 'pushd', 'popd', 'dirs', 'hash', 'command', 'exec', 'shopt', 'umask', 'ulimit', 'times', 'builtin', 'enable', 'mapfile', 'readarray'])

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/

// ----------------------------------------------------------------------------------------------------- printf

// ---------------------------------------------------------------------------------------------- the builtins

function hasShell(sh: Shell, name: string): string | null {
  if (sh.aliases.has(name)) return `alias`
  if (sh.functions.has(name)) return 'function'
  return null
}

export async function extraBuiltin(sh: Shell, name: string, args: string[], io: Io, builtins: Set<string>): Promise<number> {
  switch (name) {
    case 'printf': {
      let rest = args
      let into: string | null = null
      if (rest[0] === '-v') {
        into = rest[1] ?? ''
        if (!ID.test(into)) {
          await io.err(`printf: \`${into}': not a valid identifier\n`)
          return 2
        }
        rest = rest.slice(2)
      }
      if (rest[0] === '--') rest = rest.slice(1)
      if (!rest.length) {
        await io.err('printf: usage: printf [-v var] format [arguments]\n')
        return 2
      }
      const r = format(rest[0]!, rest.slice(1))
      for (const e of r.errors) await io.err(`printf: ${e}\n`)
      if (into) sh.setVar(into, r.out, sh.exported.has(into))
      else await io.out(r.out)
      return r.errors.length ? 1 : 0
    }

    case 'getopts': {
      if (args.length < 2) {
        await io.err('getopts: usage: getopts optstring name [arg ...]\n')
        return 2
      }
      const [optstring, varName] = args as [string, string]
      const list = args.length > 2 ? args.slice(2) : sh.positional
      const silent = optstring.startsWith(':')
      const spec = silent ? optstring.slice(1) : optstring
      let optind = Number(sh.get('OPTIND') ?? '1')
      if (!Number.isInteger(optind) || optind < 1) optind = 1
      if (optind !== sh.getoptsExpect) sh.getoptsPos = 1
      const done = (): number => {
        sh.setVar(varName, '?')
        sh.setVar('OPTIND', String(optind))
        sh.getoptsExpect = optind
        return 1
      }
      const word = list[optind - 1]
      if (word === undefined || word === '-' || !word.startsWith('-')) return done()
      if (word === '--') {
        optind++
        return done()
      }
      const ch = word[sh.getoptsPos]!
      const at = spec.indexOf(ch)
      let result = ch
      sh.vars.delete('OPTARG')
      const advance = () => {
        if (sh.getoptsPos + 1 >= word.length) {
          optind++
          sh.getoptsPos = 1
        } else sh.getoptsPos++
      }
      if (at < 0 || ch === ':') {
        if (silent) sh.setVar('OPTARG', ch)
        else await io.err(`${sh.scriptName}: illegal option -- ${ch}\n`)
        result = '?'
        advance()
      } else if (spec[at + 1] === ':') {
        if (sh.getoptsPos + 1 < word.length) {
          sh.setVar('OPTARG', word.slice(sh.getoptsPos + 1))
          optind++
          sh.getoptsPos = 1
        } else if (list[optind] !== undefined) {
          sh.setVar('OPTARG', list[optind]!)
          optind += 2
          sh.getoptsPos = 1
        } else {
          if (silent) {
            sh.setVar('OPTARG', ch)
            result = ':'
          } else {
            await io.err(`${sh.scriptName}: option requires an argument -- ${ch}\n`)
            result = '?'
          }
          optind++
          sh.getoptsPos = 1
        }
      } else advance()
      sh.setVar(varName, result)
      sh.setVar('OPTIND', String(optind))
      sh.getoptsExpect = optind
      return 0
    }

    case 'declare':
    case 'typeset':
    case 'readonly': {
      const flags = new Set<string>()
      const names: string[] = []
      let stop = false
      for (const a of args) {
        if (!stop && a === '--') stop = true
        else if (!stop && /^[-+][a-zA-Z]+$/.test(a)) for (const f of a.slice(1)) a[0] === '-' ? flags.add(f) : flags.delete(f)
        else names.push(a)
      }
      if (name === 'readonly') flags.add('r')
      if (flags.has('p') && names.some((n) => sh.arrays.has(n))) {
        for (const n of names) {
          const arr = sh.arrays.get(n)
          if (!arr) continue
          const body = arrayKeys(arr).map((k) => `[${k}]=${JSON.stringify(arr.items.get(k))}`).join(' ')
          await io.out(`declare -${arr.assoc ? 'A' : 'a'} ${n}=(${body})\n`)
        }
        return 0
      }
      if (flags.has('p') || (!names.length && name === 'readonly')) {
        const list = [...sh.vars.keys()].filter((n) => (names.length ? names.includes(n) : name === 'readonly' ? sh.readonly.has(n) : flags.has('x') ? sh.exported.has(n) : true)).sort()
        for (const n of list) {
          const attrs = `${sh.integers.has(n) ? 'i' : ''}${sh.readonly.has(n) ? 'r' : ''}${sh.exported.has(n) ? 'x' : ''}` || '-'
          await io.out(`declare -${attrs} ${n}=${shellQuote(sh.vars.get(n) ?? '')}\n`)
        }
        return 0
      }
      if (flags.has('f')) {
        for (const n of names.length ? names : [...sh.functions.keys()]) if (sh.functions.has(n)) await io.out(`${n} ()\n{\n    ...\n}\n`)
        return 0
      }
      if (!names.length) {
        for (const [k, v] of [...sh.vars].sort(([a], [b]) => (a < b ? -1 : 1))) await io.out(`${k}=${shellQuote(v)}\n`)
        return 0
      }
      const frame = name !== 'readonly' && !flags.has('g') ? sh.locals[sh.locals.length - 1] : undefined
      let status = 0
      for (const a of names) {
        const eq = a.indexOf('=')
        const n = eq < 0 ? a : a.slice(0, eq)
        if (!ID.test(n)) {
          await io.err(`${name}: \`${a}': not a valid identifier\n`)
          status = 1
          continue
        }
        if (frame && !frame.has(n)) frame.set(n, sh.vars.get(n))
        if (flags.has('i')) sh.integers.add(n)
        let value = eq >= 0 ? a.slice(eq + 1) : undefined
        if (flags.has('a') || flags.has('A') || (value !== undefined && /^\(.*\)$/s.test(value))) {
          const assoc = flags.has('A') || (!flags.has('a') && !!sh.arrays.get(n)?.assoc)
          if (frame) {
            const fa = sh.localArrays[sh.localArrays.length - 1]
            if (fa && !fa.has(n)) fa.set(n, sh.arrays.get(n))
          }
          if (value !== undefined) sh.arrays.set(n, arrayFromText(value.replace(/^\(|\)$/g, ''), assoc))
          else if (!sh.arrays.has(n)) sh.arrays.set(n, { assoc, items: new Map() })
          sh.vars.delete(n)
          if (flags.has('r')) sh.readonly.add(n)
          continue
        }
        if (value !== undefined && (flags.has('i') || sh.integers.has(n))) value = String(evalArith(value, sh.arithEnv()))
        if (value !== undefined) sh.setVar(n, value, flags.has('x') || sh.exported.has(n))
        else if (!sh.vars.has(n) && !frame) sh.vars.set(n, '')
        if (flags.has('x')) sh.exported.add(n)
        if (flags.has('r')) sh.readonly.add(n)
      }
      return status
    }

    case 'let': {
      if (!args.length) {
        await io.err('let: expression expected\n')
        return 1
      }
      let last = 0
      for (const e of args) last = evalArith(e, sh.arithEnv())
      return last === 0 ? 1 : 0
    }

    case 'pushd':
    case 'popd':
    case 'dirs': {
      const cwd = sh.vars.get('PWD') ?? '/'
      const stack = sh.dirStack
      const show = async () => io.out(`${[sh.vars.get('PWD') ?? cwd, ...stack].join(' ')}\n`)
      const cd = async (to: string) => {
        const old = sh.vars.get('PWD') ?? '/'
        const real = await sh.tiny.chdir(to.startsWith('/') ? to : `${old}/${to}`)
        sh.setVar('OLDPWD', old, true)
        sh.setVar('PWD', real, true)
      }
      if (name === 'dirs') {
        if (args.includes('-c')) stack.length = 0
        else await show()
        return 0
      }
      if (name === 'pushd') {
        const target = args.find((a) => !a.startsWith('-'))
        if (!target) {
          if (!stack.length) {
            await io.err('pushd: no other directory\n')
            return 1
          }
          const top = stack.shift()!
          stack.unshift(cwd)
          await cd(top)
        } else {
          try {
            await cd(target)
          } catch (e) {
            await io.err(`pushd: ${target}: ${reason(e)}\n`)
            return 1
          }
          stack.unshift(cwd)
        }
        await show()
        return 0
      }
      const top = stack.shift()
      if (top === undefined) {
        await io.err('popd: directory stack empty\n')
        return 1
      }
      await cd(top)
      await show()
      return 0
    }

    case 'hash': {
      if (args[0] === '-r') return 0
      let status = 0
      for (const a of args.filter((x) => !x.startsWith('-'))) {
        if (!(await sh.findProgram(a))) {
          await io.err(`hash: ${a}: not found\n`)
          status = 1
        }
      }
      return status
    }

    case 'command': {
      // `command name args` is handled where commands start; here: -v and -V
      const flags = args.filter((a) => /^-[pvV]+$/.test(a)).join('')
      const names = args.filter((a) => !/^-[pvV]+$/.test(a))
      if (!flags.includes('v') && !flags.includes('V')) return names.length ? 127 : 0
      let status = 0
      for (const n of names) {
        const kind = hasShell(sh, n)
        const verbose = flags.includes('V')
        if (kind === 'alias') await io.out(verbose ? `${n} is aliased to \`${sh.aliases.get(n)}'\n` : `alias ${n}='${sh.aliases.get(n)}'\n`)
        else if (kind === 'function') await io.out(verbose ? `${n} is a function\n` : `${n}\n`)
        else if (builtins.has(n)) await io.out(verbose ? `${n} is a shell builtin\n` : `${n}\n`)
        else {
          const p = await sh.findProgram(n)
          if (p) await io.out(verbose ? `${n} is ${p}\n` : `${p}\n`)
          else {
            if (verbose) await io.err(`command: ${n}: not found\n`)
            status = 1
          }
        }
      }
      return status
    }

    case 'mapfile':
    case 'readarray': {
      let strip = false
      let max = Infinity
      const names: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '-t') strip = true
        else if (a === '-n') max = Number(args[++i])
        else if (a.startsWith('-')) continue
        else names.push(a)
      }
      const target = names[0] ?? 'MAPFILE'
      const items = new Map<string, string>()
      for (let n = 0; n < max; n++) {
        const got = await io.read()
        if (!got) break
        items.set(String(n), strip || !got.nl ? got.line : got.line + '\n')
      }
      sh.vars.delete(target)
      sh.arrays.set(target, { assoc: false, items })
      return 0
    }

    case 'builtin':
    case 'enable':
      return args.length ? 127 : 0

    case 'shopt': {
      // options that only matter to other shells are accepted
      return 0
    }

    case 'times':
      await io.out('0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n')
      return 0

    case 'umask':
    case 'ulimit':
      await io.err(`${name}: not supported by this system\n`)
      return 1
  }
  return 127
}

/** `a b "c d"` or `[k]=v …` as an array. */
export function arrayFromText(text: string, assoc: boolean): ShellArray {
  const items = new Map<string, string>()
  const words = splitWords(text)
  let next = 0
  let key: string | null = null
  for (const w of words) {
    const m = /^\[([^\]]*)\]=([^]*)$/.exec(w)
    if (m) {
      items.set(m[1]!, m[2]!)
      if (!assoc && /^\d+$/.test(m[1]!)) next = Number(m[1]) + 1
    } else if (assoc) {
      if (key === null) key = w
      else {
        items.set(key, w)
        key = null
      }
    } else items.set(String(next++), w)
  }
  return { assoc, items }
}
