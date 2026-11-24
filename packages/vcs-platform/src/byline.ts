// Who posted, when a coding agent ran the review rather than ocra's own
// engine: ocra, then the agent, as one name. The agent's name comes from the
// runtime's code, never from the change under review.
export function byline(agent: string | undefined): string {
  return agent ? `ocra · ${agent}` : "ocra";
}
