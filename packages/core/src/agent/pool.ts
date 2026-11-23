import { at } from "../at.js";
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(at(items, index));
    }
  });
  await Promise.all(runners);
  return results;
}

// Runs jobs as they are added, at most `limit` at a time, in the order added.
export function limiter(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (running >= Math.max(limit, 1)) await new Promise<void>((start) => waiting.push(start));
    else running += 1;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
