import type { Usage } from "@open-cr-agent/core";

// The share of the window a review turn leaves free: its next answer, then
// the wrap-up turn's message and report (ADR-0071).
export const TURN_HEADROOM = 0.15;

// Four characters per token, as the plan estimates a prompt.
const CHARS_PER_TOKEN = 4;

// How much of a model's context window a conversation fills, so the loop
// stops before the endpoint refuses a request. It counts what the endpoint
// reports once an answer came back, and estimates what was said since.
export class WindowGauge {
  readonly window: number | undefined;
  private counted = 0;
  private pendingChars = 0;

  constructor(window: number | undefined) {
    this.window = window;
  }

  // Text that joins the conversation after the last answer.
  said(text: string): void {
    this.pendingChars += text.length;
  }

  // An answer: the endpoint's count of the request and of the answer stands
  // for the conversation so far. One that reports no tokens leaves the
  // estimate, with the answer's text added.
  answered(usage: Usage, text: string): void {
    const reported = usage.inputTokens + usage.cachedTokens + usage.outputTokens;
    if (reported === 0) {
      this.said(text);
      return;
    }
    this.counted = reported;
    this.pendingChars = 0;
  }

  // Tokens the next request would send.
  get tokens(): number {
    return this.counted + Math.ceil(this.pendingChars / CHARS_PER_TOKEN);
  }

  // Whether the next request would leave less than `headroom` of the window.
  full(headroom: number): boolean {
    return this.window !== undefined && this.tokens > this.window * (1 - headroom);
  }
}
