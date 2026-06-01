// Shared domain validation. Used by both `add` (early feedback) and the
// privileged `_hosts-add` / `_hosts-remove` commands (injection prevention).

// Each label: starts/ends alphanumeric, may contain hyphens; at least one dot.
const DOMAIN_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Validates a domain for safe use in file names, hosts entries, and configs. */
export function isValidDomain(domain: string): boolean {
  if (domain.length < 3 || domain.length > 253) return false;
  return DOMAIN_RE.test(domain);
}

/**
 * Canonicalizes a domain at command boundaries: trims and lowercases. DNS is
 * case-insensitive, but file names and conflict checks are not — without this,
 * `App.loc` and `app.loc` become two hostler entries for the same name.
 */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Parses and validates a port string. Rejects non-numeric junk that
 * Number.parseInt would silently accept (e.g. "3000abc", "3000.5", " 3000").
 * Returns null when invalid.
 */
export function parsePort(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535 ? port : null;
}
