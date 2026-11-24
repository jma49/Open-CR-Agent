import { errorMessage } from "@open-cr-agent/core";
import { type CheckOutcome, runningOutcome } from "@open-cr-agent/vcs-platform/internal";
import { type GitHubApi, GitHubApiError } from "./client.js";

const REVIEW_CHECK_NAME = "ocra review";

// The pull request's "ocra review" check: in progress while a review runs,
// then its verdict. Given the id of one ocra Cloud created when it queued the
// review, the run takes that one over instead of adding a second.
export class ReviewCheck {
  private readonly api: GitHubApi;
  private id: number | undefined;

  constructor(api: GitHubApi, id?: number) {
    this.api = api;
    this.id = id;
  }

  async start(headSha: string): Promise<string[]> {
    const check = {
      name: REVIEW_CHECK_NAME,
      status: "in_progress" as const,
      output: runningOutcome(headSha),
    };
    try {
      if (this.id === undefined) {
        this.id = await this.api.createCheckRun({ ...check, head_sha: headSha });
      } else {
        await this.api.updateCheckRun(this.id, check);
      }
      return [];
    } catch (error) {
      this.id = undefined;
      return [`could not show the review's check: ${reason(error)}`];
    }
  }

  async finish({ conclusion, title, summary }: CheckOutcome): Promise<string[]> {
    const id = this.id;
    if (id === undefined) return [];
    this.id = undefined;
    try {
      await this.api.updateCheckRun(id, {
        name: REVIEW_CHECK_NAME,
        status: "completed",
        conclusion,
        output: { title, summary },
      });
      return [];
    } catch (error) {
      return [`could not finish the review's check: ${reason(error)}`];
    }
  }
}

function reason(error: unknown): string {
  if (error instanceof GitHubApiError && error.status === 403) {
    return "the token needs the checks: write permission";
  }
  return errorMessage(error);
}
