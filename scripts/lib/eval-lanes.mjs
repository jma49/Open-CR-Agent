// The free golden eval's lanes (.github/eval-free-lanes.json, read by
// scripts/eval-lane.mjs): the model and ref each run reviews with, and the
// label its cycles are kept under.

const TIERS = ["smoke", "full", "adversarial"];
// OpenRouter's slugs: vendor/name, a :free variant included.
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DAY_MS = 86_400_000;

/**
 * @typedef {{ model: string, ref: string, tier: string }} Lane
 */

/**
 * The lanes of the file, checked as the workflow would check a dispatch.
 * @param {unknown} file
 * @returns {Lane[]}
 */
export function parseLanes(file) {
  const lanes = /** @type {{ lanes?: unknown }} */ (file)?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error("the file lists no lanes");
  return lanes.map((entry) => {
    const { model, ref, tier } = /** @type {Record<string, unknown>} */ (entry ?? {});
    if (typeof model !== "string" || typeof ref !== "string") {
      throw new Error("every lane needs a model and a ref");
    }
    return checkLane(model, ref, typeof tier === "string" ? tier : "smoke");
  });
}

/**
 * A lane from a dispatch's inputs, or the file's; refused unless every part
 * is a plain name. Only branches of this repository are reviewed (the
 * workflow checks that the branch exists there), so nothing that names a
 * pull request's head, a fork's branch or an option gets through.
 * @param {string} model
 * @param {string} ref
 * @param {string} tier
 * @returns {Lane}
 */
export function checkLane(model, ref, tier) {
  if (!MODEL.test(model)) throw new Error(`not an OpenRouter model: ${JSON.stringify(model)}`);
  if (
    !REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    /^(refs|pull)\//.test(ref)
  ) {
    throw new Error(`not a branch name: ${JSON.stringify(ref)}`);
  }
  if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}`);
  return { model, ref, tier };
}

/** @param {string} text */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The label of a lane's cycles without the cycle number; ocra-eval trend
 * groups runs by it. Model and ref slugs contain no "@".
 * @param {Lane} lane
 */
export function seriesName(lane) {
  return `free-${slug(lane.model)}@${slug(lane.ref)}-${lane.tier}`;
}

/**
 * The lanes in the order a scheduled run tries them: each run starts one
 * further along, by day and by the run's slot in the day, so with two lanes
 * the early run (which gets most of the day's requests) alternates daily
 * and the late run takes the other one.
 * @param {readonly Lane[]} lanes
 * @param {Date} now
 * @param {number} slot 0 for the run after the reset, 1 for the late one
 * @returns {Lane[]}
 */
export function rotation(lanes, now, slot) {
  const start = (Math.floor(now.getTime() / DAY_MS) + slot) % lanes.length;
  return [...lanes.slice(start), ...lanes.slice(0, start)];
}

/**
 * One line per lane for the workflow: model, ref, tier and series, tab-separated.
 * @param {Lane} lane
 */
export function laneLine(lane) {
  return [lane.model, lane.ref, lane.tier, seriesName(lane)].join("\t");
}
