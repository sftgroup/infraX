// ---------------------------------------------------------------------------
// @0xinfrax/payments — Web-Crypto-only primitives
// ---------------------------------------------------------------------------
// Node's builtin `crypto` module and `Buffer` are unavailable to browser
// bundlers (webpack rejects `node:` scheme imports), so all hashing / random /
// base64 helpers here use the Web Crypto API, which exists both in
// Node >= 19 (`globalThis.crypto`) and in every modern browser. Nothing in
// this module touches the filesystem, sockets or Node-specific globals.
// ---------------------------------------------------------------------------

type WebCryptoLike = {
  randomUUID?: () => string
  getRandomValues<T extends ArrayBufferView>(array: T): T
  subtle: {
    importKey(format: string, keyData: Uint8Array, algorithm: { name: string; hash?: string }, extractable: boolean, usages: string[]): Promise<unknown>
    sign(algorithm: { name: string }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
  }
}

function webCrypto(): WebCryptoLike {
  const c = (globalThis as { crypto?: WebCryptoLike }).crypto
  if (!c || !c.getRandomValues) {
    throw new Error('Web Crypto API is not available in this environment')
  }
  return c
}

/** RFC 4122 v4 UUID (`crypto.randomUUID`, with a getRandomValues fallback). */
export function randomUUID(): string {
  const c = webCrypto()
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Random lowercase-hex string of `bytes` bytes (e.g. 32 → 64 chars). */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  webCrypto().getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** RFC 4648 base64 (standard alphabet) of a UTF-8 string. */
export function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

/** Decode RFC 4648 base64 (standard or url-safe variant) into a UTF-8 string. */
export function fromBase64(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of normalized) {
    if (ch === '=') continue
    const idx = B64_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    acc = (acc << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256 of `data` with `secret`, returned as lowercase hex. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const c = webCrypto()
  const key = await c.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await c.subtle.sign({ name: 'HMAC' }, key, new TextEncoder().encode(data))
  return bytesToHex(new Uint8Array(sig))
}

/**
 * Constant-time equality for ASCII strings (used for signature digests).
 * Leaks only the length, mirroring the Node `timingSafeEqual` semantics it
 * replaces (which also short-circuits on mismatched lengths).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
