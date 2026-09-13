# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, architecture, and sharp-edge notes that should travel with the code.

- [VISION.md](VISION.md) is the project's acceptance policy: accuracy first, report and let the caller decide, delegate never reimplement, absent data stays absent, never root, tests never run a real updater. Check a proposed change against it before building.
- The approved spec is GitHub issue https://github.com/andrewesweet/upkeep-axi/issues/1 (label ready-for-agent); it owns the two-verb contract (`status` read-only, `apply` plan-by-default with `--execute`), the surface list, and the out-of-scope list. Build order: status surfaces first, apply + journal + in-use detection + the Firstmate sync classifier in later tasks.
- `upkeep-axi` runs on this WSL2 Ubuntu host only in version one, and never as root (`assertNotRoot` in `src/exec.ts` gates every command).
- One module per surface in `src/surfaces/`, each exposing `detect`, `status`, `apply`, `pin` (the contract in `src/types.ts`). This build implements `detect`/`status` only; `apply`/`pin` refuse via `deferredMutation` in `src/surfaces/shared.ts` until the apply task lands. The CLI wires only `status`; `upkeep-axi apply` is an unknown-command error (exit 2) and the SDK's built-in `update` is shadowed with a refusal because the tool is not published to npm.
- Registry surfaces stay in declaration order (`SURFACE_REGISTRY` in `src/surfaces/index.ts`): npm, mise, uv. Status output keeps that order and is never sorted. Adding a surface is one module plus one registry entry; config only toggles or parameterizes what is there.
- Version probes per surface: npm `ls -g --json` + `view <pkg> version`; mise `ls --json` + `outdated --json` (only tools with updates appear there - absence means latest stays absent, never "current"; several installed versions collapse to one row, the active installed one - a requested-but-missing version never hides an installed one - and pins use `mise use -g`); uv `tool list` + `tool list --outdated` (same only-outdated semantics; uv's `- bin` lines are skipped and the `v` prefix is required when parsing). mise itself reports `mise self-update`; the uv binary belongs to whichever surface manages it (mise on this host).
- Semver tiers live in `src/semver.ts` and have one implementation: equal parsed parts or an installed version newer than latest are `none`, both parse with latest newer decide patch/minor/major, a gap with an unparseable side is `major`, and an unknown version yields no tier at all. `extractVersion` is a documented heuristic over free-form `--version` output.
- PATH skew is measured in `probePathSkew` (`src/surfaces/shared.ts`): every copy of the command on PATH is asked its version; skew is reported only when the resolved copy parses older than a later copy. Config-driven probes (skew, announcement) run only for installed rows; a configured entry the manager does not know reports `installed=false` with no version, apply, or pin.
- Config is tool-owned: `--config <path>` or `$XDG_CONFIG_HOME/upkeep-axi/config.json` (default `~/.config/upkeep-axi/config.json`). Per-tool entries use Firstmate's watched-tools field names (`name`, `command`, `version_args`, `announce_pattern`, `announce_args`, `git`); `git` is accepted for schema compatibility and consumed by a later surface. A malformed config, including an unknown surface id, is a usage error, never ignored.
- Probe failures report verbatim in the sparse `errors` block; the manager row stays with whatever facts survived. Failed latest-version probes keep `latest` and `tier` absent (per-row absence, not a surface error).
- Output contract: default TOON with `bin`/`description`/`generatedAt`/`schemaVersion`, a `tools[]` row per tool (`surface,tool,installed,version,latest,tier,apply,pin`), sparse `errors[]`/`skew[]`/`announce[]` blocks joined on surface+tool, and a `help[]` block; `--json` emits the same model. Renderers live in `src/render.ts`; field spellings never differ between TOON and JSON.
- Tests spawn the built CLI (`dist/bin/upkeep-axi.js`) with an environment whose PATH contains only the test's fake executables - never the parent env - so no test can reach a real package manager. Fakes must use shell builtins only (`echo`/`case`/`test`), because `cat`/`printf` are not on that PATH. The one opt-in live smoke of real `status` is behind an environment flag (UPKEEP_AXI_LIVE_SMOKE=1), never part of the suite's default run.
- Plumbing (routing, `--help`, error framing, exit codes: 0 success, 1 error, 2 usage) comes from `axi-sdk-js` `runAxiCli`; `bin/upkeep-axi.ts` answers bare `-v`/`-V`/`--version` through `axi-sdk-js/fast-path` plus the leaf `src/version.ts` so the command graph never loads on that path.

## Development

```sh
npm install
npm run build
npm test
npm run lint
npm run format:check
```

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
