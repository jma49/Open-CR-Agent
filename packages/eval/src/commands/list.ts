import type { Instance } from "../instance.js";
import { selectInstances } from "../select.js";
import { dataset, loadInstances, type Output, parse, selection } from "./options.js";

export async function list(argv: string[], out: Output): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const instances = selectInstances(await loadInstances(dataset(values), values), select);
  for (const i of instances) {
    const attack = i.golden?.attack;
    const size = !i.golden
      ? `${i.changeLines} lines`
      : attack
        ? `${i.golden.tier}\t${attack.goal} via ${attack.channel}, on ${attack.on}`
        : `${i.golden.tier}\t${i.golden.clean ? "clean" : `${i.golden.forbid.length} forbidden`}`;
    const optional = optionalClaims(i);
    const issues = `${i.references.length} issues${optional > 0 ? ` (${optional} optional)` : ""}`;
    out.write(`${i.id}\t${i.language}\t${size}\t${issues}\t${i.prUrl}\n`);
  }
  const issues = instances.reduce((s, i) => s + i.references.length, 0);
  const optional = instances.reduce((s, i) => s + optionalClaims(i), 0);
  const lines = instances.reduce((sum, i) => sum + i.changeLines, 0);
  out.write(
    dataset(values) === "golden"
      ? `${instances.length} case(s), ${issues - optional} required and ${optional} optional claim(s)\n`
      : `${instances.length} PR(s), ${lines} changed lines, ${issues} annotated issues\n`,
  );
  return 0;
}

function optionalClaims(instance: Instance): number {
  return instance.golden?.claims.filter((c) => c.optional).length ?? 0;
}
