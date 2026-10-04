import { OcraError } from "@open-cr-agent/core";

export class UsageError extends OcraError {
  constructor(message: string) {
    super("INPUT_USAGE", message);
    this.name = "UsageError";
  }
}
