// The Playwright runner is Node; the project does not pull in @types/node for one call.
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Buffer>
  export function readFile(path: string, encoding: string): Promise<string>
  interface Buffer {
    toString(encoding?: string): string
    readUInt32LE(offset: number): number
    readUInt16LE(offset: number): number
    length: number
  }
}
