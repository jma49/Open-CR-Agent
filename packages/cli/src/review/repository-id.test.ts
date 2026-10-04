import { describe, expect, it } from "vitest";
import { normaliseRemote, repositoryOfWebUrl } from "./repository-id.js";

describe("normaliseRemote", () => {
  it.each([
    "https://github.com/org/repo",
    "https://github.com/org/repo.git",
    "https://github.com/org/repo/",
    "https://github.com/org/repo.git/",
    "https://GitHub.com/Org/Repo",
    "https://x-token:ghp_secret@github.com/org/repo.git",
    "https://github.com:443/org/repo",
    "http://github.com/org/repo",
    "git@github.com:org/repo.git",
    "git@github.com:org/repo",
    "github.com:org/repo",
    "git@github.com:/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "ssh://git@github.com:22/org/repo",
    "ssh://git@ssh.github.com:443/org/repo.git",
    "git+ssh://git@github.com/org/repo.git",
    "git://github.com/org/repo.git",
    "  https://github.com/org/repo\n",
  ])("reads %j as https://github.com/org/repo", (url) => {
    expect(normaliseRemote(url)).toBe("https://github.com/org/repo");
  });

  it("keeps a GitLab subgroup path and maps GitLab's SSH host", () => {
    expect(normaliseRemote("git@altssh.gitlab.com:Group/Sub/Project.git")).toBe(
      "https://gitlab.com/group/sub/project",
    );
    expect(normaliseRemote("https://gitlab.example.com:8443/group/sub/project")).toBe(
      "https://gitlab.example.com/group/sub/project",
    );
  });

  it("is undefined for a local path or a remote without a repository", () => {
    for (const url of [
      "/srv/git/repo.git",
      "../repo",
      "C:\\repos\\repo",
      "C:/repos/repo",
      "file:///srv/git/repo.git",
      "https://github.com/",
      "",
    ]) {
      expect(normaliseRemote(url), url).toBeUndefined();
    }
  });
});

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
