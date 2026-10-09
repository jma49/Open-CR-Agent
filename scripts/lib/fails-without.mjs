// What scripts/fails-without.sh concludes from the test run against the code
// before the change: the test must have run and failed there on an assertion.

const LOAD_FAILURE =
  /Failed to (load|resolve import)|ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export named/;
const ASSERTION = /AssertionError|expected .* to /;
const FAILED_TESTS = /Tests\s+\d+ failed/;

/**
 * @param {number} status vitest's exit code
 * @param {string} log vitest's output
 * @returns {{ ok: boolean, message: string, details: string[] }}
 */
export function failsWithoutVerdict(status, log) {
  const lines = log.split("\n");
  if (status === 0) {
    return {
      ok: false,
      message: "PASSES without the change: the test does not test it",
      details: lines.filter(Boolean).slice(-5),
    };
  }
  if (/No test files found/.test(log)) {
    return {
      ok: false,
      message: "NO TEST RAN: the filter matches no test file; name the test file",
      details: lines.filter((line) => /^filter:/.test(line)),
    };
  }
  // A test that cannot load (it imports what the change adds) proves nothing
  // about the old behaviour (AGENTS.md).
  if (LOAD_FAILURE.test(log) && !ASSERTION.test(log)) {
    return {
      ok: false,
      message:
        "FAILS ONLY AT IMPORT without the change: test the old behaviour through code that exists there",
      details: lines.filter((line) => /Failed to|Cannot find|ERR_MODULE/.test(line)).slice(0, 3),
    };
  }
  if (!FAILED_TESTS.test(log)) {
    return {
      ok: false,
      message: "NO TEST FAILED without the change: the run stopped before a test failed",
      details: lines.filter(Boolean).slice(-5),
    };
  }
  return {
    ok: true,
    message: "fails without the change, as it should",
    details: lines.filter((line) => /Tests |×/.test(line)).slice(0, 10),
  };
}
