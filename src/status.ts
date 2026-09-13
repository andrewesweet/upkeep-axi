import { runBounded } from "./exec.js";
import type {
  Surface,
  SurfaceContext,
  ToolStatus,
  UpkeepConfig,
} from "./types.js";

/**
 * Collect status rows for the resolved surfaces, in registry order.
 * A surface whose manager is missing reports one row saying so; a disabled
 * surface is absent. Nothing here mutates anything.
 */
export async function collectStatus(
  config: UpkeepConfig,
  surfaces: Surface[],
  env: NodeJS.ProcessEnv,
): Promise<ToolStatus[]> {
  const tools: ToolStatus[] = [];
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
    tools.push(
      ...(detected
        ? await surface.status(ctx)
        : [
            {
              surface: surface.id,
              tool: surface.managerTool,
              installed: false,
            },
          ]),
    );
  }
  return tools;
}
