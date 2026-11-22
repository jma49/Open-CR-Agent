import { describe, expect, it } from "vitest";
import type { FileDiff } from "../domain.js";
import type { Learning } from "./learning.js";
import { DEFAULT_SELECTION_LIMITS, learningSelector } from "./select.js";

function diff(path: string, patch = "", oldPath = path): FileDiff {
  return {
    oldPath,
    newPath: path,
    kind: oldPath === path ? "modified" : "renamed",
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
    patch,
  };
}

function learning(id: string, fields: Partial<Learning> = {}): Learning {
  return {
    id,
    title: `Learning ${id}`,
    body: `Body of ${id}.`,
    paths: ["nowhere/**"],
    symbols: [],
    keywords: [],
    critical: false,
    ...fields,
  };
}

const ids = (learnings: readonly Learning[]) => learnings.map((l) => l.id);
const select = (
  learnings: Learning[],
  files: FileDiff[],
  limits = DEFAULT_SELECTION_LIMITS,
  around?: string,
) => learningSelector(learnings, limits)(files, around);

describe("which learnings apply to a bundle", () => {
  it("selects nothing when there are no learnings", () => {
    expect(select([], [diff("src/a.ts")])).toEqual({ selected: [], left: [] });
  });

  it("selects a learning whose glob matches a file of the bundle", () => {
    const result = select(
      [learning("db", { paths: ["src/db/**"] }), learning("ui", { paths: ["web/**"] })],
      [diff("src/db/pool.ts")],
    );
    expect(ids(result.selected)).toEqual(["db"]);
    expect(result.left).toEqual([]);
  });

  it("matches the old path of a renamed file", () => {
    const result = select(
      [learning("db", { paths: ["src/db/**"] })],
      [diff("src/storage/pool.ts", "", "src/db/pool.ts")],
    );
    expect(ids(result.selected)).toEqual(["db"]);
  });

  it("matches files in dot directories", () => {
    const result = select([learning("ci", { paths: ["**/*.yml"] })], [diff(".github/ci.yml")]);
    expect(ids(result.selected)).toEqual(["ci"]);
  });

  it("takes any of several globs", () => {
    const result = select(
      [learning("sql", { paths: ["**/*.sql", "migrations/**"] })],
      [diff("migrations/0001/up.txt")],
    );
    expect(ids(result.selected)).toEqual(["sql"]);
  });

  it("selects a learning whose symbol the patch uses, off its paths", () => {
    const result = select(
      [learning("release", { symbols: ["releaseConnection"] })],
      [diff("api/handler.ts", "+  const c = await pool.releaseConnection(c);")],
    );
    expect(ids(result.selected)).toEqual(["release"]);
  });

  it("matches a symbol only as a whole identifier", () => {
    const result = select(
      [learning("release", { symbols: ["release"] })],
      [diff("api/handler.ts", "+ releaseAll(); prerelease; release_x; $release")],
    );
    expect(result.selected).toEqual([]);
  });

  it("matches a dotted symbol literally", () => {
    const files = [diff("a.ts", "+ Pool.release(c)")];
    expect(ids(select([learning("s", { symbols: ["Pool.release"] })], files).selected)).toEqual([
      "s",
    ]);
    expect(select([learning("s", { symbols: ["PoolXrelease"] })], files).selected).toEqual([]);
  });

  it.each([
    ["at the start of the patch", "release(c)"],
    ["at the end of the patch", "c.then(release"],
    ["after a later partial match", "releaseAll(); release()"],
    ["next to an astral-plane letter that is not part of it", "𝑥 release 𝑦"],
  ])("matches a whole symbol %s", (_, patch) => {
    const result = select([learning("r", { symbols: ["release"] })], [diff("a.ts", patch)]);
    expect(ids(result.selected)).toEqual(["r"]);
  });

  it("does not match a symbol joined to an astral-plane letter", () => {
    const result = select([learning("r", { symbols: ["release"] })], [diff("a.ts", "𝑥release")]);
    expect(result.selected).toEqual([]);
  });

  it("compiles a full repository of learnings quickly", () => {
    const learnings = Array.from({ length: 500 }, (_, i) =>
      learning(`l${i}`, { symbols: Array.from({ length: 20 }, (_, j) => `helper${i}x${j}`) }),
    );
    const patch = Array.from({ length: 400 }, (_, i) => `+ const v${i} = query(sql${i});`);
    const started = performance.now();
    learningSelector(learnings)([diff("a.ts", patch.join("\n"))]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("matches non-Latin symbols", () => {
    const result = select(
      [learning("s", { symbols: ["计算总价"] })],
      [diff("a.py", "+ total = 计算总价(order)")],
    );
    expect(ids(result.selected)).toEqual(["s"]);
  });

  it.each([
    ["camelCase", "+ const connectionPool = make();"],
    ["PascalCase", "+ new ConnectionPool()"],
    ["snake_case", "+ connection_pool = make()"],
    ["kebab-case", "+ connection-pool: 4"],
    ["prose", "+ // returns the connection to the pool"],
    ["upper case", "+ CONNECTION_POOL = 4"],
  ])("matches a keyword phrase written in %s", (_, patch) => {
    const result = select(
      [learning("pool", { keywords: ["connection pool"] })],
      [diff("a.ts", patch)],
    );
    expect(ids(result.selected)).toEqual(["pool"]);
  });

  it("matches a keyword written as one identifier against its words", () => {
    const result = select(
      [learning("oauth", { keywords: ["OAuthToken"] })],
      [diff("a.ts", "+ const oauth_token = read();")],
    );
    expect(ids(result.selected)).toEqual(["oauth"]);
  });

  it("does not match a keyword when only some of its words appear", () => {
    const result = select(
      [learning("pool", { keywords: ["connection pool"] })],
      [diff("a.ts", "+ const connection = open();")],
    );
    expect(result.selected).toEqual([]);
  });

  it("never selects on title words alone", () => {
    const result = select(
      [learning("t", { title: "Transactions must be committed" })],
      [diff("a.ts", "+ transactions committed")],
    );
    expect(result.selected).toEqual([]);
  });

  it("reads every file of the bundle", () => {
    const result = select(
      [learning("a", { paths: ["a/**"] }), learning("b", { symbols: ["beta"] })],
      [diff("a/x.ts"), diff("z/y.ts", "+ beta()")],
    );
    expect(ids(result.selected).sort()).toEqual(["a", "b"]);
  });
});

describe("the order of selected learnings", () => {
  it("ranks a path with evidence, then a symbol, then a bare path, then a keyword", () => {
    const result = select(
      [
        learning("keyword", { keywords: ["retry"] }),
        learning("path", { paths: ["src/**"] }),
        learning("symbol", { symbols: ["fetchAll"] }),
        learning("path-and-keyword", { paths: ["src/**"], keywords: ["retry"] }),
      ],
      [diff("src/a.ts", "+ fetchAll(); retry()")],
    );
    expect(ids(result.selected)).toEqual(["path-and-keyword", "symbol", "path", "keyword"]);
  });

  it("does not let lessons on a bare path crowd out one whose symbol the change uses", () => {
    const result = select(
      [
        ...Array.from({ length: 20 }, (_, i) => learning(`a${i}`, { paths: ["src/**"] })),
        learning("z-symbol", { symbols: ["fetchAll"] }),
      ],
      [diff("src/a.ts", "+ fetchAll()")],
    );
    expect(ids(result.selected)[0]).toBe("z-symbol");
  });

  it("ranks more symbol hits higher", () => {
    const result = select(
      [learning("one", { symbols: ["a1"] }), learning("two", { symbols: ["a1", "b2"] })],
      [diff("x.ts", "+ a1(); b2();")],
    );
    expect(ids(result.selected)).toEqual(["two", "one"]);
  });

  it("ranks by how many of the title's terms the patch holds", () => {
    const result = select(
      [
        learning("weak", { paths: ["src/**"], title: "Validate redirect targets" }),
        learning("strong", { paths: ["src/**"], title: "Escape redirect targets" }),
      ],
      [diff("src/a.ts", "+ escape(redirect)")],
    );
    expect(ids(result.selected)).toEqual(["strong", "weak"]);
  });

  it("breaks ties by id, whatever order the learnings came in", () => {
    const files = [diff("src/a.ts")];
    const a = learning("a", { paths: ["src/**"] });
    const b = learning("b", { paths: ["src/**"] });
    expect(ids(select([b, a], files).selected)).toEqual(["a", "b"]);
    expect(ids(select([a, b], files).selected)).toEqual(["a", "b"]);
  });
});

describe("the code around a change", () => {
  const crowded = [
    learning("a-bare", { paths: ["src/**"] }),
    learning("b-around", { paths: ["src/**"], symbols: ["client.release"] }),
    learning("c-elsewhere", { symbols: ["client.release"] }),
  ];

  it("ranks a learning on the bundle's paths whose symbol it uses above a bare path", () => {
    const around = "function load() {\n  client.release();\n}";
    const result = select(crowded, [diff("src/a.ts", "+ x")], DEFAULT_SELECTION_LIMITS, around);
    expect(ids(result.selected)).toEqual(["b-around", "a-bare"]);
  });

  it("ranks below a symbol in the patch itself", () => {
    const result = select(
      [learning("a-patch", { paths: ["src/**"], symbols: ["retry"] }), ...crowded],
      [diff("src/a.ts", "+ retry()")],
      DEFAULT_SELECTION_LIMITS,
      "client.release()",
    );
    expect(ids(result.selected)).toEqual(["a-patch", "b-around", "a-bare"]);
  });

  it("never makes a candidate of a learning off the bundle's paths", () => {
    const result = learningSelector(crowded)([diff("lib/a.ts", "+ x")], "client.release()");
    expect(result).toEqual({ selected: [], left: [] });
  });
});

describe("the limits of a selection", () => {
  const many = (n: number, fields: Partial<Learning> = {}) =>
    Array.from({ length: n }, (_, i) =>
      learning(`l${String(i).padStart(2, "0")}`, { paths: ["src/**"], ...fields }),
    );

  it("gives at most maxSelected learnings and reports the rest as left", () => {
    const result = select(many(8), [diff("src/a.ts")]);
    expect(result.selected).toHaveLength(DEFAULT_SELECTION_LIMITS.maxSelected);
    expect(ids(result.left)).toEqual(["l05", "l06", "l07"]);
  });

  it("skips a learning past the character budget and takes a smaller one after it", () => {
    const result = select(
      [
        learning("a", { paths: ["src/**"], body: "x".repeat(6_000) }),
        learning("b", { paths: ["src/**"], body: "x".repeat(3_000) }),
        learning("c", { paths: ["src/**"], body: "x".repeat(1_000) }),
      ],
      [diff("src/a.ts")],
    );
    expect(ids(result.selected)).toEqual(["a", "c"]);
    expect(ids(result.left)).toEqual(["b"]);
  });

  it("always gives a critical learning whose path matches, first", () => {
    const result = select(
      [
        ...many(5),
        learning("zz-critical", {
          paths: ["src/**"],
          critical: true,
          body: "x".repeat(10_000),
        }),
      ],
      [diff("src/a.ts")],
    );
    expect(ids(result.selected)[0]).toBe("zz-critical");
    expect(ids(result.left)).toEqual(["l00", "l01", "l02", "l03", "l04"]);
  });

  it("gives critical learnings past maxSelected, up to maxCritical", () => {
    const limits = { maxSelected: 2, maxChars: 8_000, maxCritical: 3 };
    const result = select(many(5, { critical: true }), [diff("src/a.ts")], limits);
    expect(ids(result.selected)).toEqual(["l00", "l01", "l02"]);
    expect(ids(result.left)).toEqual(["l03", "l04"]);
  });

  it("does not force a critical learning matched only by symbol", () => {
    const limits = { maxSelected: 1, maxChars: 8_000, maxCritical: 10 };
    const result = select(
      [
        learning("a-path", { paths: ["src/**"], keywords: ["drop"] }),
        learning("b-critical", { critical: true, symbols: ["drop"] }),
      ],
      [diff("src/a.ts", "+ drop()")],
      limits,
    );
    expect(ids(result.selected)).toEqual(["a-path"]);
    expect(ids(result.left)).toEqual(["b-critical"]);
  });
});
