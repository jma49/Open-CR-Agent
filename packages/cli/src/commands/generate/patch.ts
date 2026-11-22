import type { FileEdit } from "@open-cr-agent/core/internal";

const CONTEXT = 3;

type Insert = Extract<FileEdit, { kind: "insert" }>;

// ocra's edits as a unified diff `git apply` takes: built from the edits
// themselves, which only add files and lines, so no line matching is needed.
export function renderPatch(edits: readonly FileEdit[]): string {
  return edits.map((e) => (e.kind === "create" ? created(e) : inserted(e)).join("\n")).join("\n");
}

function created({ path, content }: Extract<FileEdit, { kind: "create" }>): string[] {
  const { lines, ends } = linesOf(content);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    ...(ends ? [] : ["\\ No newline at end of file"]),
    "",
  ];
}

function inserted(edit: Insert): string[] {
  const { lines, ends } = linesOf(edit.original);
  const out = [
    `diff --git a/${edit.path} b/${edit.path}`,
    `--- a/${edit.path}`,
    `+++ b/${edit.path}`,
  ];
  let shift = 0;
  for (const group of hunks(edit.insertions)) {
    const from = Math.max(0, (group[0]?.after ?? 0) - CONTEXT);
    const to = Math.min(lines.length, (group.at(-1)?.after ?? 0) + CONTEXT);
    const added = group.reduce((n, i) => n + i.lines.length, 0);
    out.push(`@@ -${from + 1},${to - from} +${from + 1 + shift},${to - from + added} @@`);
    for (let line = from; line <= to; line += 1) {
      for (const block of group.filter((i) => i.after === line)) {
        out.push(...block.lines.map((l) => `+${l}`));
      }
      if (line < to) out.push(` ${lines[line]}`);
    }
    if (!ends && to === lines.length) out.push("\\ No newline at end of file");
    shift += added;
  }
  out.push("");
  return out;
}

// Insertions whose context lines overlap share a hunk.
function hunks(insertions: Insert["insertions"]): Insert["insertions"][] {
  const groups: Insert["insertions"][number][][] = [];
  for (const insertion of [...insertions].sort((a, b) => a.after - b.after)) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group && last && insertion.after - last.after <= 2 * CONTEXT) group.push(insertion);
    else groups.push([insertion]);
  }
  return groups;
}

function linesOf(text: string): { lines: string[]; ends: boolean } {
  const lines = text.split("\n");
  const ends = text.endsWith("\n");
  if (ends) lines.pop();
  return { lines, ends };
}
