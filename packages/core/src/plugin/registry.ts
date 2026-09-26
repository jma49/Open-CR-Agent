import type { AgentRuntime, VcsAdapter } from "../contracts.js";
import { errorMessage } from "../errors.js";
import type { ReviewEvent } from "../pipeline/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { RepoRule } from "../rules/repo-rules.js";
import type {
  PluginSummary,
  RuntimeFactory,
  RuntimeOptions,
  ToolDefinition,
  VcsFactory,
} from "./types.js";

export class PluginError extends Error {}

interface Owned<T> {
  owner: string;
  value: T;
}

export class PluginRegistry {
  private readonly vcs = new Map<string, Owned<VcsFactory>>();
  private readonly runtimes = new Map<string, Owned<RuntimeFactory>>();
  private readonly reviewerMap = new Map<string, Owned<ReviewerDefinition>>();
  private readonly toolMap = new Map<string, Owned<ToolDefinition>>();
  private readonly ruleList: RepoRule[] = [];
  private readonly listeners: Owned<(event: ReviewEvent) => void>[] = [];
  private frozen = false;

  constructor(
    private readonly reservedToolNames: ReadonlySet<string>,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  registerVcs(owner: string, name: string, factory: VcsFactory): void {
    this.add(this.vcs, "VCS adapter", owner, name, factory);
  }

  registerRuntime(owner: string, name: string, factory: RuntimeFactory): void {
    this.add(this.runtimes, "runtime", owner, name, factory);
  }

  registerReviewer(owner: string, reviewer: ReviewerDefinition): void {
    this.add(this.reviewerMap, "reviewer", owner, reviewer.id, reviewer);
  }

  registerTool(owner: string, tool: ToolDefinition): void {
    if (this.reservedToolNames.has(tool.name)) {
      throw new PluginError(
        `Plugin "${owner}" cannot register tool "${tool.name}": the name is reserved`,
      );
    }
    this.add(this.toolMap, "tool", owner, tool.name, tool);
  }

  registerRules(owner: string, rules: readonly RepoRule[]): void {
    this.assertOpen(owner);
    this.ruleList.push(...rules);
  }

  onEvent(owner: string, listener: (event: ReviewEvent) => void): void {
    this.assertOpen(owner);
    this.listeners.push({ owner, value: listener });
  }

  freeze(): void {
    this.frozen = true;
  }

  createVcs(name: string, options: unknown): VcsAdapter {
    return this.lookup(this.vcs, "VCS adapter", name)(options);
  }

  createRuntime(name: string, options: Omit<RuntimeOptions, "tools">): AgentRuntime {
    return this.lookup(this.runtimes, "runtime", name)({ ...options, tools: this.tools });
  }

  get reviewers(): ReviewerDefinition[] {
    return [...this.reviewerMap.values()].map((o) => o.value);
  }

  get tools(): ToolDefinition[] {
    return [...this.toolMap.values()].map((o) => o.value);
  }

  get rules(): RepoRule[] {
    return [...this.ruleList];
  }

  // A listener observes the run; its failure (a full disk, a bug in a plugin)
  // must not discard a review already paid for, so it is reported once and
  // the listener is dropped.
  emit(event: ReviewEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener.value(event);
      } catch (error) {
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        this.warn(
          `Plugin "${listener.owner}" event listener failed and was disabled: ${errorMessage(error)}`,
        );
      }
    }
  }

  summary(plugins: readonly string[]): PluginSummary {
    return {
      plugins,
      vcs: [...this.vcs.keys()],
      runtimes: [...this.runtimes.keys()],
      reviewers: [...this.reviewerMap.keys()],
      tools: [...this.toolMap.keys()],
    };
  }

  private add<T>(
    map: Map<string, Owned<T>>,
    kind: string,
    owner: string,
    name: string,
    value: T,
  ): void {
    this.assertOpen(owner);
    const existing = map.get(name);
    if (existing) {
      throw new PluginError(
        `Plugin "${owner}" cannot register ${kind} "${name}": already registered by plugin "${existing.owner}"`,
      );
    }
    map.set(name, { owner, value });
  }

  private lookup<T>(map: Map<string, Owned<T>>, kind: string, name: string): T {
    const entry = map.get(name);
    if (!entry) {
      const known = [...map.keys()].join(", ") || "none";
      throw new PluginError(`No ${kind} named "${name}" is registered (available: ${known})`);
    }
    return entry.value;
  }

  private assertOpen(owner: string): void {
    if (this.frozen) {
      throw new PluginError(`Plugin "${owner}" tried to register after the configure phase`);
    }
  }
}
