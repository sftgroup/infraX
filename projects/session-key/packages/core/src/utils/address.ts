/** Normalise address to lowercase checksum-proof form */
export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Shorten address for display: 0x1234...abcd */
export function shortAddress(addr: string, prefix = 6, suffix = 4): string {
  const a = normalizeAddress(addr);
  return `${a.slice(0, prefix + 2)}...${a.slice(-suffix)}`;
}

/** Validate 0x-prefixed hex address */
export function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}
