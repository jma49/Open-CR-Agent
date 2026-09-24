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
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}
