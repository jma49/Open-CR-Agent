export const PERFORMANCE_RULES = `### Performance
- Algorithmic complexity that grows with input the code cannot bound: nested loops over the same collections, repeated linear searches or \`includes\` inside loops where a set or map fits, sorting inside loops.
- Round trips in loops: database queries, HTTP calls or file reads per item (N+1) where one batched call works; queries on new filters that fetch unbounded result sets without a limit or pagination.
- Blocking work on latency-sensitive paths: synchronous file, network or CPU-heavy work in request handlers, event loops, UI threads or \`async\` functions.
- Memory: whole files, streams or result sets buffered when their size is external; caches, maps or listener lists that grow without eviction or removal.
- Repeated work on hot paths: recomputation or re-parsing inside loops, regular expressions or serializers rebuilt per call, React renders triggered by unstable dependencies or props.
- Concurrency: independent I/O awaited one after another on a latency-critical path; unbounded parallelism that overwhelms a pool, a rate limit or memory.
- Regressions of existing optimizations: removed indexes, caches, batching, streaming or early exits.`;
