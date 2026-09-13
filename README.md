# upkeep-axi

Agent-ergonomic (AXI) update inventory and applier for this workstation.

`upkeep-axi` reports, for every update surface on this host, what is installed, what is available, the semver tier of the gap, whether an update actually took effect on `PATH`, and the exact command that applies or pins each tool. It is data only: `status` never mutates anything, and `apply` (plan by default, `--execute` to act) lands in a later build and will always delegate to each vendor's own updater with fixed arguments.

Spec: https://github.com/andrewesweet/upkeep-axi/issues/1

## Quick start

```sh
$ upkeep-axi
bin: ~/.local/bin/upkeep-axi
description: Report workstation update inventory across surfaces.
generatedAt: "2026-09-13T11:02:36.440Z"
schemaVersion: 1
tools[3]{surface,tool,installed,version,latest,tier,apply,pin}:
  npm,typescript,true,5.6.3,5.7.2,minor,npm install -g typescript@latest,npm install -g typescript@5.6.3
  mise,node,true,20.11.0,22.0.0,major,mise upgrade node,mise use -g node@20.11.0
  uv,ruff,true,0.3.4,0.9.0,minor,uv tool upgrade ruff,uv tool install ruff==0.3.4
skew[1]{surface,tool,command,resolvedPath,resolvedVersion,newerPath,newerVersion}:
  npm,esbuild,esbuild,~/.local/bin/esbuild,0.19.0,~/.npm-global/bin/esbuild,0.20.0
announce[1]{surface,tool,claim}:
  npm,no-mistakes,"A new version of no-mistakes is available: 0.1.0 -> 0.1.1"
help[2]:
  Run `upkeep-axi status --surface <id>` to scope to one surface
  Run `upkeep-axi status --json` for the normalized model
```

Default output is [TOON](https://toonformat.dev/), structured for agents: one `tools[]` row per tool, plus sparse blocks that only appear when they have something to say:

- `tools[]` - one row per tool: `installed`, installed `version`, available `latest`, semver `tier` (`none`/`patch`/`minor`/`major`; a gap whose versions do not both parse is `major`), and the exact `apply` and `pin` commands. An installed version newer than `latest` is `none`: a current tool never reads as behind.
- `skew[]` - "update not in effect": every copy of the command on `PATH` was asked its version, and a newer copy sits behind the resolved one.
- `announce[]` - the tool's own update announcement, matched by the configured pattern; upkeep-axi reports the claim verbatim and adds nothing.
- `errors[]` - a manager probe that failed, reported verbatim.

Absent data stays absent: an unknown latest version means no `latest` and no `tier`, never a guess.

`--json` emits the same model with the same spellings. Exit codes: `0` success, `1` error, `2` usage error.

## Verbs

- `upkeep-axi status` - read-only inventory (this build). Flags: `--surface <id[,id...]>`, `--config <path>`, `--json`, `--help`.
- `upkeep-axi apply` - plan/execute updates (later build; currently an unknown command).
- `upkeep-axi --help` - top-level help. `-v`/`-V`/`--version` print the bare version.

The tool never runs as root and never publishes itself to npm; its built-in `update` refuses for that reason.

## Surfaces

Version one ships nine status surfaces and runs on this WSL2 Ubuntu host only:

| id            | scope                                  | installed via                                            | available via                    |
| ------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `npm`         | global npm packages                    | `npm ls -g --json`                                       | `npm view <pkg> version`         |
| `mise`        | mise itself and managed tools          | `mise ls --json`                                         | `mise outdated --json`           |
| `uv`          | uv-managed tools                       | `uv tool list`                                           | `uv tool list --outdated`        |
| `claude`      | Claude Code, its plugins, marketplaces | `claude --version`, Claude state files                   | its own announcement             |
| `codex`       | Codex CLI                              | `codex --version`                                        | `npm view @openai/codex version` |
| `opencode`    | OpenCode                               | `opencode --version`                                     | its own announcement             |
| `pi`          | Pi and its packages                    | `pi --version`, `pi list`                                | its own announcement             |
| `herdr`       | Herdr and its plugins                  | `herdr --version`, `$XDG_CONFIG_HOME/herdr/plugins.json` | -                                |
| `no-mistakes` | no-mistakes                            | `no-mistakes --version`                                  | its own announcement             |

Surfaces whose latest version lives only in the tool's own update announcement (claude, opencode, pi, no-mistakes) keep `latest` and `tier` absent unless a config entry wires the announcement probe; the announcement then carries the tool's own claim. Claude plugin versions come from the plugin manifest (`.claude-plugin/plugin.json`) with the installer-recorded version as fallback; enabled-but-not-installed plugins report `installed=false`; marketplaces report `claude plugin marketplace update <name>`. Herdr plugin rows are inventory only: herdr exposes no plugin update or pin command, so none is printed.

A manager that is missing reports one `installed=false` row. Adding a surface is one module in `src/surfaces/` plus one registry entry; the module contract is `detect`, `status`, `apply`, `pin`.

## Config

The tool owns its config file, installed by host-up:

```
--config <path>,
or $XDG_CONFIG_HOME/upkeep-axi/config.json (default ~/.config/upkeep-axi/config.json)
```

A missing default file means: every registry surface enabled, no per-tool entries; an explicit `--config` path must exist. Per-tool entries use Firstmate's watched-tools field names so both tools describe a tool the same way:

```json
{
  "surfaces": {
    "npm": {
      "enabled": true,
      "tools": [
        {
          "name": "esbuild",
          "command": "esbuild",
          "version_args": ["--version"],
          "announce_args": ["--help"],
          "announce_pattern": "A new version of esbuild is available: [^ ]+ -> [^ ]+"
        }
      ]
    },
    "uv": { "enabled": false }
  }
}
```

- `name` - tool name as the owning manager reports it.
- `command` - executable probed on `PATH`; defaults to `name`.
- `version_args` - argv used to ask a copy of `command` its version; defaults to `["--version"]`.
- `announce_pattern` / `announce_args` - run the tool with `announce_args`, match `announce_pattern`, and report the match as the tool's own claim.
- `git` - accepted for watched-tools schema compatibility; consumed by a later surface.

A configured entry the manager does not know reports `installed=false`. A malformed config is a usage error, never silently ignored.

## Development

```sh
npm install
npm run build
npm test        # builds, then runs the suite
npm run lint
npm run format:check
```

Tests exercise the CLI with fake vendor executables on a PATH that contains nothing else, so no test ever runs a real package manager or mutates the host. The real probes are exercised by the opt-in live smoke (`UPKEEP_AXI_LIVE_SMOKE=1 npm test` runs one `status` against the host's real managers).

## Principles

[VISION.md](VISION.md) owns the acceptance policy: accuracy first, report and let the caller decide, delegate never reimplement, absent data stays absent, never root, tests never run a real updater.
