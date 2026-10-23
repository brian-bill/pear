import { tiny } from '@tiny/sdk'
import { attempt, cfgList, cfgSet, choose, group, h, line, sys, type Pane } from '../lib'

const NAMES: Record<string, string> = { us: 'U.S.', uk: 'British', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', dvorak: 'Dvorak', colemak: 'Colemak' }
const SHORTCUTS: Array<[string, string]> = [
  ['Cmd+W', 'Close window'], ['Cmd+M', 'Minimize window'], ['Cmd+`', 'Switch windows of the app'], ['Cmd+Q', 'Quit app'],
  ['Alt+Tab', 'Switch app'], ['Alt+Space', 'Open the launcher'], ['Cmd+,', 'Open System Settings'], ['Cmd+S', 'Save (in apps with documents)'],
]

export const keyboard: Pane = {
  id: 'keyboard', title: 'Keyboard', icon: '⌨', color: '#8e8e93', keywords: 'layout input cmd command key mapping shortcuts',
  async render(root) {
    const [layouts, input, reserved] = await Promise.all([
      tiny.service<{ layouts: string[]; current: string }>('tiny.input', { op: 'layouts' }),
      cfgList('tiny.input'),
      tiny.service<any>('tiny.input', { op: 'reserved' }).catch(() => null),
    ])
    root.append(h('div', { class: 'pane' },
      group('Input',
        line('Keyboard layout', choose('Keyboard layout', layouts.layouts.map((l) => [l, NAMES[l] ?? l] as [string, string]), layouts.current, (id) => attempt(() => sys('tiny.input', { op: 'setKeyboardLayout', id })))),
        line('Command key', choose('Command key mapping', [['auto', 'Automatic'], ['meta', 'Cmd (Meta)'], ['ctrl', 'Ctrl']], input.cmdMapping, (v) => attempt(() => cfgSet('tiny.input', 'cmdMapping', v))), 'Which key on your keyboard acts as Cmd.')),
      group('Desktop shortcuts',
        SHORTCUTS.map(([keys, what]) => line(what, h('kbd', null, keys)))),
      reserved?.shortcuts ? group('Browser shortcuts', line('Kept by the browser', h('span', { class: 'val' }, (reserved.shortcuts as string[]).join(', ')), reserved.keyboardLock ? 'Keyboard lock is on, so Desktop gets them.' : 'Desktop cannot use these unless the browser lets it.')) : null))
  },
}
