/// Vercel Edge Function for Safari's CORS/mixed-content fallback. The logic lives in `desktop/server/proxy.ts`
/// so the Vite dev server and the deployed site behave the same way. Private addresses are refused here.
import { proxy } from '../desktop/server/proxy'

export const config = { runtime: 'edge' }

export default function handler(request: Request): Promise<Response> {
  return proxy(request, { allowPrivate: false })
}
