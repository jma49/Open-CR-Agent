import { describe, expect, it } from "vitest";
import { sequenceDiagram } from "./diagram.js";

const FLOW = [
  "sequenceDiagram",
  "participant CLI as ocra CLI",
  "participant API",
  "CLI->>API: POST /reviews",
  "alt accepted",
  "API-->>CLI: 202",
  "else refused",
  "API--xCLI: 403",
  "end",
  "Note over CLI, API: retried once",
].join("\n");

describe("sequenceDiagram", () => {
  it("keeps a plain sequence diagram, indented under its header", () => {
    expect(sequenceDiagram(FLOW)?.split("\n")).toEqual([
      "sequenceDiagram",
      "  participant CLI as ocra CLI",
      "  participant API",
      "  CLI->>API: POST /reviews",
      "  alt accepted",
      "  API-->>CLI: 202",
      "  else refused",
      "  API--xCLI: 403",
      "  end",
      "  Note over CLI, API: retried once",
    ]);
  });

  it.each([
    ["no diagram", ""],
    ["another diagram type", "flowchart LR\nA-->B\nB-->C"],
    ["an init directive", `${FLOW}\n%%{init: {"theme": "dark"}}%%`],
    ["a click handler", `${FLOW}\nclick API call alert()`],
    ["a link", `${FLOW}\nlink API: Docs @ https://example.com`],
    ["a backtick that would close the fence", `${FLOW}\nCLI->>API: \`\`\` done`],
    ["markup", `${FLOW}\nCLI->>API: <img src=x onerror=alert(1)>`],
    ["an ocra marker", `${FLOW}\nNote over API: <!-- ocra:state -->`],
    ["an unclosed block", "sequenceDiagram\nloop forever\nA->>B: ping"],
    ["a stray end", "sequenceDiagram\nA->>B: ping\nend"],
    ["prose", "sequenceDiagram\nThe CLI calls the API.\nA->>B: x"],
  ])("drops a diagram with %s", (_, text) => {
    expect(sequenceDiagram(text)).toBeUndefined();
  });

  it("drops a diagram longer than a reader can follow", () => {
    const long = ["sequenceDiagram", ...Array.from({ length: 41 }, (_, i) => `A->>B: step ${i}`)];
    expect(sequenceDiagram(long.join("\n"))).toBeUndefined();
  });
});
