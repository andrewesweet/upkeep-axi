# Issue tracker: tasks-axi

Every fleet work item for this repository lives in tasks-axi, the operator's firstmate
backlog, and the only way to read or change it is the `tasks-axi` CLI. The backlog file
(`/home/andre/tools/firstmate/data/backlog.md` on the operator's host) is never edited by
hand: a task's state, dependencies, holds, labels, PR and report links all move through the
CLI, which owns their validation.

## Conventions

- **Create a task**: `tasks-axi add <id> "<title>" --kind <ship|scout|docs|...> --repo upkeep-axi`, plus `--body <text>` or `--body-file <path>` for the brief, `--label` for triage roles, `--start` to place it in flight, and `--mint` to derive the id from the title.
- **Read a task**: `tasks-axi show <id> --full` — body, links, labels, dependencies and holds in one row.
- **List tasks**: `tasks-axi list --state queued|in_flight|done|held --repo <name> --label <name>`, with `--fields` for a projected view. `tasks-axi list --label needs-triage` is the front of the triage queue.
- **Change state**: `tasks-axi start <id>` (in flight), `tasks-axi done <id> --pr <url>|--report <path>|--note "<text>"`, `tasks-axi reopen <id>`.
- **Dependencies and holds**: `tasks-axi block <id> --by <other>`, `tasks-axi unblock <id> --by <other>`, `tasks-axi hold <id> --reason "<single-line text, no parentheses>" --kind captain|external|load|parked|future [--until YYYY-MM-DD]`, `tasks-axi unhold <id>`.
- **Edit**: `tasks-axi update <id> --label <name>` / `--unlabel <name>` / `--body-file <path> --archive-body`. The body replacement is whole-file, so rebuild it from the current body first.

## GitHub issues

GitHub issues exist only for outward-facing deliberation: bugs users file, maintainer
discussion, and public planning. They are not where fleet work is dispatched from — a GitHub
issue on its own puts nothing on the backlog, and this repository's own work items are not
mirrored there.

When a tasks-axi row touches a GitHub issue or pull request, the row records the link as
`gh:<owner>/<repo>#<n>` (in the body, or with `--pr <url>` when it is a pull request), so a
reader can join the backlog task and the public thread from either side. This repository's
public tracker is `andrewesweet/upkeep-axi`; use the `gh` CLI for it.

## When a skill says "publish to the issue tracker"

Add a tasks-axi task with `tasks-axi add`, writing the specification as the task body so the
next agent reads it back verbatim. Apply the triage role as a label in the same call (see
`triage-labels.md`); where the work also warrants public deliberation, open a GitHub issue and
record its `gh:` link on the row.

## When a skill says "fetch the relevant ticket"

Run `tasks-axi show <id> --full`. Follow any `gh:<owner>/<repo>#<n>` link on the row with
`gh issue view <number> --comments` (or `gh pr view <number> --comments`) when the public
thread matters.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a tasks-axi task with **child** tasks as tickets.

- **Map**: one task carrying the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a task linked to the map by `tasks-axi block <child> --by <map>` and named in the map body. A `Type:` line in the body (`research`/`prototype`/`grilling`/`task`) records the ticket type.
- **Frontier query**: `tasks-axi ready --repo upkeep-axi` — unblocked, unheld queued work, first in list order.
- **Claim**: `tasks-axi start <id>`, the session's first write.
- **Resolve**: `tasks-axi done <id> --note "<answer>"` (or `--report <path>`), then append a context pointer to the map's Decisions-so-far.
