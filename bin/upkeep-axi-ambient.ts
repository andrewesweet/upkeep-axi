#!/usr/bin/env node
// Session-start hook entrypoint (AXI ambient context). The SDK-installed
// hook command carries no arguments, so the bounded `ambient` dashboard -
// known gaps only, in-use gaps first - lives behind this dedicated
// entrypoint instead of a flag. Humans preview it with `upkeep-axi ambient`.
import { main } from "../src/cli.js";

await main({ argv: ["ambient"] });
