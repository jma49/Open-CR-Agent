// Prints "<open> <total>" for a free eval cycle's run directory: the cases
// still to review (no result, skipped, or lost to the quota) and all cases.
// QUOTA_RE is ocra-eval's test for a quota failure (eval-free.yml).
//
//   QUOTA_RE=… node scripts/eval-cycle.mjs <run dir>
import { errorMessage } from "./lib/error-message.mjs";
import { cycleState } from "./lib/eval-cycle.mjs";

const dir = process.argv[2];
const quota = process.env.QUOTA_RE;
if (!dir || !quota) {
  console.error("usage: QUOTA_RE=… node scripts/eval-cycle.mjs <run dir>");
  process.exit(2);
}
try {
  const { open, total } = cycleState(dir, new RegExp(quota, "i"));
  console.log(`${open} ${total}`);
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
