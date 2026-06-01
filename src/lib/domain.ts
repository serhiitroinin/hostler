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
