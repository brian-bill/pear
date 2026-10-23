/** Cities on the Pear World map: real places at their real coordinates, population in millions (rough). */

export interface City {
  name: string
  country: string
  /** degrees east (negative = west) */
  lon: number
  /** degrees north (negative = south) */
  lat: number
  /** approximate metro population, millions */
  pop: number
}

export const CITIES: City[] = [
  { name: 'New York', country: 'United States', lon: -74.01, lat: 40.71, pop: 18.8 },
  { name: 'Los Angeles', country: 'United States', lon: -118.24, lat: 34.05, pop: 12.5 },
  { name: 'Chicago', country: 'United States', lon: -87.63, lat: 41.88, pop: 8.9 },
  { name: 'Mexico City', country: 'Mexico', lon: -99.13, lat: 19.43, pop: 21.8 },
  { name: 'São Paulo', country: 'Brazil', lon: -46.63, lat: -23.55, pop: 22.4 },
  { name: 'Rio de Janeiro', country: 'Brazil', lon: -43.17, lat: -22.91, pop: 13.5 },
  { name: 'Buenos Aires', country: 'Argentina', lon: -58.38, lat: -34.6, pop: 15.2 },
  { name: 'London', country: 'United Kingdom', lon: -0.13, lat: 51.51, pop: 9.5 },
  { name: 'Paris', country: 'France', lon: 2.35, lat: 48.86, pop: 11.1 },
  { name: 'Berlin', country: 'Germany', lon: 13.4, lat: 52.52, pop: 3.8 },
  { name: 'Madrid', country: 'Spain', lon: -3.7, lat: 40.42, pop: 6.7 },
  { name: 'Rome', country: 'Italy', lon: 12.5, lat: 41.9, pop: 4.3 },
  { name: 'Cairo', country: 'Egypt', lon: 31.24, lat: 30.04, pop: 21.3 },
  { name: 'Lagos', country: 'Nigeria', lon: 3.38, lat: 6.52, pop: 15.9 },
  { name: 'Nairobi', country: 'Kenya', lon: 36.82, lat: -1.29, pop: 5 },
  { name: 'Moscow', country: 'Russia', lon: 37.62, lat: 55.76, pop: 12.6 },
  { name: 'Istanbul', country: 'Türkiye', lon: 28.98, lat: 41.01, pop: 15.6 },
  { name: 'Dubai', country: 'United Arab Emirates', lon: 55.27, lat: 25.2, pop: 3.6 },
  { name: 'Mumbai', country: 'India', lon: 72.88, lat: 19.08, pop: 20.7 },
  { name: 'Delhi', country: 'India', lon: 77.21, lat: 28.61, pop: 32.9 },
  { name: 'Singapore', country: 'Singapore', lon: 103.82, lat: 1.35, pop: 6 },
  { name: 'Tokyo', country: 'Japan', lon: 139.65, lat: 35.68, pop: 37.2 },
  { name: 'Seoul', country: 'South Korea', lon: 126.98, lat: 37.57, pop: 9.9 },
  { name: 'Shanghai', country: 'China', lon: 121.47, lat: 31.23, pop: 29.2 },
  { name: 'Sydney', country: 'Australia', lon: 151.21, lat: -33.87, pop: 5.3 },
]

/** `35.68° N 139.65° E` style coordinates for the card. */
export function coordsOf(c: City): string {
  return `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'N' : 'S'} ${Math.abs(c.lon).toFixed(2)}° ${c.lon >= 0 ? 'E' : 'W'}`
}
