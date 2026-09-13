import { AxiError } from "axi-sdk-js";
import type { Surface } from "../types.js";
import { miseSurface } from "./mise.js";
import { npmSurface } from "./npm.js";
import { uvSurface } from "./uv.js";

/**
 * The surface registry, in declaration order: status output keeps this order
 * and is never sorted. Adding a surface is one module plus one registry
 * entry; config only toggles or parameterizes what is here.
 */
export const SURFACE_REGISTRY: Surface[] = [npmSurface, miseSurface, uvSurface];

/**
 * Resolve the requested surfaces. A filter keeps registry order (never the
 * caller's spelling order) and an unknown id is a usage error that names the
 * known surfaces.
 */
export function resolveSurfaces(filter: string[] | undefined): Surface[] {
  if (!filter) return SURFACE_REGISTRY;
  const unique = [...new Set(filter)];
  const known = new Map(
    SURFACE_REGISTRY.map((surface) => [surface.id, surface]),
  );
  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new AxiError(
      `Unknown surface: ${unknown.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Known surfaces: ${SURFACE_REGISTRY.map((surface) => surface.id).join(", ")}`,
      ],
    );
  }
  return unique.map((id) => known.get(id) as Surface);
}
