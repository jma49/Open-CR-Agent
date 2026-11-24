import {
  normaliseRemote,
  redactField,
  type SharedRepo,
  sharedRepoSchema,
} from "@open-cr-agent/cloud-contract";

// Which repository a review is of, when the configuration opts in
// (`cloud.shareRepoName`): its path and address as the hash is made from
// them (repository-id.ts). A directory or path remote has no host to name
// it by, and a name the redaction pass would change is not sent at all.
export function sharedRepo(repository: string): SharedRepo | undefined {
  if (normaliseRemote(repository) !== repository) return undefined;
  if (redactField(repository).redacted) return undefined;
  const name = new URL(repository).pathname.slice(1);
  const parsed = sharedRepoSchema.safeParse({ name, url: repository });
  return parsed.success ? parsed.data : undefined;
}
