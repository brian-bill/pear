import { tiny } from '@tiny/sdk'
import { attempt, button, group, info, line, say, sys, h, type Pane } from '../lib'

export const displays: Pane = {
  id: 'displays', title: 'Displays', icon: '▣', color: '#32ade6', keywords: 'screen resolution fullscreen gpu scale refresh',
  async render(root) {
    const [list, gpu] = await Promise.all([tiny.service<any[]>('tiny.display', { op: 'list' }), tiny.service<any>('tiny.display', { op: 'gpu' }).catch(() => null)])
    const full = list.some((d) => d.fullscreen)
    root.append(h('div', { class: 'pane' },
      ...list.map((d, i) => group(list.length > 1 ? `Display ${i + 1}` : 'Built-in display',
        info('Resolution', `${d.width} × ${d.height}`),
        info('Scale', `${d.scale}×`),
        info('Refresh rate', d.refreshRate ? `${Math.round(d.refreshRate)} Hz` : 'Unknown'),
        info('Color space', d.colorSpace ?? 'sRGB'))),
      group('Full screen',
        line(full ? 'Pear is full screen' : 'Show Pear full screen', full
          ? button('Exit Full Screen', async () => void (await attempt(() => sys('tiny.display', { op: 'exitFullscreen' }), 'Left full screen.')))
          : button('Enter Full Screen', async () => {
            await attempt(() => sys('tiny.display', { op: 'requestFullscreen' }))
            say('Requested full screen. Browsers only allow this right after a click.')
          }))),
      gpu ? group('Graphics', info('Renderer', gpu.renderer || 'Unknown'), info('Vendor', gpu.vendor || 'Unknown'), info('WebGL 2', gpu.webgl2 ? 'Yes' : 'No'), info('Largest texture', `${gpu.maxTextureSize} px`), gpu.software ? info('Rendering', 'Software') : null) : null))
  },
}
