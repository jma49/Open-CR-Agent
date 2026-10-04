// Conventional Commits with the types AGENTS.md allows. CI checks the
// commits of a pull request only: history before this check has other
// types (data(eval)) and is not rewritten.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "revert"],
    ],
    // Dependabot's bodies carry long links and YAML; prose wraps by hand.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
