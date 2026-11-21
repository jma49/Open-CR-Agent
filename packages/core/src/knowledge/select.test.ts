import { describe, expect, it } from "vitest";
import type { Learning } from "./learning.js";
import {
  type ChangeScope,
  defaultLearningPolicy,
  indexLearnings,
  type LearningPolicy,
  type LearningWeights,
  selectLearnings,
} from "./select.js";
import { terms } from "./terms.js";

function learning(id: string, fields: Partial<Learning> = {}): Learning {
  return { id, title: id, critical: false, body: `Body of ${id}.`, ...fields };
}

const change = (paths: string[], text = "") => ({ paths, text });
const select = (
  learnings: Learning[],
  scope: ChangeScope,
  policy?: LearningPolicy,
  weights?: LearningWeights,
) => selectLearnings(indexLearnings(learnings), scope, policy, weights);
const ids = (list: { learning: Learning }[]) => list.map((m) => m.learning.id);

describe("terms", () => {
  it("splits identifiers and meets inflections at one stem", () => {
    expect(terms("closePool close_pool ClosedPools closing")).toEqual([
      "clos",
      "pool",
      "clos",
      "pool",
      "clos",
      "pool",
      "clos",
    ]);
    expect(terms("HTTPServer retries")).toEqual(["http", "server", "retry"]);
  });

  it("drops stop words, numbers and short words", () => {
    expect(terms("const x = await this.fn(42) and the id")).toEqual([]);
  });
});

describe("selectLearnings", () => {
  it("matches on a path glob, a symbol or a keyword", () => {
    const selection = select(
      [
        learning("by-path", { paths: ["src/db/**"] }),
        learning("by-symbol", { paths: ["lib/**"], symbols: ["withPool"] }),
        learning("by-keyword", { keywords: ["connection leak"] }),
        learning("elsewhere", { paths: ["docs/**"], symbols: ["render"] }),
      ],
      change(
        ["src/db/pool.ts"],
        "+ await withPool(async () => {}) // fixes a leak of each connection",
      ),
    );
    expect(ids(selection.included).sort()).toEqual(["by-keyword", "by-path", "by-symbol"]);
    expect(selection.included.find((m) => m.learning.id === "by-symbol")?.reasons).toEqual([
      "symbol",
    ]);
  });

  it("matches the old path of a renamed file", () => {
    const selection = select(
      [learning("old", { paths: ["src/legacy/**"] })],
      change(["src/legacy/a.ts", "src/next/a.ts"]),
    );
    expect(ids(selection.included)).toEqual(["old"]);
  });

  it("matches a symbol only as a whole identifier", () => {
    const pool = learning("pool", { paths: ["x/**"], symbols: ["Pool.close"] });
    expect(select([pool], change([], "pool.closeAll(); myPool.close()")).included).toEqual([]);
    expect(ids(select([pool], change([], "Pool.close();")).included)).toEqual(["pool"]);
    expect(select([pool], change([], "xPool.close()")).included).toEqual([]);
    expect(ids(select([pool], change([], "é Pool.close")).included)).toEqual(["pool"]);
  });

  it("matches a learning without paths on text alone only above the threshold", () => {
    const retry = learning("retry", {
      title: "Retry idempotent requests only",
      keywords: ["idempotency key"],
      body: "Retrying a POST without an idempotency key charges twice.",
    });
    const unrelated = change(["src/ui/button.tsx"], "+ <Button onClick={submit} />");
    expect(select([retry], unrelated).included).toEqual([]);
    const related = change(["src/pay.ts"], "+ await retryRequest(post, { retries: 3 }) // POST");
    expect(select([retry], related).included[0]?.reasons).toEqual(["text"]);
  });

  it("never matches a scoped learning on text alone", () => {
    const scoped = learning("scoped", {
      paths: ["src/pay/**"],
      title: "Retry idempotent requests only",
      body: "Retrying a POST request without an idempotency key charges twice.",
    });
    const text = "+ retryRequest(post) // retrying an idempotent POST request with a key";
    expect(select([scoped], change(["src/other.ts"], text)).included).toEqual([]);
  });

  it("shows at most maxEntries in full and indexes the rest, counting what is left over", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      learning(`l${String(i).padStart(2, "0")}`, { paths: ["src/**"] }),
    );
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxEntries: 3, maxIndexed: 4 };
    const selection = select(many, change(["src/a.ts"]), policy);
    expect(ids(selection.included)).toEqual(["l00", "l01", "l02"]);
    expect(ids(selection.indexed)).toEqual(["l03", "l04", "l05", "l06"]);
    expect(selection.omitted).toBe(5);
  });

  it("keeps the shown bodies within maxChars", () => {
    const big = learning("big", { paths: ["src/**"], symbols: ["a"], body: "x".repeat(900) });
    const small = learning("small", { paths: ["src/**"], body: "y".repeat(100) });
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxChars: 950 };
    const selection = select([big, small], change(["src/a.ts"], "a"), policy);
    expect(ids(selection.included)).toEqual(["big"]);
    expect(ids(selection.indexed)).toEqual(["small"]);
  });

  it("always shows a critical learning whose paths match, first, even over the limits", () => {
    const criticals = ["c1", "c2", "c3"].map((id) =>
      learning(id, { paths: ["src/auth/**"], critical: true }),
    );
    const strong = learning("strong", { paths: ["src/**"], symbols: ["login"] });
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxEntries: 2 };
    const selection = select(
      [strong, ...criticals],
      change(["src/auth/login.ts"], "login()"),
      policy,
    );
    expect(ids(selection.included)).toEqual(["c1", "c2", "c3"]);
    expect(ids(selection.indexed)).toEqual(["strong"]);
    expect(selection.warnings).toEqual([expect.stringContaining("3 critical learnings")]);
  });

  it("does not force a critical learning matched by symbol outside its paths", () => {
    const critical = learning("c", { paths: ["src/auth/**"], symbols: ["login"], critical: true });
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxEntries: 0 };
    const selection = select([critical], change(["src/ui.ts"], "login()"), policy);
    expect(selection.included).toEqual([]);
    expect(ids(selection.indexed)).toEqual(["c"]);
  });

  it("ranks by the history weight, within its bounds", () => {
    const a = learning("a", { paths: ["src/**"] });
    const b = learning("b", { paths: ["src/**"] });
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxEntries: 1 };
    const scope = change(["src/x.ts"]);
    expect(ids(select([a, b], scope, policy).included)).toEqual(["a"]);
    const clamped = new Map([
      ["a", 0],
      ["b", 0.01],
    ]);
    expect(ids(select([a, b], scope, policy, clamped).included)).toEqual(["a"]);
    const ignored = new Map([["b", Number.POSITIVE_INFINITY]]);
    expect(ids(select([a, b], scope, policy, ignored).included)).toEqual(["a"]);
    expect(ids(select([a, b], scope, policy, new Map([["b", 2]])).included)).toEqual(["b"]);
  });

  it("indexes a scoped learning that matches outside its paths on a keyword only", () => {
    const scoped = learning("charge", { paths: ["billing/**"], keywords: ["retry"] });
    const selection = select([scoped], change(["http/retry.ts"], "retry(fn)"));
    expect(selection.included).toEqual([]);
    expect(selection.indexed.map((m) => m.reasons)).toEqual([["keyword"]]);
  });

  it("looks for a keyword of stop words only as written", () => {
    const pin = learning("pin", { paths: ["ci/**"], keywords: ["uses"] });
    expect(select([pin], change(["x.yml"], "- uses: org/action@v3")).indexed).toHaveLength(1);
    expect(select([pin], change(["x.yml"], "- use: org/action@v3")).indexed).toEqual([]);
  });

  it("selects the same entries whatever order the learnings come in", () => {
    const list = [
      learning("p", { paths: ["src/**"], body: "pool connection timeout" }),
      learning("q", { paths: ["src/db/**"], symbols: ["query"] }),
      learning("r", { keywords: ["connection pool"], body: "pool connection" }),
      learning("s", { paths: ["src/**"] }),
    ];
    const scope = change(["src/db/a.ts"], "query(pool.connection)");
    const policy: LearningPolicy = { ...defaultLearningPolicy, maxEntries: 2 };
    const expected = select(list, scope, policy);
    for (const order of [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]) {
      const shuffled = order.map((i) => list[i] as Learning);
      expect(select(shuffled, scope, policy)).toEqual(expected);
    }
  });

  it("selects nothing from no learnings", () => {
    expect(select([], change(["a.ts"], "x"))).toEqual({
      included: [],
      indexed: [],
      omitted: 0,
      warnings: [],
    });
  });
});
