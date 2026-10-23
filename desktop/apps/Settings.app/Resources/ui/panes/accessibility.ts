import { tiny } from '@tiny/sdk'
import { attempt, cfgList, cfgSet, group, h, line, slider, toggle, type Pane } from '../lib'

const set = (key: string, v: string | number | boolean) => attempt(() => cfgSet('tiny.system', key, v))

export const accessibility: Pane = {
  id: 'accessibility', title: 'Accessibility', icon: '♿', color: '#0a84ff', keywords: 'vision motion contrast text size transparency screen reader announce',
  async render(root) {
    const [s, prefs] = await Promise.all([cfgList('tiny.system'), tiny.system.info('accessibilityPrefs').catch(() => null)])
    root.append(h('div', { class: 'pane' },
      group('Vision',
        line('Text size', slider('Text size', { min: 0.8, max: 1.4, step: 0.05, value: s.textScale }, (v) => set('textScale', v), (v) => `${Math.round(v * 100)}%`)),
        line('Increase contrast', toggle('Increase contrast', s.highContrast, (v) => set('highContrast', v))),
        line('Reduce transparency', toggle('Reduce transparency in Accessibility', s.reduceTransparency, (v) => set('reduceTransparency', v)))),
      group('Motion', line('Reduce motion', toggle('Reduce motion in Accessibility', s.reduceMotion, (v) => set('reduceMotion', v)))),
      prefs ? group('Currently in effect', Object.entries(prefs as Record<string, unknown>).map(([key, v]) => line(key, h('span', { class: 'val' }, String(v))))) : null,
      h('p', { class: 'dim' }, 'Every control in Pear can be used with the keyboard. Press Tab to move between controls.')))
  },
}
