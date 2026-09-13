---
name: upkeep-axi
description: >
  Report this workstation's update inventory via the upkeep-axi CLI - installed vs available versions per surface (npm, mise, uv, cargo, bun, gh, skills, fnm, apt, claude, codex, opencode, pi, herdr, no-mistakes, the Firstmate fork sync), the semver tier of each gap, whether the tool is in use, PATH skew, and the exact apply and pin commands. Use when the user asks what is outdated, before updating or pinning workstation tools, when checking whether an update took effect, or before applying updates with upkeep-axi apply.
user-invocable: false
---

# upkeep-axi

Report workstation update inventory across surfaces. Read-only `status` reports installed vs available versions,
the semver tier of each gap, in-use conflicts, PATH skew, and the exact
commands that apply or pin each tool. `apply` plans by default and runs a
vendor's own updater only with `--execute`; every run is journaled. The tool
never runs as root, and `apt` is report-only.

Commands (kept identical to the CLI's own top-level help):

- `status` - report the update inventory (the default command)
- `apply` - plan updates for named surfaces or --all; runs only with --execute
- `journal` - print the append-only record of executed applies
- `setup` - install or repair the session-start hooks (`setup hooks`)
- `ambient` - the bounded session-start dashboard (what the hooks inject)

For the live inventory and current flags, run the CLI from its source
checkout on this host (it is not published to npm):

- `upkeep-axi` - the full inventory (TOON; add `--json` for the model)
- `upkeep-axi status --help` - status flags, including drift filters
- `upkeep-axi ambient` - the bounded dashboard (gaps and in-use conflicts only)
- `upkeep-axi setup hooks` - install the session-start hook that injects that
  dashboard at every agent session start (the hook is the primary, ambient
  path; this skill is the secondary, on-demand one - either alone suffices)
