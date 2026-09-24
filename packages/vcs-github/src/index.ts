import type {
  ChangeRef,
  ChangeRequest,
  FileDiff,
  PriorReview,
  ReviewResult,
  VcsAdapter,
} from "@open-cr-agent/core";

export class GitHubAdapter implements VcsAdapter {
  readonly name = "github";

  getChangeRequest(_ref: ChangeRef): Promise<ChangeRequest> {
    return notImplemented("getChangeRequest");
  }

  getDiff(_ref: ChangeRef): Promise<FileDiff[]> {
    return notImplemented("getDiff");
  }

  getPriorReview(_ref: ChangeRef): Promise<PriorReview | undefined> {
    return notImplemented("getPriorReview");
  }

  publish(_ref: ChangeRef, _result: ReviewResult): Promise<void> {
    return notImplemented("publish");
  }
}

function notImplemented(method: string): never {
  throw new Error(`GitHubAdapter.${method} is not implemented yet`);
}
