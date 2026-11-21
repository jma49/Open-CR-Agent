import type { Learning } from "./learning.js";

// A synthetic team's learnings and changes, each change labelled with the
// learnings a reviewer must see (`expected`) and some it must not be shown in
// full (`unrelated`). The changes are written the way such bugs recur: the
// learning's words are often absent, its symbol or path is not.

function learning(id: string, fields: Omit<Learning, "id" | "critical"> & { critical?: boolean }) {
  return { id, critical: false, ...fields } satisfies Learning;
}

export const CORPUS: Learning[] = [
  learning("db-pool-release", {
    title: "Release the database client on every exit path",
    paths: ["services/*/src/db/**"],
    symbols: ["pool.connect", "client.release"],
    keywords: ["connection leak"],
    body: "A client taken with pool.connect() and not released in finally leaks; the pool hangs once it is exhausted.",
  }),
  learning("db-migrations-additive", {
    title: "Migrations stay additive while two versions run",
    paths: ["services/*/migrations/**"],
    keywords: ["drop column", "rename column"],
    critical: true,
    body: "Rolling deploys run old and new code together: add the column, backfill, switch reads, and drop it a release later.",
  }),
  learning("money-integer-cents", {
    title: "Money is integer cents, never floats",
    paths: ["services/billing/**", "packages/money/**"],
    symbols: ["parseFloat", "toFixed"],
    keywords: ["amount", "price"],
    body: "Amounts are integer minor units; parseFloat and toFixed round. Convert with Money.fromDecimalString.",
  }),
  learning("billing-idempotency", {
    title: "Charge requests carry an idempotency key",
    paths: ["services/billing/src/**"],
    symbols: ["stripe.charges.create", "createCharge"],
    keywords: ["idempotency key", "retry"],
    critical: true,
    body: "A retried charge without an idempotency key charges twice. Derive the key from the order id.",
  }),
  learning("auth-token-compare", {
    title: "Compare secrets in constant time",
    paths: ["services/auth/**"],
    symbols: ["timingSafeEqual"],
    keywords: ["token", "signature", "hmac"],
    critical: true,
    body: "Use crypto.timingSafeEqual for tokens and signatures; === leaks the length of the common prefix.",
  }),
  learning("auth-session-rotate", {
    title: "Rotate the session id after login",
    paths: ["services/auth/src/session/**"],
    symbols: ["req.session.regenerate"],
    keywords: ["session fixation"],
    body: "Call req.session.regenerate() after a successful login so a pre-login session id cannot be fixed.",
  }),
  learning("http-timeouts", {
    title: "Outgoing HTTP calls set a timeout",
    symbols: ["fetch", "axios.get", "axios.post"],
    keywords: ["timeout", "AbortSignal"],
    body: "Every outgoing request passes AbortSignal.timeout(); an upstream that hangs otherwise holds the worker forever.",
  }),
  learning("queue-ack-after-commit", {
    title: "Acknowledge a queue message only after the commit",
    paths: ["services/*/src/consumers/**"],
    symbols: ["message.ack", "channel.ack"],
    keywords: ["acknowledge", "at least once"],
    body: "Ack after the transaction commits; acking first loses the message if the commit fails.",
  }),
  learning("react-effect-cleanup", {
    title: "Effects that subscribe return a cleanup",
    paths: ["apps/web/src/**"],
    symbols: ["useEffect", "addEventListener", "setInterval"],
    keywords: ["subscription", "memory leak"],
    body: "A useEffect that adds a listener or interval returns a function removing it; otherwise it leaks on every remount.",
  }),
  learning("react-list-keys", {
    title: "List keys are stable ids, not indexes",
    paths: ["apps/web/src/**/*.tsx"],
    symbols: ["key={index}", "key={i}"],
    body: "Index keys reorder state when items move. Use the item's id.",
  }),
  learning("i18n-no-literal", {
    title: "User-facing text comes from the message catalog",
    paths: ["apps/web/src/components/**", "apps/web/src/pages/**"],
    symbols: ["t("],
    keywords: ["translation", "i18n"],
    body: "Visible strings go through t('key'); a literal is not translated.",
  }),
  learning("logs-no-pii", {
    title: "Never log personal data or credentials",
    symbols: ["logger.info", "logger.debug", "console.log"],
    keywords: ["email", "password", "personal data"],
    body: "Log ids, not emails, names, tokens or request bodies. The log pipeline is not access-controlled.",
  }),
  learning("cache-key-tenant", {
    title: "Cache keys include the tenant",
    paths: ["services/*/src/cache/**"],
    symbols: ["redis.get", "redis.set", "cacheKey"],
    keywords: ["tenant", "cache key"],
    critical: true,
    body: "A key without the tenant id serves one customer's data to another.",
  }),
  learning("feature-flag-default-off", {
    title: "New feature flags default to off",
    paths: ["config/flags/**"],
    keywords: ["feature flag", "default"],
    body: "A flag defaults to false in every environment; it is turned on per environment, never in code.",
  }),
  learning("date-utc", {
    title: "Store and compare times in UTC",
    symbols: ["new Date(", "getHours", "setHours", "toLocaleDateString"],
    keywords: ["timezone", "utc"],
    body: "Server code keeps instants in UTC; local hours shift with the host's timezone and with daylight saving.",
  }),
  learning("graphql-n-plus-one", {
    title: "Resolvers batch lookups through a loader",
    paths: ["services/api/src/resolvers/**"],
    symbols: ["DataLoader", "findById"],
    keywords: ["n+1", "batch"],
    body: "A resolver calling findById per parent runs one query per row; go through the request's DataLoader.",
  }),
  learning("api-pagination-cap", {
    title: "List endpoints cap the page size",
    paths: ["services/api/src/routes/**"],
    symbols: ["limit", "pageSize"],
    keywords: ["pagination"],
    body: "Clamp limit to MAX_PAGE_SIZE; an uncapped limit lets one request read the whole table.",
  }),
  learning("shell-exec-args", {
    title: "Spawn processes with an argument array",
    symbols: ["exec(", "execSync(", "shell: true"],
    keywords: ["command injection"],
    critical: false,
    body: "exec and shell: true pass a string to a shell; use execFile or spawn with an argument array.",
  }),
  learning("ci-pin-actions", {
    title: "Pin third-party actions to a commit",
    paths: [".github/workflows/**"],
    keywords: ["uses"],
    body: "A tag can be moved; pin actions to a full commit sha with the tag in a comment.",
  }),
  learning("docker-non-root", {
    title: "Containers run as a non-root user",
    paths: ["**/Dockerfile", "**/*.dockerfile"],
    symbols: ["USER"],
    body: "End the image with USER node (or another unprivileged user).",
  }),
  learning("mobile-main-thread", {
    title: "UI updates happen on the main thread",
    paths: ["apps/ios/**/*.swift"],
    symbols: ["DispatchQueue.main", "@MainActor"],
    keywords: ["main thread"],
    body: "Completion handlers run on a background queue; hop to the main actor before touching views.",
  }),
  learning("search-escape-query", {
    title: "Escape user input in search queries",
    paths: ["services/search/**"],
    symbols: ["query_string", "escapeQuery"],
    keywords: ["search query"],
    body: "Raw user text in a query_string query lets a user run wildcard and field queries; escape it or use match.",
  }),
  learning("retry-backoff-jitter", {
    title: "Retries back off with jitter",
    keywords: ["retry", "backoff"],
    body: "Fixed-interval retries synchronize clients into a thundering herd; use exponential backoff with full jitter.",
  }),
  learning("email-unsubscribe", {
    title: "Marketing email carries an unsubscribe link",
    paths: ["services/notifications/src/templates/marketing/**"],
    keywords: ["unsubscribe"],
    body: "Every marketing template includes {{unsubscribeUrl}}; it is a legal requirement.",
  }),
];

export interface RecallCase {
  name: string;
  paths: string[];
  text: string;
  expected: string[];
  unrelated?: string[];
}

export const CASES: RecallCase[] = [
  {
    name: "a query helper that forgets to release",
    paths: ["services/orders/src/db/orders.ts"],
    text: "+  const client = await pool.connect();\n+  const rows = await client.query(sql);\n+  return rows;",
    expected: ["db-pool-release"],
    unrelated: ["react-effect-cleanup", "money-integer-cents"],
  },
  {
    name: "a migration that renames a column",
    paths: ["services/orders/migrations/20261121_rename.sql"],
    text: "+ALTER TABLE orders RENAME COLUMN total TO total_cents;",
    expected: ["db-migrations-additive"],
  },
  {
    name: "a price computed with parseFloat in a shared package",
    paths: ["packages/money/src/format.ts"],
    text: "+export const toAmount = (s: string) => parseFloat(s) * 100;",
    expected: ["money-integer-cents"],
  },
  {
    name: "a new charge call in billing",
    paths: ["services/billing/src/charge.ts"],
    text: "+  const charge = await stripe.charges.create({ amount, currency, customer });",
    expected: ["billing-idempotency", "money-integer-cents"],
  },
  {
    name: "a retry around the charge client",
    paths: ["services/billing/src/client.ts"],
    text: "+  for (let attempt = 0; attempt < 3; attempt++) {\n+    try { return await createCharge(order); } catch {}\n+  }",
    expected: ["billing-idempotency"],
  },
  {
    name: "a webhook signature check with ===",
    paths: ["services/auth/src/webhooks/verify.ts"],
    text: "+  if (computed === header) return true;\n+  // hmac signature of the body",
    expected: ["auth-token-compare"],
  },
  {
    name: "a login handler that keeps the session",
    paths: ["services/auth/src/session/login.ts"],
    text: "+  req.session.userId = user.id;\n+  res.redirect('/');",
    expected: ["auth-session-rotate"],
  },
  {
    name: "a fetch without a signal in any service",
    paths: ["services/search/src/upstream.ts"],
    text: "+  const res = await fetch(base + '/v1/items');",
    expected: ["http-timeouts"],
  },
  {
    name: "an axios call in the web app",
    paths: ["apps/web/src/api/client.ts"],
    text: "+export const getUser = (id: string) => axios.get('/api/users/' + id);",
    expected: ["http-timeouts"],
  },
  {
    name: "a consumer that acks first",
    paths: ["services/orders/src/consumers/paid.ts"],
    text: "+  channel.ack(msg);\n+  await db.transaction(async (tx) => markPaid(tx, id));",
    expected: ["queue-ack-after-commit"],
  },
  {
    name: "a component that adds a resize listener",
    paths: ["apps/web/src/components/Chart.tsx"],
    text: "+  useEffect(() => {\n+    window.addEventListener('resize', onResize);\n+  }, []);",
    expected: ["react-effect-cleanup"],
  },
  {
    name: "a list rendered with index keys",
    paths: ["apps/web/src/pages/Orders.tsx"],
    text: "+  {orders.map((o, index) => <Row key={index} order={o} />)}",
    expected: ["react-list-keys"],
  },
  {
    name: "a log line with the user's email",
    paths: ["services/notifications/src/send.ts"],
    text: "+  logger.info('sent welcome mail to ' + user.email);",
    expected: ["logs-no-pii"],
  },
  {
    name: "a debug print in the web app",
    paths: ["apps/web/src/hooks/useCart.ts"],
    text: "+  console.log('cart', cart);",
    expected: ["logs-no-pii"],
  },
  {
    name: "a cache read keyed by user only",
    paths: ["services/api/src/cache/profile.ts"],
    text: "+  const hit = await redis.get('profile:' + userId);",
    expected: ["cache-key-tenant"],
  },
  {
    name: "a flag turned on by default",
    paths: ["config/flags/checkout.yaml"],
    text: "+newCheckout:\n+  default: true",
    expected: ["feature-flag-default-off"],
  },
  {
    name: "a report that buckets by local hour",
    paths: ["services/analytics/src/daily.ts"],
    text: "+  const hour = new Date(event.at).getHours();",
    expected: ["date-utc"],
  },
  {
    name: "a resolver that looks up each author",
    paths: ["services/api/src/resolvers/post.ts"],
    text: "+  author: (post) => Users.findById(post.authorId),",
    expected: ["graphql-n-plus-one"],
  },
  {
    name: "a list route that trusts the limit",
    paths: ["services/api/src/routes/orders.ts"],
    text: "+  const limit = Number(req.query.limit);\n+  return db.orders.list({ limit });",
    expected: ["api-pagination-cap"],
  },
  {
    name: "a build script that shells out",
    paths: ["scripts/release.ts"],
    text: "+  execSync('git tag ' + version);",
    expected: ["shell-exec-args"],
  },
  {
    name: "a workflow on a moving tag",
    paths: [".github/workflows/ci.yml"],
    text: "+      - uses: some-org/setup-thing@v3",
    expected: ["ci-pin-actions"],
  },
  {
    name: "a new service image",
    paths: ["services/search/Dockerfile"],
    text: '+FROM node:22-slim\n+COPY . .\n+CMD ["node", "dist/main.js"]',
    expected: ["docker-non-root"],
  },
  {
    name: "a view updated from a network callback",
    paths: ["apps/ios/Sources/Profile/ProfileView.swift"],
    text: "+    api.load { profile in self.nameLabel.text = profile.name }",
    expected: ["mobile-main-thread"],
  },
  {
    name: "a search endpoint passing raw text",
    paths: ["services/search/src/routes/search.ts"],
    text: "+  body: { query: { query_string: { query: req.query.q } } }",
    expected: ["search-escape-query"],
  },
  {
    name: "a retry loop with a fixed sleep",
    paths: ["packages/http/src/retry.ts"],
    text: "+  // retry three times\n+  await sleep(1000);\n+  return retry(fn, attempts - 1);",
    expected: ["retry-backoff-jitter"],
    unrelated: ["billing-idempotency"],
  },
  {
    name: "a new marketing template",
    paths: ["services/notifications/src/templates/marketing/winter.hbs"],
    text: "+<h1>Winter sale</h1>\n+<p>{{body}}</p>",
    expected: ["email-unsubscribe"],
  },
  {
    name: "a renamed module keeps the old path's learnings",
    paths: ["services/orders/src/db/legacy.ts", "services/orders/src/storage/legacy.ts"],
    text: "",
    expected: ["db-pool-release"],
  },
  {
    name: "a docs-only change",
    paths: ["docs/architecture.md"],
    text: "+The orders service owns the order lifecycle.",
    expected: [],
    unrelated: CORPUS.map((l) => l.id),
  },
  {
    name: "a CSS change",
    paths: ["apps/web/src/styles/theme.css"],
    text: "+  --accent: var(--ink);",
    expected: [],
    unrelated: ["db-pool-release", "billing-idempotency", "cache-key-tenant", "logs-no-pii"],
  },
];
