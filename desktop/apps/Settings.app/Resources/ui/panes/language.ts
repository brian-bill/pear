import { attempt, cfgList, cfgSet, choose, group, h, line, sys, type Pane } from '../lib'

const LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'de-DE', 'fr-FR', 'fr-CA', 'es-ES', 'es-MX', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'pl-PL', 'ru-RU', 'tr-TR', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'ar-EG', 'hi-IN']
const REGIONS = ['US', 'GB', 'AU', 'CA', 'DE', 'FR', 'ES', 'MX', 'IT', 'BR', 'PT', 'NL', 'SE', 'PL', 'RU', 'TR', 'JP', 'KR', 'CN', 'TW', 'EG', 'IN']
const WEEKDAYS: Array<[string, string]> = [['', 'Automatic'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['7', 'Sunday']]

const langName = (tag: string) => { try { return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(tag)} (${tag})` } catch { return tag } }
const regionName = (code: string) => { try { return `${new Intl.DisplayNames(['en'], { type: 'region' }).of(code)} (${code})` } catch { return code } }

export const language: Pane = {
  id: 'language', title: 'Language & Region', icon: '🌐', color: '#0a84ff', keywords: 'locale region timezone time zone first weekday measurement metric languages date number format',
  async render(root) {
    const s = await cfgList('tiny.system')
    const zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    const preview = h('div', { class: 'preview selectable', 'aria-label': 'Format preview' })
    const draw = (cur: Record<string, any>) => {
      const loc = cur.locale as string
      const zone = cur.timezone === 'auto' ? undefined : (cur.timezone as string)
      const now = new Date()
      const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: zone, ...o }).format(now)
      preview.replaceChildren(
        h('div', null, fmt({ dateStyle: 'full' })),
        h('div', null, fmt({ timeStyle: 'long' })),
        h('div', null, new Intl.NumberFormat(loc).format(1234567.89)),
        h('div', null, new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD' }).format(1234.5)),
      )
    }
    const cur = { ...s }
    const write = async (key: string, value: string | number | null, then?: () => Promise<unknown>) => {
      await attempt(async () => { await (then ? then() : cfgSet('tiny.system', key, value)); cur[key] = value })
      draw(cur)
    }
    const langs: string[] = s.languages ?? []
    const langBox = h('input', { type: 'text', 'aria-label': 'Preferred languages', placeholder: 'en-US, fr-FR', value: langs.join(', '),
      onchange: () => void write('languages', null, () => cfgSet('tiny.system', 'languages', langBox.value.split(',').map((x) => x.trim()).filter(Boolean))) })
    langBox.value = langs.join(', ')
    draw(cur)
    root.append(h('div', { class: 'pane' },
      group(null,
        line('Language', choose('Language', LOCALES.map((l) => [l, langName(l)] as [string, string]), s.locale, (v) => write('locale', v))),
        line('Region', choose('Region', [['', 'Automatic'] as [string, string], ...REGIONS.map((r) => [r, regionName(r)] as [string, string])], s.region ?? '', (v) => write('region', v || null))),
        line('Time zone', choose('Time zone', [['auto', 'Automatic (follow the computer)'] as [string, string], ...zones.map((z) => [z, z.replace(/_/g, ' ')] as [string, string])], s.timezone, (v) => write('timezone', v, () => sys('tiny.timers', { op: 'setTimezone', zone: v })))),
        line('First day of week', choose('First day of week', WEEKDAYS, String(s.firstWeekday ?? ''), (v) => write('firstWeekday', v ? Number(v) : null))),
        line('Measurement', choose('Measurement system', [['', 'Automatic'], ['metric', 'Metric'], ['us', 'US'], ['uk', 'UK']], s.measurement ?? '', (v) => write('measurement', v || null))),
        line('Preferred languages', langBox, 'Comma separated, most preferred first.')),
      group('Preview', h('div', { class: 'line' }, preview))))
  },
}
