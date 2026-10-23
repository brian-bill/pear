/**
 * Web-Mercator tile math for the live OpenStreetMap layer. Pure functions only: the caller owns
 * the DOM, the cache and the network requests.
 */

export interface Rect {
  /** visible bounds of the map, in degrees: west/east longitude, south/north latitude */
  lon0: number
  lon1: number
  lat0: number
  lat1: number
}

/* ---- projection helpers (Web Mercator, y in [0, 1] for lat in [~85° S, ~85° N]) ---- */

const mercY = (lat: number): number => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2

const unmercY = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

const clampLat = (lat: number): number => Math.max(-85, Math.min(85, lat))

/**
 * Pick a zoom so a tile renders at a comfortable size (2–6, modest zooms only: tiles get big fast
 * and eight fetches per screen is plenty).
 */
export function chooseZoom(scale: number): number {
  // a tile spans (1440 / 2^z) world units; 384 lies between the comfortable 256 and 512 screen px
  return Math.max(2, Math.min(6, Math.round(Math.log2((1440 * scale) / 384))))
}

/** Tile row of a latitude at zoom z, clamped to the plate carrée edges. */
export const tileRowOf = (lat: number, n: number): number => Math.max(0, Math.min(n - 1, Math.floor(mercY(clampLat(lat)) * n)))

/** The geographic bounds of one tile. */
export function tileBounds(z: number, x: number, y: number): Rect {
  const n = 2 ** z
  return {
    lon0: (x / n) * 360 - 180,
    lon1: ((x + 1) / n) * 360 - 180,
    lat0: unmercY((y + 1) / n), // bottom edge (south)
    lat1: unmercY(y / n), // top edge (north)
  }
}

/** Every tile needed to cover `r` at zoom `z`. */
export function tilesFor(r: Rect, z: number): Array<{ z: number; x: number; y: number }> {
  const n = 2 ** z
  // a wider lon range than the world means the whole world fits: clamp row to everything
  const span = Math.max(0, r.lon1 - r.lon0)
  const wide = span >= 360
  const x0 = wide ? 0 : Math.floor(((clampLon(r.lon0) + 180) / 360) * n)
  const x1 = wide ? n - 1 : Math.floor(((clampLon(r.lon1) + 180) / 360) * n)
  const m0 = Math.floor(mercY(clampLat(r.lat1)) * n) // top (north) clips first
  const m1 = Math.floor(mercY(clampLat(r.lat0)) * n) // bottom
  const tiles: Array<{ z: number; x: number; y: number }> = []
  for (let x = x0; x <= Math.min(x1, n - 1); x++)
    for (let y = Math.max(0, m0); y <= Math.min(m1, n - 1); y++) tiles.push({ z, x, y })
  return tiles
}

const clampLon = (lon: number): number => Math.max(-180, Math.min(180, lon))

/** Living off the friendly community tiles server. */
export const tileUrl = ({ z, x, y }: { z: number; x: number; y: number }): string =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
