#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), process.stdout, process.stderr);
