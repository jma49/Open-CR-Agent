// Removes every package's build output: dist/ and the tsbuildinfo files
// tsc -b keeps next to it.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../packages", import.meta.url));
for (const name of readdirSync(packages)) {
  const dir = join(packages, name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".tsbuildinfo")) rmSync(join(dir, file), { force: true });
  }
}
