import { cfgList, cfgSet, group, h, line, segmented, slider, toggle, type Pane } from '../lib'

const ACCENTS: Array<[string, string]> = [
  ['blue', '#0a84ff'], ['purple', '#bf5af2'], ['pink', '#ff375f'], ['red', '#ff453a'], ['orange', '#ff9f0a'], ['green', '#30d158'], ['graphite', '#8e8e93'],
]
const set = (key: string, value: string | number | boolean) => cfgSet('tiny.system', key, value)

export const appearance: Pane = {
  id: 'appearance', title: 'Appearance', icon: '◐', color: '#5e5ce6', keywords: 'theme light dark auto accent color motion transparency text size contrast',
  async render(root) {
    const s = await cfgList('tiny.system')
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent color' })
    for (const [name, color] of ACCENTS) {
      swatches.append(h('button', { type: 'button', class: 'swatch', style: `background:${color}`, title: name, 'aria-label': name, 'aria-pressed': String(s.accentColor === name), onclick: () => {
        swatches.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.title === name)))
        void set('accentColor', name)
      } }))
    }
    root.append(
      h('div', { class: 'pane' },
        group(null,
          line('Appearance', segmented('Appearance', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']], s.appearance, (v) => set('appearance', v))),
          line('Accent color', swatches),
          line('Text size', slider('Text size', { min: 0.8, max: 1.4, step: 0.05, value: s.textScale }, (v) => set('textScale', v), (v) => `${Math.round(v * 100)}%`))),
        group('Display',
          line('Reduce motion', toggle('Reduce motion', s.reduceMotion, (v) => set('reduceMotion', v)), 'Limits animations in windows and the Dock.'),
          line('Reduce transparency', toggle('Reduce transparency', s.reduceTransparency, (v) => set('reduceTransparency', v)), 'Makes windows and menus opaque.'),
          line('Increase contrast', toggle('High contrast', s.highContrast, (v) => set('highContrast', v)), 'Stronger borders and text.'))),
    )
  },
}
