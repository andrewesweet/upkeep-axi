import http from "node:http";
import { PROBE_TIMEOUT_MS } from "./exec.js";
import type { SurfaceConfig } from "./types.js";

/**
 * The snapd REST read client.
 *
 * snapd serves JSON over a Unix socket, so the snap surface reads the
 * daemon's REST API directly instead of parsing `snap` command tables or
 * shelling out to `curl`. This module owns the transport and the snapd
 * envelope; the surface module (`src/surfaces/snap.ts`) owns interpreting results
 * into rows. Reads only: the request method is GET by construction and no
 * mutating path exists here.
 *
 * Every request is bounded with the same discipline as a status probe
 * (`runBounded`): a hard wall-clock budget, after which the request is torn
 * down - safe, because a read has nothing of its own mid-write.
 */

/** The snapd REST socket, overridable per surface config. */
export const DEFAULT_SNAPD_SOCKET = "/run/snapd.socket";

/** This surface's resolved socket path (default /run/snapd.socket). */
export function snapdSocketPath(surface: SurfaceConfig): string {
  return surface.socketPath ?? DEFAULT_SNAPD_SOCKET;
}

/**
 * One snapd read outcome, classified for the caller:
 *
 * - `absent`: there is no socket file (ENOENT) or nothing is listening
 *   behind it (ECONNREFUSED). snapd is not running on this host - normal
 *   absence, never a probe error.
 * - `error`: the read failed in a way absence does not explain: malformed
 *   body, invalid JSON, a non-200 API status, permission denial on an
 *   existing socket, or the bounded wait elapsing. The reason is reported
 *   verbatim in the sparse errors block; `statusCode` carries the API (or
 *   HTTP) status when one was received.
 * - `ok`: a validated sync envelope; `result` carries the payload.
 */
export type SnapdRead =
  | { kind: "absent"; reason: string }
  | { kind: "error"; reason: string; statusCode?: number }
  | { kind: "ok"; result: unknown };

/** Shape of the snapd JSON envelope: {type, status-code, status, result}. */
interface SnapdEnvelope {
  type?: unknown;
  "status-code"?: unknown;
  status?: unknown;
  result?: unknown;
}

/**
 * GET /v2/system-info: daemon identity and version. The surface reads it
 * for the manager row's own facts.
 */
export function snapdSystemInfo(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SnapdRead> {
  return snapdGet("/v2/system-info", socketPath, timeoutMs);
}

/**
 * GET /v2/snaps: the active installed snaps. Never `select=all`, which
 * would also return disabled historical revisions - the path is fixed here
 * so no caller can ask for them.
 */
export function snapdSnaps(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SnapdRead> {
  return snapdGet("/v2/snaps", socketPath, timeoutMs);
}

/**
 * GET /v2/find?select=refresh: the refresh candidates snapd currently
 * offers this host on each tracked channel. The store-wide channel map is
 * deliberately not consulted: a store release a phase or hold has not
 * offered this host is not an available update.
 */
export function snapdRefreshCandidates(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SnapdRead> {
  return snapdGet("/v2/find?select=refresh", socketPath, timeoutMs);
}

/**
 * One bounded GET over the snapd Unix socket. GET is the only method this
 * module can issue; `agent: false` keeps it one request per connection.
 */
function snapdGet(
  path: string,
  socketPath: string,
  timeoutMs: number,
): Promise<SnapdRead> {
  return new Promise((resolve) => {
    let settled = false;
    function finish(read: SnapdRead) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(read);
    }
    const request = http.request(
      { socketPath, path, method: "GET", agent: false },
      (response) => {
        const parts: Uint8Array<ArrayBuffer>[] = [];
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          // Copied, not referenced: the chunk's buffer keeps Node's own
          // ArrayBufferLike typing, and the copy keeps the Blob decode
          // simple while the bytes are only kilobytes.
          parts.push(new Uint8Array(chunk));
        });
        response.on("end", () => {
          // Decoding the assembled bytes in one step keeps a multi-byte
          // character split across chunks intact.
          void new Blob(parts).text().then((body) => {
            finish(classifyResponse(path, body, response.statusCode ?? 0));
          });
        });
        response.on("error", (error) => {
          finish({
            kind: "error",
            reason: `GET ${path} failed: ${error.message}`,
          });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({
        kind: "error",
        reason: `GET ${path} over ${socketPath} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish(classifyConnectError(path, socketPath, error));
    });
    request.end();
  });
}

/**
 * Connection-level failures split two ways: no socket file or no listener
 * is normal snapd absence; anything else (notably permission denial on an
 * existing socket - host policy, not absence) is a probe error.
 */
function classifyConnectError(
  path: string,
  socketPath: string,
  error: NodeJS.ErrnoException,
): SnapdRead {
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    return {
      kind: "absent",
      reason: `snapd is not answering on ${socketPath} (${error.code})`,
    };
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return {
      kind: "error",
      reason: `permission denied on snapd socket ${socketPath} (${error.code})`,
    };
  }
  return {
    kind: "error",
    reason: `GET ${path} over ${socketPath} failed: ${error.message}`,
  };
}

/**
 * Validate the snapd JSON envelope. The envelope's `status-code` is the
 * API contract and outranks the HTTP status; the HTTP status is only
 * consulted when no envelope could be read at all. A 200 read must be a
 * `sync` envelope carrying a result - an async envelope would carry a
 * change id, not the payload these reads need.
 */
function classifyResponse(
  path: string,
  body: string,
  httpStatus: number,
): SnapdRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (httpStatus !== 200) {
      return {
        kind: "error",
        statusCode: httpStatus,
        reason: `GET ${path} returned HTTP ${httpStatus} with an unparseable body`,
      };
    }
    return {
      kind: "error",
      reason: `GET ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "error",
      reason: `GET ${path} returned a malformed snapd envelope (expected an object)`,
    };
  }
  const envelope = parsed as SnapdEnvelope;
  if (typeof envelope["status-code"] !== "number") {
    return {
      kind: "error",
      reason: `GET ${path} returned a malformed snapd envelope (no numeric status-code)`,
    };
  }
  if (envelope["status-code"] !== 200) {
    return {
      kind: "error",
      statusCode: envelope["status-code"],
      reason: `GET ${path} returned snapd status ${envelope["status-code"]}${typeof envelope.status === "string" ? ` (${envelope.status})` : ""}`,
    };
  }
  if (envelope.type !== "sync") {
    return {
      kind: "error",
      reason: `GET ${path} returned unexpected envelope type ${JSON.stringify(envelope.type)}`,
    };
  }
  if (envelope.result === undefined) {
    return {
      kind: "error",
      reason: `GET ${path} returned a sync envelope with no result`,
    };
  }
  return { kind: "ok", result: envelope.result };
}
