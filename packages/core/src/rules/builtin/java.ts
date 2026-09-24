export const JAVA_RULES = `### Java
- \`equals\`/\`hashCode\` inconsistencies, reference comparison (\`==\`) of strings or boxed numbers, and unboxing of possibly-null values.
- Resources not closed with try-with-resources on paths that can throw; streams, connections or locks leaked on error.
- Exceptions caught and ignored, logged and then treated as success, or rethrown without the cause.
- Shared mutable state accessed from multiple threads without synchronization; non-thread-safe types (\`SimpleDateFormat\`, \`HashMap\`) in shared fields; double-checked locking without \`volatile\`.
- \`Optional.get()\` or collection access without checking presence; modification of a collection while iterating it.
- Transaction boundaries that do not cover all related writes; \`@Transactional\` on private or self-invoked methods.
- SQL or JPQL built by string concatenation from input; deserialization of untrusted data.`;
