# Vision

`upkeep-axi` exists so that one command can say what is installed on this workstation, what is available, and the exact command that closes each gap.
It serves an agent--run fleet first and the people who run it second, and it turns each vendor's own inventory and update checks into one normalized report.
It owns exactly one thing: the accurate report of update state across surfaces.

## Accuracy is the first obligation

Reporting an accurate gap is the highest priority, and every other rule yields to it.
A tool that is current must never read as behind, and an update that silently did not take effect must never read as applied.
When a constraint would force upkeep-axi to publish something false, the constraint is narrowed to the smallest carve-out that restores the truth, and that carve-out is documented.
PATH skew is measured, not inferred: every copy of a command on `PATH` is asked for its version, and a newer copy behind the resolved one is reported as "update not in effect".

## It reports, the caller decides

upkeep-axi publishes facts - installed version, available version, semver tier, the exact apply and pin commands - and the caller decides what to do.
`apply` plans by default and acts only on an explicit `--execute`; the captain's word, never a schedule, triggers a mutation in version one.
A gap classified as `major` is published so it can be considered, not so it can be applied casually.
Firstmate may poll `status` daily and relay what changed; deciding what to update stays above the tool.

## Delegate, never reimplement

Every mutation runs the vendor's own updater with a fixed argument vector declared in the surface module.
upkeep-axi never manages versions itself, never assembles updater argv at runtime, and never gives a delegate an interactive surface, because a second implementation of an ecosystem's update logic is a way to corrupt that ecosystem.
A delegate that refuses is reported verbatim and never retried: guards in other tools are respected, not worked around.
A delegate that outruns its budget is left running - never killed mid-write - and reported as unconfirmed.
Reading a vendor's update announcement is likewise delegation: the configured pattern reports the tool's own claim, and upkeep-axi adds nothing to it.

## Absent data stays absent

Every fact reported is a fact a vendor reported or one upkeep-axi measured itself.
It never invents a version, a tier, or an announcement.
A tool whose latest version could not be learned has no latest and no tier; a surface whose manager is missing reports exactly that, once.
A gap whose versions do not both parse is `major` - that is not an invention but the published rule that an unknown-shape update is never casual.
Uncertainty gets louder as it propagates: unknown facts render as absent, never as zero and never as a plausible guess.

## Never root

The tool refuses to run as root.
apt is report-only with the exact `sudo apt-get` commands and the reboot-required state, because applying them is the captain's act, run by the captain.
No surface mutates anything the vendor's own updater would not, and no surface runs outside this WSL2 Ubuntu host in version one.

## Fixes land as machinery

A bug that can recur across surfaces is fixed once, in shared code, for every surface.
Tier computation, the PATH probe, and the announcement probe each have exactly one implementation and one spelling.
Adding a surface is one module plus one config entry; the module contract (`detect`, `status`, `apply`, `pin`) never changes shape to admit one.
Change is additive by default; a published shape change is deliberate, versioned, and documented in the same change that makes it.
A deviation from prior behavior is named as a decision in the change that makes it, so nothing later reads as an accident.

## The output is a budget

Default output is compact TOON because its reader is an agent that pays per token to parse it.
One row per tool carries the facts a caller needs to act; sparse facts - skew, announcements, probe failures - live in their own blocks instead of widening every row.
`--json` emits the normalized model with no renames and no re-nesting.
Help lines name the next command; the help block never grows a third generic hint while two carry the weight.

## Tests never run a real updater

Every test exercises the CLI's external behaviour against fake vendor executables on a PATH that contains nothing else, so the suite is safe on any machine and can never mutate the host it runs on.
The real probes are exercised deliberately by one opt-in live smoke behind an environment flag, never by the suite.
The journal's records and the Firstmate sync classifier's verdicts get the same treatment: fixtures in temporary directories, never live state.

## Scope

upkeep-axi is not a package manager, not a version manager, not a scheduler, and not a fleet supervisor.
Delegating one update to the CLI that owns an ecosystem does not make it any of those.
It does not replace Firstmate's watched-tools check; it describes tools with the same field names so both can agree.
Rollback machinery is out of scope by design: the journal carries the pin command instead, so rollback is a copy and paste, not a subsystem.
The tool stays private to this workflow while public as source; nothing is published to npm or the AXI catalogue.

A change aligns when it makes a real update fact readable that was previously unreadable or wrong, keeps every existing path working, and leaves the decision with the caller.
A change should be resisted when it reimplements a vendor's updater, applies anything without the captain's word, publishes a guess, or grows the surface into a product this is not.
