export const PYTHON_RULES = `### Python
- Mutable default arguments or class attributes shared across calls or instances when per-call state was intended.
- Broad \`except\` (bare or \`Exception\`) that swallows errors, including \`KeyboardInterrupt\`/\`SystemExit\` via bare \`except\`, or re-raises without the original cause.
- Resources opened without \`with\` or \`try/finally\` on paths that can raise.
- Blocking calls inside \`async def\` code, coroutines that are never awaited, or tasks created without keeping a reference.
- Truthiness checks that misclassify valid values (\`0\`, \`""\`, empty collections) where \`is None\` was meant.
- Late-binding closures in loops, iteration while mutating the same collection, integer vs float division mistakes.
- SQL, shell or template strings built from input instead of parameters; \`pickle\`/\`yaml.load\` on untrusted data.`;
