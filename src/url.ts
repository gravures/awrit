/**
 * URL validation and helpers for the row-0 URL bar.
 * Pure functions with no I/O.
 */

/**
 * Checks if a string is probably a valid URL.
 * Conservative: accepts scheme://host, host.tld, localhost:port.
 * Rejects: strings with spaces, bare words without dots.
 */
export function isProbablyURL(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Has a scheme (http://, https://, file://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return true;
  }

  // localhost with optional port
  if (/^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true;
  }

  // IP address with optional port
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true;
  }

  // Host.tld or host.tld/path (must contain a dot, no spaces)
  // Conservative: at least one dot, no spaces, valid chars
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Normalizes a URL for navigation.
 * - Adds https:// if no scheme
 * - Trims whitespace
 */
export function normalizeURL(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  return 'https://' + trimmed;
}