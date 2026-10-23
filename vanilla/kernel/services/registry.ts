import { serve } from './lib'
import type { Pear } from '../src/runtime'

/** `tiny.registry`: the list of installed apps and what they can open. */
export default async (tiny: Pear) =>
  serve(tiny, 'tiny.registry', {
    list: () => tiny.bundleList(),
    info: (a) => tiny.bundleInfo(a.id),
    apps: () => tiny.launchApps(),
    appsFor: (a) => tiny.launchAppsFor(a.target),
    typeOf: (a, m) => tiny.launchTypeOf(a.path, { as: m.from }),
  })
