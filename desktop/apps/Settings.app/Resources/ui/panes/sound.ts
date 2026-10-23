import { apps, attempt, button, cfgList, group, h, line, slider, sys, toggle, type Pane } from '../lib'

const A = 'tiny.audio'

export const sound: Pane = {
  id: 'sound', title: 'Sound', icon: '♪', color: '#ff375f', keywords: 'volume mute output audio speaker app volume',
  async render(root) {
    const [a, all] = await Promise.all([cfgList(A), apps()])
    const vols: Record<string, number> = a.appVolumes ?? {}
    const muted: string[] = a.mutedApps ?? []
    root.append(h('div', { class: 'pane' },
      group('Output',
        line('Output volume', slider('Output volume', { min: 0, max: 100, step: 1, value: Math.round(a.volume * 100) }, (v) => attempt(() => sys(A, { op: 'setVolume', volume: v / 100 })), (v) => `${v}%`)),
        line('Mute', toggle('Mute', a.muted, (on) => attempt(() => sys(A, { op: 'mute', on }))))),
      group('Volume per app',
        all.map((app) => line(app.name, h('span', { class: 'row' },
          slider(`${app.name} volume`, { min: 0, max: 100, step: 1, value: Math.round((vols[app.id] ?? 1) * 100) }, (v) => attempt(() => sys(A, { op: 'setAppVolume', app: app.id, volume: v / 100 })), (v) => `${v}%`),
          toggle(`Mute ${app.name}`, muted.includes(app.id), (on) => attempt(() => sys(A, { op: 'muteApp', app: app.id, on }))))))),
      button('Reset app volumes', async () => {
        for (const app of all) await attempt(() => sys(A, { op: 'setAppVolume', app: app.id, volume: 1 }))
        for (const id of muted) await attempt(() => sys(A, { op: 'muteApp', app: id, on: false }))
        root.replaceChildren()
        await sound.render(root)
      }, 'plain')))
  },
}
