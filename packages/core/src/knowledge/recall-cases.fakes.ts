import { CORPUS } from "./recall-corpus.fakes.js";

// Changes labelled with the learnings a reviewer must be given (`expected`),
// those it must at least find listed when the limits leave them out
// (`listed`), and some off their paths it must not be given (`unrelated`).
// They are written the way such bugs recur: the learning's words are often
// absent, its symbol or path is not.
export interface RecallCase {
  name: string;
  // The first file's patch is `text`; the others change nothing readable.
  paths: (string | { from: string; to: string })[];
  text: string;
  // The code of the definitions the change touches, beyond the patch.
  around?: string;
  expected: string[];
  listed?: string[];
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
    name: "a leak fixed outside the db directory, named in a comment",
    paths: ["services/reports/src/export.ts"],
    text: "+  // avoid a connection leak: give the client back in finally\n+  const c = await getClient();",
    expected: ["db-pool-release"],
  },
  {
    name: "a column dropped from application code",
    paths: ["services/orders/src/schema.ts"],
    text: "+  await knex.schema.table('orders', (t) => t.dropColumn('total'));",
    expected: ["db-migrations-additive"],
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
    unrelated: ["db-pool-release", "billing-idempotency", "cache-key-tenant"],
  },
  {
    name: "a module moved out of the web app keeps its learnings",
    paths: [{ from: "apps/web/src/components/Feed.tsx", to: "packages/ui/src/Feed.tsx" }],
    text: "",
    expected: ["react-effect-cleanup", "react-list-keys", "i18n-no-literal"],
  },
  {
    name: "a query file below the root, against a learning written as *.sql",
    paths: ["db/queries/monthly-report.sql"],
    text: "+SELECT * FROM orders WHERE created_at > now() - interval '30 days' LIMIT 100;",
    expected: ["sql-no-select-star"],
    unrelated: ["api-pagination-cap"],
  },
  {
    name: "a compose file in a subdirectory, against a learning naming the file",
    paths: ["deploy/staging/docker-compose.yml"],
    text: "+  api:\n+    image: api:latest\n+    restart: always",
    expected: ["compose-healthcheck"],
  },
  {
    name: "a refund in a directory the learning names with a trailing slash",
    paths: ["services/payments/src/refund.ts"],
    text: "+  await db.payments.update(id, { status: 'refunded' });",
    expected: ["refunds-through-ledger"],
  },
  {
    name: "a Dockerfile spelled in lower case",
    paths: ["apps/admin/dockerfile"],
    text: '+FROM node:22-slim\n+CMD ["node", "server.js"]',
    expected: ["docker-non-root"],
  },
  {
    name: "a route under a bracketed directory, as ocra learn escapes it",
    paths: ["apps/site/app/[lang]/docs/page.tsx"],
    text: "+  const file = await readFile(join(root, params.lang, slug));",
    expected: ["next-route-params"],
  },
  {
    name: "rounding in a Python script, against a symbol named in TypeScript",
    paths: ["tools/reconcile/statement.py"],
    text: "+    total = round_half_even(sum(line.amount for line in lines))",
    expected: ["rounding-half-even"],
  },
  {
    name: "a charge in a Python service, against a camelCase symbol",
    paths: ["services/checkout/app/pay.py"],
    text: "+    result = gateway.create_charge(order.total, order.customer_id)",
    expected: ["billing-idempotency"],
  },
  {
    name: "a client taken with optional chaining",
    paths: ["services/reports/src/export.ts"],
    text: "+  const c = await this.pool?.connect();\n+  return c.query(sql);",
    expected: ["db-pool-release"],
  },
  {
    name: "a PHP logger call with an email",
    paths: ["apps/legacy/src/Mailer.php"],
    text: "+        $this->logger->info('sent to ' . $user->email);",
    expected: ["logs-no-pii"],
  },
  {
    name: "retries named in the plural",
    paths: ["services/sync/src/client.ts"],
    text: "+  // three retries, one second apart\n+  await sleep(1000);",
    expected: ["retry-backoff-jitter"],
  },
  {
    name: "subscriptions named in the plural outside the web app",
    paths: ["apps/mobile/src/hooks/useFeed.ts"],
    text: "+  const subscriptions = feeds.map((f) => f.listen(onItem));",
    expected: ["react-effect-cleanup"],
  },
  {
    name: "a Go consumer described only in a Chinese comment",
    paths: ["services/stream/internal/worker.go"],
    text: "+\t// 修复：处理失败时不再重复消费同一条消息\n+\treturn nil",
    expected: ["consumer-no-redelivery"],
  },
  {
    name: "a lesson recorded twice reaches the change twice",
    paths: ["services/orders/src/db/invoices.ts"],
    text: "+  const client = await pool.connect();\n+  await client.query(sql);\n+  client.release();",
    expected: ["db-pool-release", "db-pool-release-finally"],
  },
  {
    name: "a change across billing, auth and payments, past the limits",
    paths: [
      "services/billing/src/charge.ts",
      "services/billing/src/db/ledger.ts",
      "services/billing/src/cache/rates.ts",
      "services/billing/src/consumers/paid.ts",
      "services/auth/src/session/login.ts",
      "services/payments/src/refund.ts",
    ],
    text: "+  const charge = await stripe.charges.create({ amount, currency, customer });",
    expected: [
      "billing-idempotency",
      "auth-token-compare",
      "cache-key-tenant",
      "refunds-through-ledger",
    ],
    listed: [
      "money-integer-cents",
      "db-pool-release",
      "db-pool-release-finally",
      "queue-ack-after-commit",
      "consumer-no-redelivery",
      "auth-session-rotate",
    ],
  },
  {
    name: "a query edited inside a function that takes and releases a client",
    paths: ["services/orders/src/db/report.ts"],
    text: "-  const rows = await client.query(sql, from, to);\n+  const rows = await client.query(sql, [from, to]);",
    around:
      "export async function report(from, to) {\n  const client = await pool.connect();\n  const rows = await client.query(sql, [from, to]);\n  client.release();\n  return rows;\n}",
    expected: ["db-pool-release", "db-pool-release-finally"],
  },
  {
    name: "a callback edited inside a view method that hops to the main actor",
    paths: ["apps/ios/Sources/Feed/FeedView.swift"],
    text: "+                self.rows = items.filter { $0.visible }",
    around:
      "    func reload() {\n        api.fetch { items in\n            DispatchQueue.main.async {\n                self.rows = items.filter { $0.visible }\n            }\n        }\n    }",
    expected: ["mobile-main-thread"],
  },
  {
    name: "a tick edited inside an effect that starts an interval",
    paths: ["apps/web/src/components/Clock.tsx"],
    text: "+    const tick = () => setNow(Date.now());",
    around:
      "  useEffect(() => {\n    const tick = () => setNow(Date.now());\n    const id = setInterval(tick, 1000);\n  }, []);",
    expected: ["react-effect-cleanup"],
  },
];
