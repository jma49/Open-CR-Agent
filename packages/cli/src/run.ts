import { parseArgs } from "node:util";

interface Output {
  write(chunk: string): unknown;
}

const VERSION = "0.0.0";

const USAGE = `Usage: ocra <command> [options]

Commands:
  review      Review changes (not implemented yet)

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

export async function run(argv: string[], out: Output, err: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    out.write(`${VERSION}\n`);
    return 0;
  }

  const [command] = positionals;
  if (values.help || command === undefined) {
    out.write(USAGE);
    return 0;
  }

  if (command === "review") {
    err.write("ocra review is not implemented yet\n");
    return 1;
  }

  err.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}
