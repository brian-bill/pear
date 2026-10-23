import { serve } from './lib'
import type { Pear } from '../src/runtime'

/** `tiny.launch`: open files, URLs and apps on behalf of whoever asks. */
export default async (tiny: Pear) =>
  serve(tiny, 'tiny.launch', {
    open: (a, m) => tiny.launchOpen(a.target, { ...a.options, as: m.from } as never),
    openWith: (a, m) => tiny.launchOpenWith(a.path, a.app, { as: m.from }),
    apps: () => tiny.launchApps(),
    appsFor: (a) => tiny.launchAppsFor(a.target),
    defaultFor: (a) => tiny.launchDefaultFor(a.type),
    setDefault: (a, m) => tiny.launchSetDefault(a.type, a.app, { as: m.from }),
    typeOf: (a, m) => tiny.launchTypeOf(a.path, { as: m.from }),
    running: () => tiny.launchRunning(),
    activate: (a, m) => tiny.launchActivate(a.app, { as: m.from }),
    recents: (a) => tiny.launchRecents(a.app),
    iconFor: (a) => tiny.launchIconFor(a.target),
    typeConflicts: () => tiny.launchTypeConflicts(),
  })
