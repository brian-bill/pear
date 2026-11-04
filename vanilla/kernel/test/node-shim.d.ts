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

// Enough of node:crypto for tests that serve signed or hashed fixtures.
declare module 'node:crypto' {
  interface KeyObject {
    export(options: { format: 'jwk' }): { x?: string }
  }
  export function createHash(algorithm: string): { update(data: string | Buffer): { digest(encoding: 'hex'): string } }
  export function generateKeyPairSync(type: 'ed25519'): { publicKey: KeyObject; privateKey: KeyObject }
  export function sign(algorithm: null, data: Buffer, key: KeyObject): Buffer
}
declare class Buffer {
  length: number
  static from(data: string | number[], encoding?: string): Buffer
  toString(encoding?: string): string
}
