export const GO_RULES = `### Go
- Errors that are ignored, overwritten before being checked, or wrapped with \`%v\` where callers rely on \`errors.Is\`/\`errors.As\`.
- Typed nil values stored in interfaces and then compared with \`nil\`; nil map writes; nil pointer dereferences reachable from real inputs.
- Goroutines that can block forever or outlive their owner; missing cancellation; \`context.Background()\` used where the caller's context should flow.
- \`WithCancel\`/\`WithTimeout\` whose cancel function is never called; timers or tickers left running.
- Data races on maps, slices or counters shared between goroutines; locks held across blocking I/O; copying values that contain a \`sync.Mutex\`.
- \`defer\` inside loops that delays cleanup until function exit; deferred \`Close\` errors dropped on write paths.
- Loop variable capture in goroutines or closures when the module targets Go older than 1.22.`;
