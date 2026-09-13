import { AxiError } from "axi-sdk-js";
import type { Surface } from "../types.js";
import { aptSurface } from "./apt.js";
import { bunSurface } from "./bun.js";
import { cargoSurface } from "./cargo.js";
import { claudeSurface } from "./claude.js";
import { codexSurface } from "./codex.js";
import { fnmSurface } from "./fnm.js";
import { firstmateSurface } from "./firstmate.js";
import { ghSurface } from "./gh.js";
import { herdrSurface } from "./herdr.js";
import { miseSurface } from "./mise.js";
import { noMistakesSurface } from "./nomistakes.js";
import { npmSurface } from "./npm.js";
import { opencodeSurface } from "./opencode.js";
import { piSurface } from "./pi.js";
import { skillsSurface } from "./skills.js";
import { uvSurface } from "./uv.js";

/**
 * The surface registry, in declaration order: status output keeps this order
 * and is never sorted. Adding a surface is one module plus one registry
 * entry; config only toggles or parameterizes what is here.
 */
export const SURFACE_REGISTRY: Surface[] = [
  npmSurface,
  miseSurface,
  uvSurface,
  cargoSurface,
  bunSurface,
  ghSurface,
  skillsSurface,
  fnmSurface,
  aptSurface,
  claudeSurface,
  codexSurface,
  opencodeSurface,
  piSurface,
  herdrSurface,
  noMistakesSurface,
  firstmateSurface,
];

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
  const wanted = new Set(unique);
  return SURFACE_REGISTRY.filter((surface) => wanted.has(surface.id));
}
