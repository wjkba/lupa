#!/usr/bin/env node
import { main } from "./server";

main().catch((e) => {
  process.stderr.write(`[loupe] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
