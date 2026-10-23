// The format of a run's run.json and summary.json (their top-level
// version). Files written before it was recorded have none and are read as
// they are; a version this ocra-eval does not know is refused, not misread.
export const RUN_FILES_VERSION = 1;

export function checkRunFile(path: string, data: unknown): void {
  const version =
    typeof data === "object" && data !== null ? (data as { version?: unknown }).version : undefined;
  if (version === undefined || version === RUN_FILES_VERSION) return;
  throw new Error(
    `${path} has format version ${JSON.stringify(version)}; this ocra-eval reads version ${RUN_FILES_VERSION}, so read it with the ocra-eval that wrote it`,
  );
}
