import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLAN_SCHEMA_ID, planJsonSchema } from "./plan-schema.js";

describe("planJsonSchema", () => {
  it("is what docs/schema/plan.v1.json holds (npm run schema regenerates it)", () => {
    const published = JSON.parse(
      readFileSync(new URL("../../../../../docs/schema/plan.v1.json", import.meta.url), "utf8"),
    );
    expect(published).toEqual(planJsonSchema());
    expect(published.$id).toBe(PLAN_SCHEMA_ID);
  });
});
