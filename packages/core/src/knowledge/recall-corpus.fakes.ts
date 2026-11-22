import type { Learning } from "./learning.js";

// A synthetic team's learnings, written the way a team and `ocra learn`
// write them: globs in several styles, symbols in one language's naming,
// keywords in English and Chinese, and the same lesson twice.

type Fields = Pick<Learning, "title" | "body" | "paths"> & Partial<Learning>;

function learning(id: string, fields: Fields): Learning {
  return { id, symbols: [], keywords: [], critical: false, ...fields };
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
    paths: ["packages/http/**"],
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
    paths: ["packages/logger/**"],
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
    paths: ["packages/time/**"],
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
    paths: ["packages/process/**"],
    title: "Spawn processes with an argument array",
    symbols: ["exec(", "execSync(", "shell: true"],
    keywords: ["command injection"],
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
    paths: ["packages/http/**"],
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
  learning("db-pool-release-finally", {
    title: "Give pooled clients back in a finally block",
    paths: ["services/*/src/db/**"],
    symbols: ["client.release"],
    keywords: ["finally"],
    source: { kind: "review-feedback", ref: "#412" },
    body: "Release the client in finally, not after the query: a thrown query error skips the release and the pool runs dry.",
  }),
  learning("sql-no-select-star", {
    title: "Queries name their columns",
    paths: ["*.sql"],
    keywords: ["select star"],
    body: "SELECT * breaks readers when a column is added or reordered; name the columns.",
  }),
  learning("compose-healthcheck", {
    title: "Compose services declare a healthcheck",
    paths: ["docker-compose.yml"],
    keywords: ["depends_on"],
    body: "depends_on waits only for the container to start; give each service a healthcheck and wait on service_healthy.",
  }),
  learning("refunds-through-ledger", {
    title: "Refunds are written through the ledger",
    paths: ["services/payments/"],
    critical: true,
    body: "A refund that updates the payment row directly leaves the ledger unbalanced; post it with Ledger.reverse().",
  }),
  learning("rounding-half-even", {
    title: "Round money half to even",
    paths: ["packages/money/**"],
    symbols: ["roundHalfEven"],
    body: "Statements round half to even, as the bank does; Math.round or round() half up drifts by a cent per thousand lines.",
  }),
  learning("consumer-no-redelivery", {
    title: "消费者处理失败时不要重复消费",
    paths: ["services/*/src/consumers/**"],
    keywords: ["重复消费", "dead letter"],
    body: "处理失败的消息转入死信队列，不要直接 nack 重新投递：一条坏消息会被无限重复消费并阻塞整个分区。",
  }),
  learning("next-route-params", {
    title: "Route params are validated before use",
    paths: ["apps/site/app/\\[lang\\]/**"],
    symbols: ["params.lang"],
    body: "params.lang comes from the URL; check it against the supported locales before reading files with it.",
  }),
];
