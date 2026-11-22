// A change request as a stack sees it: where it comes from and goes to.
export interface StackedChangeRequest {
  number: number;
  head: string;
  base: string;
  state: "open" | "merged" | "closed";
  title: string;
  body: string;
  webUrl: string;
}

// What `ocra stack` needs from a platform (ADR-0053).
export interface StackHost {
  // The open change request from this branch, else its latest merged one.
  find(head: string): Promise<StackedChangeRequest | undefined>;
  open(request: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<StackedChangeRequest>;
  update(number: number, change: { base?: string; body?: string }): Promise<void>;
}

export function pickStacked(
  found: readonly StackedChangeRequest[],
): StackedChangeRequest | undefined {
  return found.find((c) => c.state === "open") ?? found.find((c) => c.state === "merged");
}
