export function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}
