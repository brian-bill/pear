import { tiny } from '@tiny/sdk'
import { apps, appLabel, attempt, button, cfgList, cfgSet, choose, group, h, line, say, segmented, slider, toggle, type Pane } from '../lib'

export const PRESETS: Array<[string, string, string]> = [
  ['one-piece', 'One Piece', 'url("/wallpapers/one-piece-4k.jpg")'],
  ['aurora', 'Aurora', 'linear-gradient(135deg,#0f2027,#2c7a7b 50%,#6bd0a0)'],
  ['dusk', 'Dusk', 'linear-gradient(135deg,#2b1055,#7597de 70%,#f8b195)'],
  ['graphite', 'Graphite', 'linear-gradient(135deg,#1c1c1e,#48484a)'],
  ['forest', 'Forest', 'linear-gradient(135deg,#0b3d2e,#2f7d4f 60%,#a8c66c)'],
  ['ocean', 'Ocean', 'linear-gradient(135deg,#03045e,#0077b6 55%,#90e0ef)'],
]
const dock = (key: string, value: string | number | boolean) => cfgSet('tiny.desktop.dock', key, value)
const wall = (key: string, value: string | null) => cfgSet('tiny.desktop.wallpaper', key, value)
/** What Desktop pins until the user changes the Dock (see `DEFAULT_DOCK` in desktop/src/desktop.ts). */
const DEFAULT_DOCK = ['org.tiny.profile', 'org.tiny.finder', 'org.tiny.terminal', 'org.tiny.textedit', 'org.tiny.settings']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

export const desktop: Pane = {
  id: 'desktop', title: 'Desktop & Dock', icon: '▭', color: '#0a84ff', keywords: 'dock size position hide magnification wallpaper picture background pinned apps',
  async render(root) {
    const [d, w, all] = await Promise.all([cfgList('tiny.desktop.dock'), cfgList('tiny.desktop.wallpaper'), apps()])
    const current: string | null = w.path
    // an unset path means the default wallpaper (see DEFAULT_WALLPAPER in desktop/src/shell/surface.ts)
    const DEFAULT_WALLPAPER = 'builtin:one-piece'

    const walls = h('div', { class: 'walls', role: 'group', 'aria-label': 'Wallpaper' })
    const paint = (path: string | null) => walls.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.path === (path ?? DEFAULT_WALLPAPER))))
    for (const [id, name, css] of PRESETS) {
      walls.append(h('button', { type: 'button', class: 'wall', style: `background-image:${css}`, 'data-path': `builtin:${id}`, 'aria-pressed': String((current ?? DEFAULT_WALLPAPER) === `builtin:${id}`), onclick: () => {
        paint(`builtin:${id}`)
        void attempt(() => wall('path', `builtin:${id}`))
      } }, name))
    }
    const custom = h('button', { type: 'button', class: 'wall', 'data-path': current && !current.startsWith('builtin:') ? current : '', 'aria-pressed': String(!!current && !current.startsWith('builtin:')) }, 'Picture')
    if (current && !current.startsWith('builtin:')) void tiny.readFile(current).then((b) => (custom.style.backgroundImage = `url(${URL.createObjectURL(new Blob([b as BlobPart]))})`)).catch(() => {})
    walls.append(custom)

    const pinned = h('div', { class: 'pinned' })
    const drawPinned = async () => {
      const stored: string[] = (await cfgList('tiny.desktop.dock')).items
      // while nothing is stored, Desktop shows its own default Dock
      const items = stored.length ? stored : DEFAULT_DOCK.filter((id) => all.some((a) => a.id === id))
      const save = async (next: string[]) => {
        await attempt(() => cfgSet('tiny.desktop.dock', 'items', next))
        void drawPinned()
      }
      const adder = choose('Add to Dock', [['', 'Add app…'] as [string, string], ...all.filter((a) => !items.includes(a.id)).map((a) => [a.id, a.name] as [string, string])], '', (id) => { if (id) void save([...items, id]) })
      pinned.replaceChildren(
        h('div', { class: 'group' },
          items.map((id, i) => {
            const app = all.find((a) => a.id === id)
            return h('div', { class: 'line', 'data-app': id },
              h('div', { class: 'label' }, appLabel(app ?? { id, name: id })),
              h('div', { class: 'ctl' },
                button('↑', () => save(items.map((x, j, a) => (j === i - 1 ? a[i]! : j === i ? a[i - 1]! : x))), 'icon', { 'aria-label': `Move ${app?.name ?? id} up`, disabled: i === 0 }),
                button('↓', () => save(items.map((x, j, a) => (j === i + 1 ? a[i]! : j === i ? a[i + 1]! : x))), 'icon', { 'aria-label': `Move ${app?.name ?? id} down`, disabled: i === items.length - 1 }),
                button('Remove', () => save(items.filter((x) => x !== id)), 'plain', { 'aria-label': `Remove ${app?.name ?? id} from the Dock` })))
          }),
          line('', adder)),
      )
    }
    await drawPinned()

    root.append(h('div', { class: 'pane' },
      group('Dock',
        line('Size', slider('Dock size', { min: 32, max: 96, step: 1, value: d.size }, (v) => dock('size', v), (v) => `${v} px`)),
        line('Position', segmented('Dock position', [['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']], d.position, (v) => dock('position', v))),
        line('Automatically hide', toggle('Automatically hide the Dock', d.autohide, (v) => dock('autohide', v))),
        line('Magnification', toggle('Magnification', d.magnification, (v) => dock('magnification', v)))),
      group('Wallpaper', h('div', { class: 'line col' },
        walls,
        h('div', { class: 'row' },
          button('Choose Picture…', async () => {
            const picked = await tiny.dialogs.openFile({ title: 'Choose a picture', filters: [{ name: 'Images', ext: IMAGE_EXT }] })
            if (!picked?.[0]) return
            await attempt(() => wall('path', picked[0]!), 'Wallpaper changed.')
            custom.dataset.path = picked[0]
            paint(picked[0])
            custom.style.backgroundImage = `url(${URL.createObjectURL(new Blob([(await tiny.readFile(picked[0]!)) as BlobPart]))})`
          }),
          button('Default', async () => {
            await attempt(() => wall('path', null))
            paint(null)
          }, 'plain'),
          h('span', { class: 'grow' }),
          choose('Wallpaper fit', [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch'], ['center', 'Center'], ['tile', 'Tile']], w.fit, (v) => attempt(() => cfgSet('tiny.desktop.wallpaper', 'fit', v))))) ),
      h('section', null, h('h2', null, 'Pinned apps'), pinned),
    ))
    say('')
  },
}
