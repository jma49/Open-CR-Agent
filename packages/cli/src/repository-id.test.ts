import { describe, expect, it } from "vitest";
import { repositoryOfWebUrl } from "./repository-id.js";

describe("repositoryOfWebUrl", () => {
  it("reads the repository off a pull or merge request page", () => {
    expect(repositoryOfWebUrl("https://github.com/Org/Repo/pull/7")).toBe(
      "https://github.com/org/repo",
    );
    expect(
      repositoryOfWebUrl("https://gitlab.example.com/group/sub/project/-/merge_requests/7"),
    ).toBe("https://gitlab.example.com/group/sub/project");
    expect(repositoryOfWebUrl("https://github.com/org/repo")).toBeUndefined();
  });
});
