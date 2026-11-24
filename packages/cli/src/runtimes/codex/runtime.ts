import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  type AttemptOutcome,
  ChainRunner,
  type CompletionRequest,
  type CompletionResult,
  MAX_AGENT_STEPS,
  OcraError,
  parseModel,
  type ReviewContext,
  type RuntimeOptions,
  reviewTools,
  type TaskAttempt,
  type Usage,
  withoutSecrets,
} from "@open-cr-agent/core";
import { codexEnv } from "./env.js";
import { codexError, ExecTally } from "./events.js";
import { execArgs, featuresToDisable, TOOL_TOKEN_ENV } from "./exec-args.js";
import { probeCodex } from "./probe.js";
import { runCodex, terminate } from "./process.js";
import { startToolServer, type ToolServer } from "./tool-server.js";

// Models run as codex/<model>; codex/default leaves the choice to Codex.
const CODEX_PROVIDER = "codex";
const DEFAULT_MODEL = "default";

export interface CodexRuntimeOptions extends RuntimeOptions {
  // The codex executable; else OCRA_CODEX_BIN, else codex on PATH.
  binary?: string;
  // More `-c key=value` overrides for every exec. One that sets
  // model_provider brings its own key, and the sign-in check is skipped.
  config?: readonly string[];
}

interface Infra {
  root: string;
  workspace: string;
  binary: string;
  env: Record<string, string>;
  disabled: string[];
  tools: ToolServer;
  live: Set<ChildProcess>;
  onExit: () => void;
}

interface ExecInput {
  model: string;
  system: string;
  user: string;
  tools: boolean;
  timeoutMs: number;
}

export class CodexRuntime implements AgentRuntime {
  readonly name = "codex";
  readonly agent = "Codex";
  private infra: Promise<Infra> | undefined;
  private context: ReviewContext | undefined;
  private calls = 0;
  private readonly chains: ChainRunner;
  private readonly options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions) {
    this.options = options;
    this.chains = new ChainRunner(options.models, {
      refuse: (chain) => notCodex(chain),
      ready: async () => {
        await this.start();
      },
      task: (model, spec, signal, onUsage) =>
        this.exec(
          {
            model,
            system: spec.systemPrompt,
            user: spec.userPrompt,
            tools: true,
            timeoutMs: spec.timeoutMs,
          },
          signal,
          onUsage,
        ),
      complete: (model, request, signal) =>
        this.exec(
          {
            model,
            system: request.system,
            user: request.user,
            tools: false,
            timeoutMs: request.timeoutMs,
          },
          signal,
        ),
    });
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.context && this.context !== spec.context) {
      throw new OcraError("INTERNAL", "A CodexRuntime instance serves a single review run");
    }
    this.context = spec.context;
    yield* this.chains.runTask(spec, signal);
  }

  complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    return this.chains.complete(request, signal);
  }

  async dispose(): Promise<void> {
    const infra = await this.infra?.catch(() => undefined);
    this.infra = undefined;
    if (!infra) return;
    process.off("exit", infra.onExit);
    for (const child of infra.live) terminate(child, "SIGKILL");
    await infra.tools.close();
    await rm(infra.root, { recursive: true, force: true });
  }

  // One `codex exec`: the task's whole conversation, or a plain completion.
  // It has no resume or wrap-up turn: the exec keeps no session to continue.
  private async exec(
    input: ExecInput,
    signal: AbortSignal,
    onUsage?: (spent: Usage) => void,
  ): Promise<TaskAttempt> {
    const infra = await this.start();
    this.calls += 1;
    const instructionsFile = join(infra.root, `instructions-${this.calls}.md`);
    await writeFile(instructionsFile, input.system, { mode: 0o600 });
    const { modelID } = parseModel(input.model);
    const tally = new ExecTally();
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const stop = new AbortController();
    let atStepCap = false;
    try {
      const result = await runCodex({
        binary: infra.binary,
        args: execArgs({
          ...(modelID === DEFAULT_MODEL ? {} : { model: modelID }),
          instructionsFile,
          disabled: infra.disabled,
          ...(input.tools ? { toolsUrl: infra.tools.url } : {}),
          ...(this.options.config ? { config: this.options.config } : {}),
        }),
        env: input.tools ? { ...infra.env, [TOOL_TOKEN_ENV]: infra.tools.token } : infra.env,
        cwd: infra.workspace,
        stdin: input.user,
        signal: AbortSignal.any([signal, timeout, stop.signal]),
        live: infra.live,
        onLine: (line) => {
          if (tally.push(line)) onUsage?.(tally.usage);
          if (tally.foreign) stop.abort();
          else if (tally.toolCalls >= MAX_AGENT_STEPS && !atStepCap) {
            atStepCap = true;
            stop.abort();
          }
        },
      });
      const outcome = tally.outcome();
      if (atStepCap) outcome.atStepCap = true;
      const failure = stopped(tally.foreign, outcome, result, {
        signal,
        timeout,
        atStepCap,
        ...input,
      });
      if (failure) outcome.error = failure;
      if (outcome.error) {
        outcome.error.message = withoutSecrets(outcome.error.message, [infra.tools.token]);
      }
      return outcome;
    } finally {
      await rm(instructionsFile, { force: true });
    }
  }

  private start(): Promise<Infra> {
    this.infra ??= this.launch();
    return this.infra;
  }

  private async launch(): Promise<Infra> {
    const binary = this.options.binary ?? this.options.env.OCRA_CODEX_BIN ?? "codex";
    const env = codexEnv(this.options.env, this.options.config);
    const ownProvider = this.options.config?.some((c) => c.startsWith("model_provider=")) ?? false;
    const { features } = await probeCodex({ binary, env }, { signIn: !ownProvider });
    const disabled = featuresToDisable(features);
    const root = await mkdtemp(join(tmpdir(), "ocra-codex-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let tools: ToolServer | undefined;
    try {
      tools = await startToolServer([...reviewTools, ...this.options.tools], () => this.context);
      const live = new Set<ChildProcess>();
      // A second Ctrl-C exits at once, before dispose() can run.
      const onExit = () => {
        for (const child of live) terminate(child, "SIGKILL");
        rmSync(root, { recursive: true, force: true });
      };
      process.on("exit", onExit);
      return { root, workspace, binary, env, disabled, tools, live, onExit };
    } catch (error) {
      await tools?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}

// Why an attempt ended short when its events do not say: a tool of Codex's
// own, the review's signal, the timeout, or Codex exiting with an error.
function stopped(
  foreign: string | undefined,
  outcome: AttemptOutcome,
  result: { code: number | null; stderr: string },
  run: { signal: AbortSignal; timeout: AbortSignal; atStepCap: boolean; timeoutMs: number },
): AttemptOutcome["error"] {
  if (foreign) {
    return {
      message: `Codex used its own ${foreign} tool, which a review does not offer; the attempt was stopped`,
      retryable: false,
    };
  }
  if (run.signal.aborted) return { message: "The review was stopped", retryable: false };
  if (run.timeout.aborted) {
    return { message: `timed out after ${Math.round(run.timeoutMs / 1000)}s`, retryable: true };
  }
  if (result.code === 0 || run.atStepCap || outcome.error) return undefined;
  const said = result.stderr.trim().split("\n").at(-1);
  return codexError(said || `codex exited with code ${result.code}`);
}

function notCodex(chain: readonly string[]): OcraError | undefined {
  const model = chain.find((m) => parseModel(m).providerID !== CODEX_PROVIDER);
  return model === undefined
    ? undefined
    : new OcraError(
        "CONFIG_INVALID",
        `The codex runtime runs only Codex models, written codex/<model> or codex/default; "${model}" is not one`,
      );
}
