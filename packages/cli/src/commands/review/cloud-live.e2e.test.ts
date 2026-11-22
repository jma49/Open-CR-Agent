import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";
import { PREFERENCES, signedIn } from "./cloud.fakes.js";

// A signed-in review relays its events while it runs, only for an account
// that shares findings (ADR-0056).

afterEach(removeRepos);

const SALT = "5".repeat(64);
const WATCH = "https://cloud.test/live/r";
const sharing = {
  "/api/account/salt": () => Response.json({ salt: SALT }),
  "/api/reviews": () => Response.json({ id: "r1" }),
  "/api/live": () => Response.json({ watch: WATCH }),
};
type Batch = { run: { source: string }; events: { kind: string; seq: number }[] };

describe("the live relay of a review", () => {
  it("sends every event of the run, in order, and says where to watch it", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn({}, PREFERENCES, false, sharing);
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, critical, { cloud }, true));
    const batches = calls.filter((c) => c.path === "/api/live").map((c) => c.body as Batch);
    const events = batches.flatMap((b) => b.events);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]?.kind).toBe("started");
    expect(events.map((e) => e.kind)).toContain("finding");
    expect(events.at(-1)?.kind).toBe("finished");
    expect(batches[0]?.run.source).toBe("local");
    expect(err.text().match(/Watch this review live/g)).toHaveLength(1);
    expect(err.text()).toContain(WATCH);
  });

  it("sends nothing for an account that does not share findings, or with --no-upload", async () => {
    const counts = { ...sharing, "/api/account/salt": () => Response.json({ salt: null }) };
    for (const [routes, args] of [
      [counts, ["review"]],
      [sharing, ["review", "--no-upload"]],
    ] as const) {
      const cwd = repoWithChange();
      const { cloud, calls } = signedIn({}, PREFERENCES, false, routes);
      await run([...args], capture(), capture(), deps(cwd, critical, { cloud }, true));
      expect(calls.map((c) => c.path)).not.toContain("/api/live");
    }
  });

  it("keeps reviewing when ocra Cloud cannot take the events", async () => {
    const cwd = repoWithChange();
    const down = { ...sharing, "/api/live": () => new Response("", { status: 503 }) };
    const { cloud, calls } = signedIn({}, PREFERENCES, false, down);
    const out = capture();
    const err = capture();
    await run(["review", "--format", "json"], out, err, deps(cwd, critical, { cloud }, true));
    expect(JSON.parse(out.text()).findings).toHaveLength(1);
    expect(err.text()).toContain("stopped relaying this review to ocra Cloud live (HTTP 503)");
    expect(calls.map((c) => c.path)).toContain("/api/reviews");
  });
});
