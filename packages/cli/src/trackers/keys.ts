// Keys of a tracker's tasks as people write them in a title, a description
// or a branch name (ADR-0052): only the team's own projects or workspace
// count, so "UTF-8" or another workspace's link is never a task.

export function jiraKeys(projects: readonly string[]): (text: string) => string[] {
  const names = projects.map((p) => p.replace(/[^A-Z0-9_]/g, "")).join("|");
  const key = new RegExp(`(?<![A-Za-z0-9])(${names})-([1-9]\\d{0,8})(?![A-Za-z0-9])`, "gi");
  return (text) => [...text.matchAll(key)].map((m) => `${m[1]?.toUpperCase()}-${m[2]}`);
}

export type TapdKind = "story" | "bug" | "task";
const TAPD_PLURALS: Record<string, TapdKind> = { stories: "story", bugs: "bug", tasks: "task" };

// TAPD's commit keywords (`--story=1001234`) and its links
// (`tapd.cn/<workspace>/prong/stories/view/<id>`).
export function tapdKeys(workspace: string): (text: string) => string[] {
  const keyword = /(?<![\w-])--(story|bug|task)=(\d{1,20})(?!\d)/g;
  const link =
    /tapd\.cn\/(?:tapd_fe\/)?(\d{1,20})\/(?:prong\/)?(stories|bugs|tasks)\/view\/(\d{1,20})(?!\d)/g;
  return (text) => {
    const found: { at: number; key: string }[] = [];
    for (const m of text.matchAll(keyword)) found.push({ at: m.index, key: `${m[1]}-${m[2]}` });
    for (const m of text.matchAll(link)) {
      const kind = TAPD_PLURALS[m[2] ?? ""];
      if (m[1] === workspace && kind) found.push({ at: m.index, key: `${kind}-${m[3]}` });
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.key);
  };
}

export function tapdKey(key: string): { kind: TapdKind; id: string } | undefined {
  const match = /^(story|bug|task)-(\d{1,20})$/.exec(key);
  return match ? { kind: match[1] as TapdKind, id: match[2] as string } : undefined;
}
