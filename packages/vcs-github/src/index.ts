import type {
  ChangeRequest,
  FileDiff,
  PriorReview,
  ReviewResult,
  VcsAdapter,
} from "@open-cr-agent/core";

export interface GitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
}

export class GitHubAdapter implements VcsAdapter {
  readonly name = "github";

  constructor(readonly pullRequest: GitHubPullRequest) {}

  getChangeRequest(): Promise<ChangeRequest> {
    return notImplemented("getChangeRequest");
  }

  getDiff(): Promise<FileDiff[]> {
    return notImplemented("getDiff");
  }

  readFile(_path: string): Promise<string | undefined> {
    return notImplemented("readFile");
  }

  getPriorReview(): Promise<PriorReview | undefined> {
    return notImplemented("getPriorReview");
  }

  publish(_result: ReviewResult): Promise<void> {
    return notImplemented("publish");
  }
}

function notImplemented(method: string): never {
  throw new Error(`GitHubAdapter.${method} is not implemented yet`);
}
