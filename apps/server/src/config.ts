/** PORT from the environment: unset or empty means 8790, and 0 really means "any free port". */
export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 8790;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${value}"`);
  }
  return n;
}
