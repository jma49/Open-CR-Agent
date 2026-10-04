import { OcraError } from "./errors.js";

// An element whose index the caller's own bounds already guarantee (a loop
// over the array, a split that always has that part). Out of range is a bug
// in ocra, so it throws instead of handing back undefined; this is the one
// place that tells noUncheckedIndexedAccess so.
export function at<T>(items: ArrayLike<T>, index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new OcraError("INTERNAL", `index ${index} is outside a list of ${items.length}`);
  }
  return items[index] as T;
}
