import { runBounded } from "./exec.js";
import { InUseProber, markInUse } from "./inuse.js";
import type {
  Surface,
  SurfaceContext,
  ToolStatus,
  UpkeepConfig,
} from "./types.js";

/**
 * Collect status rows for the resolved surfaces, in registry order.
 * A surface whose manager is missing reports one row saying so; a disabled
 * surface is absent. Probes are read-only; in-use measurement adds no
 * mutation - it reads herdr's agent list, no-mistakes' runs, and the
 * process table, each once per run.
 */
export async function collectStatus(
  config: UpkeepConfig,
  surfaces: Surface[],
  env: NodeJS.ProcessEnv,
): Promise<ToolStatus[]> {
  const tools: ToolStatus[] = [];
  const prober = new InUseProber(env);
  for (const surface of surfaces) {
    const surfaceConfig = config.surfaces?.[surface.id] ?? {};
    if (surfaceConfig.enabled === false) continue;
    const ctx: SurfaceContext = {
      config,
      surface: surfaceConfig,
      env,
      exec: (file, args, timeoutMs) => runBounded(file, args, env, timeoutMs),
    };
    const detected = await surface.detect(ctx);
    const rows = detected
      ? await surface.status(ctx)
      : [
          {
            surface: surface.id,
            tool: surface.managerTool,
            installed: false,
          },
        ];
    if (detected) await markInUse(surface, rows, prober);
    tools.push(...rows);
  }
  return tools;
}
