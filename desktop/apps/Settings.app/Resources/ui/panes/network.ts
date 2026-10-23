import { formatBytes } from '@tiny/sdk'
import { apps, attempt, button, group, h, info, line, sys, type Pane } from '../lib'

interface Rule { mode: 'allow' | 'deny'; hosts?: string[] }
const N = 'tiny.network'

export const network: Pane = {
  id: 'network', title: 'Network', icon: '⌁', color: '#0a84ff', keywords: 'online offline internet rules allow deny proxy data usage firewall',
  async render(root) {
    const [status, rules, proxy, usage, all] = await Promise.all([
      sys<any>(N, { op: 'status' }),
      sys<Record<string, Rule>>(N, { op: 'rules.list' }),
      sys<string>(N, { op: 'proxy.get' }),
      sys<Record<string, { bytesIn: number; bytesOut: number; requests: number }>>(N, { op: 'usage' }),
      apps(),
    ])
    const proxyBox = h('input', { type: 'text', 'aria-label': 'Proxy URL', placeholder: 'None', value: proxy, style: 'width:240px',
      onchange: () => void attempt(() => sys(N, { op: 'proxy.set', url: proxyBox.value.trim() }), 'Proxy saved.') })
    proxyBox.value = proxy
    const ruleLine = (a: { id: string; name: string }) => {
      const r = rules[a.id]
      const mode = h('select', { 'aria-label': `Network rule for ${a.name}` }, h('option', { value: '' }, 'Default'), h('option', { value: 'allow' }, 'Allow'), h('option', { value: 'deny' }, 'Block'))
      mode.value = r?.mode ?? ''
      const hosts = h('input', { type: 'text', placeholder: 'Any host', 'aria-label': `Allowed hosts for ${a.name}`, style: 'width:150px' })
      hosts.value = r?.hosts?.join(', ') ?? ''
      const save = () => attempt(() => sys(N, { op: 'rules.set', appId: a.id, rule: mode.value ? { mode: mode.value, hosts: hosts.value.split(',').map((x) => x.trim()).filter(Boolean) } : null }))
      mode.onchange = () => void save()
      hosts.onchange = () => void save()
      return line(a.name, h('span', { class: 'row' }, hosts, mode))
    }
    const usageRows = all.filter((a) => usage[a.id]).map((a) => info(a.name, `${formatBytes(usage[a.id]!.bytesIn)} in, ${formatBytes(usage[a.id]!.bytesOut)} out, ${usage[a.id]!.requests} requests`))
    root.append(h('div', { class: 'pane' },
      group('Status', info('Connection', status.online ? 'Online' : 'Offline'), status.effectiveType ? info('Type', String(status.effectiveType)) : null, status.downlink ? info('Speed', `${status.downlink} Mbit/s`) : null),
      group('Apps', all.map(ruleLine)),
      group('Proxy', line('Proxy URL', proxyBox, 'Requests go to the proxy followed by the encoded address.')),
      h('section', null, h('h2', null, 'Data usage'), h('div', { class: 'group' },
        usageRows.length ? usageRows : line('No app has used the network yet.'),
        line('', button('Reset Counters', async () => { await attempt(() => sys(N, { op: 'usage.reset' }), 'Counters reset.'); root.replaceChildren(); await network.render(root) }, 'plain'))))))
  },
}
