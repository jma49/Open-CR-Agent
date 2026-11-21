// What the team has learned from past changes (ADR-0037), as the caller read
// it from the trusted revision's .ocra/learnings/.
export interface Learning {
  id: string;
  title: string;
  body: string;
  paths: readonly string[];
  symbols: readonly string[];
  keywords: readonly string[];
  critical: boolean;
  source?: LearningSource;
}

export interface LearningSource {
  kind: string;
  ref?: string;
}

// A learning some review task was given, for the report.
export interface LearningUse {
  id: string;
  title: string;
  critical: boolean;
  source?: LearningSource;
  // The labels of the bundles whose tasks it was given to.
  bundles: string[];
}
