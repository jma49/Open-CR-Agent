export const SECURITY_RULES = `### Security
- Injection from input that reaches an interpreter: SQL or NoSQL built from strings, shell commands, template rendering, LDAP or XPath, HTML without escaping (XSS), headers or log lines with raw newlines.
- Server-side request forgery and path traversal: URLs, hosts or file paths built from input without an allow-list or containment check, including archive extraction.
- Authentication and authorization: new routes, handlers, jobs or queries without the checks their neighbours apply; object access by id without an ownership or tenant check (IDOR); privilege or role checks that can be bypassed or were weakened.
- Secrets and sensitive data: credentials or tokens in code or config, secrets or personal data written to logs, errors, analytics or responses; session tokens or API keys exposed to the client.
- Cryptography: home-made crypto, weak or misused algorithms (MD5/SHA-1 for passwords, ECB, static IVs), non-cryptographic randomness for tokens, disabled certificate or signature verification, timing-unsafe secret comparison.
- Unsafe parsing: deserialization of untrusted data (pickle, Java serialization, YAML full loaders), XML external entities, prototype pollution through deep merges, regular expressions with catastrophic backtracking on input.
- Resource exhaustion from untrusted input: unbounded sizes, counts, recursion or allocation that an external caller controls.
- Configuration: permissive CORS with credentials, cookies without Secure/HttpOnly/SameSite where they carry sessions, debug modes or verbose errors enabled in production paths, world-writable files.
- CI and supply chain: untrusted pull request text or branch names interpolated into workflow \`run:\` steps, \`pull_request_target\` checking out untrusted code with secrets, broadened workflow permissions, new dependencies from unexpected sources or install scripts.`;
