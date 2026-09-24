export const TYPESCRIPT_RULES = `### TypeScript and JavaScript
- Promises that are neither awaited, returned nor explicitly handled, so failures become unhandled rejections or ordering is lost; \`forEach\` with async callbacks that callers assume completed.
- \`await\` inside loops where independent work was meant to run concurrently, or \`Promise.all\` over work that must be sequential or bounded.
- Truthiness checks that misclassify valid values (\`0\`, \`""\`, \`NaN\`, \`false\`) where \`??\` or an explicit comparison was needed; \`==\` comparisons with surprising coercion.
- Type assertions (\`as\`, non-null \`!\`, \`any\`) that bypass a check the runtime data can actually fail; parsed external data used without validation.
- Mutation of arguments, shared module state or React state/props in place; missing or wrong hook dependencies that cause stale values or infinite loops.
- Floating timers, listeners or subscriptions without cleanup on unmount, abort or error.
- \`JSON.parse\`, \`new URL\`, \`BigInt\` and similar calls on external input without handling their exceptions.`;
