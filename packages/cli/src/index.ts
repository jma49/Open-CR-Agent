// The public API of @open-cr-agent/cli, a contract under the 0.x rule
// (manual: Embedding, Stability); etc/cli.api.md records it. What the
// other workspace packages need beyond this comes from
// "@open-cr-agent/cli/internal", which is not a contract.
import { defaultDeps, run as runWith } from "./run.js";

// The `ocra` command with its arguments (no node or script path), writing
// to stdout and stderr; resolves to the exit code.
export function run(argv: readonly string[]): Promise<number> {
  return runWith([...argv], process.stdout, process.stderr, defaultDeps());
}
