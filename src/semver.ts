import type { SemverTier } from "./types.js";

/**
 * Extract the first version-looking token (`1.2`, `v1.2.3`, `1.2.3.4`) from
 * free-form tool output. A heuristic by design: vendor `--version` output is
 * not uniform. Returns the token with any leading `v` stripped, or undefined.
 */
export function extractVersion(text: string): string | undefined {
  const match = text.match(
    /(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+){1,3})(?:[^0-9.]|$)/,
  );
  return match ? match[1] : undefined;
}

/**
 * Parse a version string into numeric [major, minor, patch]. Components past
 * the third are ignored, missing ones are zero; a token with no numeric
 * dotted form does not parse.
 */
export function parseVersion(
  raw: string,
): [number, number, number] | undefined {
  const token = extractVersion(raw);
  if (!token) return undefined;
  const parts = token.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) return undefined;
  const [major = 0, minor = 0, patch = 0] = parts;
  return [major, minor, patch];
}

/** Numeric comparison of parsed versions: -1, 0, or 1. */
export function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Tier of the gap from installed to latest.
 *
 * Equal versions (by parsed parts, so `1.2` equals `1.2.0`) are `none`.
 * When both versions parse, the tier is the highest changed component.
 * When a gap exists but either version does not parse, the tier is `major`:
 * an unknown-shape update must never read as casual. The caller passes
 * undefined when a version is unknown and gets undefined back - absent data
 * stays absent.
 */
export function tierBetween(
  installed: string | undefined,
  latest: string | undefined,
): SemverTier | undefined {
  if (installed === undefined || latest === undefined) return undefined;
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (!a || !b) return "major";
  const order = compareVersions(a, b);
  if (order === 0) return "none";
  if (b[0] !== a[0]) return "major";
  if (b[1] !== a[1]) return "minor";
  return "patch";
}
