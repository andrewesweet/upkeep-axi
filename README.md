# upkeep-axi

Agent-ergonomic (AXI) update inventory and applier for this workstation.

`upkeep-axi` reports, for every update surface on this host, what is installed, what is available, the semver tier of the gap, whether the tool is in use, whether an update actually took effect on `PATH`, and the exact command that applies or pins each tool. `status` never mutates anything; `apply` plans by default and, with `--execute`, delegates to each vendor's own updater with fixed arguments, journaling every run.

Spec: https://github.com/andrewesweet/upkeep-axi/issues/1

## Quick start

```sh
$ upkeep-axi
bin: ~/.local/bin/upkeep-axi
description: Report workstation update inventory across surfaces.
generatedAt: "2026-09-13T11:02:36.440Z"
schemaVersion: 3
tools[3]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:
  npm,typescript,true,5.6.3,5.7.2,minor,false,npm install -g typescript@latest,npm install -g typescript@5.6.3
  mise,node,true,20.11.0,22.0.0,major,true,mise upgrade node,mise use -g node@20.11.0
  uv,ruff,true,0.3.4,0.9.0,minor,false,uv tool upgrade ruff,uv tool install ruff==0.3.4
in_use[1]{surface,tool,detail}:
  mise,node,process 4242 runs ~/.local/share/mise/installs/node/20.11.0/bin/node
skew[1]{surface,tool,command,resolvedPath,resolvedVersion,newerPath,newerVersion}:
  npm,esbuild,esbuild,~/.local/bin/esbuild,0.19.0,~/.npm-global/bin/esbuild,0.20.0
announce[1]{surface,tool,claim}:
  npm,no-mistakes,"A new version of no-mistakes is available: 0.1.0 -> 0.1.1"
help[2]:
  Run `upkeep-axi status --surface <id>` to scope to one surface
  Run `upkeep-axi status --json` for the normalized model
```

Default output is [TOON](https://toonformat.dev/), structured for agents: one `tools[]` row per tool, plus sparse blocks that only appear when they have something to say:

- `tools[]` - one row per tool: `installed`, installed `version`, available `latest`, semver `tier` (`none`/`patch`/`minor`/`major`; a gap whose versions do not both parse is `major`), `in_use` (present only on installed rows that carry an apply command), and the exact `apply` and `pin` commands. An installed version newer than `latest` is `none`: a current tool never reads as behind.
- `in_use[]` - why a tool is in use, read from `herdr agent list`, `no-mistakes runs`, and the process table (`/proc/<pid>/exe`), never from Firstmate's files. `apply` refuses an in-use tool with this reason.
- `skew[]` - "update not in effect": every copy of the command on `PATH` was asked its version, and a newer copy sits behind the resolved one.
- `announce[]` - the tool's own update announcement, matched by the configured pattern; upkeep-axi reports the claim verbatim and adds nothing.
- `sync[]` - the Firstmate fork's sync facts: the class (`current`/`fast-forward`/`clean-rebase`/`conflicts`), the commits each side is ahead, the fork's GitHub slug, and - for conflicts - the conflicting files.
- `errors[]` - a manager probe that failed, reported verbatim.

Absent data stays absent: an unknown latest version means no `latest` and no `tier`, never a guess.

`--json` emits the same model with the same spellings. Exit codes: `0` success, `1` error, `2` usage error.

## Verbs

- `upkeep-axi status` - read-only inventory (the default command). Flags: `--surface <id[,id...]>`, `--since <cursor>`, `--changed-only`, `--config <path>`, `--json`, `--help`. `--since <cursor>` (a journal record id or an ISO timestamp) reports rows whose installed version differs from what the journal recorded at the cursor; `--changed-only` reports rows whose installed version differs from the journal's newest record of them (an empty journal reports everything). Given both, `--since` decides.
- `upkeep-axi apply [<surface> [tool...]] [--all --tier <patch|minor|major>]` - plan updates from the same rows `status` produces; execute only with `--execute`. `--all` requires `--tier` and takes every gap at or below the tier; naming a surface takes every gap it has; naming tools selects them whatever their tier. Each delegate is the vendor's own updater with fixed arguments under a time budget (default 900000 ms): a refusal (nonzero exit) is reported verbatim and never retried; a delegate still running at its budget is left running and reported `unconfirmed`. A refused or unconfirmed delegate's own output is reported verbatim. In-use tools are refused. apt is report-only and naming it for apply is a usage error.
- `upkeep-axi journal` - print the append-only JSONL journal at `$XDG_STATE_HOME/upkeep-axi/journal.jsonl` (default `~/.local/state`): one record per tool per executed apply (`surface,tool,before,after,tier,command,exit,duration_ms,pin,started_at`, plus `id`), refusals included.
- `upkeep-axi --help` - top-level help. `-v`/`-V`/`--version` print the bare version.

The tool never runs as root and never publishes itself to npm; its built-in `update` refuses for that reason.

## Surfaces

All sixteen version-one surfaces have shipped; the tool runs on this WSL2 Ubuntu host only:

| id            | scope                                   | installed via                                            | available via                                                                             |
| ------------- | --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm`         | global npm packages                     | `npm ls -g --json`                                       | `npm view <pkg> version`                                                                  |
| `mise`        | mise itself and managed tools           | `mise ls --json`                                         | `mise outdated --json`                                                                    |
| `uv`          | uv-managed tools                        | `uv tool list`                                           | `uv tool list --outdated`                                                                 |
| `cargo`       | cargo-installed binaries                | `cargo install --list`                                   | `cargo search <crate> --limit 1`                                                          |
| `bun`         | global bun packages                     | `bun pm ls -g`                                           | `bun pm view <pkg> version`                                                               |
| `gh`          | gh itself and its extensions            | `gh --version`, `gh extension list`                      | `gh extension upgrade --all --dry-run`                                                    |
| `skills`      | skills under `~/.agents/skills`         | `skills list -g` (or `npx -y skills`)                    | none exposed - installed only                                                             |
| `fnm`         | fnm-managed node                        | `fnm list`                                               | `fnm ls-remote --lts`                                                                     |
| `apt`         | upgradable packages, report-only        | `apt list --upgradable`                                  | the listing itself; apply is the exact `sudo apt-get update && sudo apt-get upgrade` text |
| `claude`      | Claude Code, its plugins, marketplaces  | `claude --version`, Claude state files                   | its own announcement                                                                      |
| `codex`       | Codex CLI                               | `codex --version`                                        | `npm view @openai/codex version`                                                          |
| `opencode`    | OpenCode                                | `opencode --version`                                     | its own announcement                                                                      |
| `pi`          | Pi and its packages                     | `pi --version`, `pi list`                                | its own announcement                                                                      |
| `herdr`       | Herdr and its plugins                   | `herdr --version`, `$XDG_CONFIG_HOME/herdr/plugins.json` | -                                                                                         |
| `no-mistakes` | no-mistakes                             | `no-mistakes --version`                                  | its own announcement                                                                      |
| `firstmate`   | the Firstmate fork's sync with upstream | the local clone's remote-tracking refs                   | upstream main, classified by a trial rebase                                               |

The apt surface also reports the reboot-required flag as a row (`reboot-required`, present or not); its path is the `rebootRequiredPath` surface option, default `/var/run/reboot-required`.

Surfaces whose latest version lives only in the tool's own update announcement (claude, opencode, pi, no-mistakes) keep `latest` and `tier` absent unless a config entry wires the announcement probe; the announcement then carries the tool's own claim. Claude plugin versions are the ones Claude Code recorded in `plugins/installed_plugins.json`; enabled-but-not-installed plugins report `installed=false` (an unreadable install record yields no plugin rows); marketplaces report `claude plugin marketplace update <name>`. Herdr plugin rows are inventory only: herdr exposes no plugin update or pin command, so none is printed.

### The Firstmate fork sync

The `firstmate` surface reads the local clone (config `clonePath`, default `/home/andre/tools/firstmate`): it fetches both remotes (`upstream` and `origin`) and counts the commits each is ahead of the other on `main`; a remote whose fetch failed is not read, so a stale ref never classifies. When both sides have commits the other lacks, a trial rebase of the fork's bespoke commits onto upstream main runs in a scratch worktree under the tool's own state directory (`$XDG_STATE_HOME/upkeep-axi/firstmate-sync/`), discarded afterwards; the clone's working tree and branches are never touched. The class carries the tier: `major` for a rebase (and its stopped case), `minor` for a pure fast-forward, `none` when current.

`apply firstmate` never touches the clone or fork `main`:

- fast-forward - pushes upstream main to a `sync/upstream-<sha>` branch on the fork and opens a plain pull request through `gh` whose body states it is a pure upstream fast-forward (no review beyond fork CI, per the standing ruling).
- clean-rebase - replays the bespoke commits onto upstream main in a scratch worktree, pushes the rebased `sync/rebase-<sha>` branch through the no-mistakes gate initialised in the clone (`git push no-mistakes <branch>`); the branch name is the run's identity, and the gate's words are reported only when the push is refused.
- conflicts - refuses at plan time and names the conflicting files; nothing runs, so nothing is journaled.

The pin command is the fork main commit before the sync, spelled as the force push that would restore it - a history rewrite that remains the captain's explicit act, never this tool's. A non-GitHub fork remote is a fact, not an error: the class stands and only the plain-gh pull request is unavailable.

A manager that is missing reports one `installed=false` row. Adding a surface is one module in `src/surfaces/` plus one registry entry; the module contract is `detect`, `status`, `apply` (the fixed delegate argv; pin text lives on each row).

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
    "uv": { "enabled": false },
    "apt": { "rebootRequiredPath": "/var/run/reboot-required" },
    "cargo": { "applyTimeoutMs": 1800000 }
  }
}
```

- `name` - tool name as the owning manager reports it.
- `command` - executable probed on `PATH`; defaults to `name`.
- `version_args` - argv used to ask a copy of `command` its version; defaults to `["--version"]`.
- `announce_pattern` / `announce_args` - run the tool with `announce_args`, match `announce_pattern`, and report the match as the tool's own claim.
- `git` - accepted for watched-tools schema compatibility only; the firstmate surface describes its one subject with surface-level options, not per-tool entries.
- `rebootRequiredPath` - apt surface only: path of the reboot-required flag; defaults to `/var/run/reboot-required`.
- `applyTimeoutMs` - per-surface budget for each apply delegate, a positive integer of milliseconds; defaults to `900000`.
- `clonePath` - firstmate surface only: the local clone of the fork (default `/home/andre/tools/firstmate`); its remotes `upstream`/`origin` and branch `main` are fixed.

A configured entry the manager does not know reports `installed=false`. A malformed config is a usage error, never silently ignored.

## Development

```sh
npm install
npm run build
npm test        # builds, then runs the suite
npm run lint
npm run format:check
```

Tests exercise the CLI with fake vendor executables on a PATH that contains nothing else, so no test ever runs a real package manager or mutates the host. The firstmate fixtures are real git repositories in temporary directories with local-path remotes (no network); the fake `git` on the test PATH forwards to the real binary. The real probes are exercised by the opt-in live smoke (`UPKEEP_AXI_LIVE_SMOKE=1 npm test` runs one `status` against the host's real managers).

## Principles

[VISION.md](VISION.md) owns the acceptance policy: accuracy first, report and let the caller decide, delegate never reimplement, absent data stays absent, never root, tests never run a real updater.
