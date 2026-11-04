/// The SDK as a plain script that sets `window.tiny`, for a window whose scripts were not built against `@tiny/sdk`: a
/// project packaged from Code is plain HTML and JavaScript, and uses `tiny` the way Code's preview gives it. Desktop
/// puts this script first in such a window (`apphost.ts`, `document`). Apps that Pear builds bundle the SDK themselves
/// and do not get it twice.
import { tiny, net } from './client'

;(window as unknown as { tiny: typeof tiny }).tiny = tiny

;(window as unknown as { net: typeof net }).net = net
