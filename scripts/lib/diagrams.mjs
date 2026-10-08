// The README diagrams: the system overview and the review agents, in
// English and Chinese, light and dark. Deterministic code is blue and model
// calls are amber in both. Written by scripts/diagrams.mjs.

/** @typedef {"code" | "llm" | "plain"} Kind */
/** @typedef {"en" | "zh"} Lang */

const THEMES = {
  light: {
    bg: "#ffffff",
    fg: "#17202b",
    muted: "#5a6575",
    line: "#d4d9e1",
    sunk: "#f1f3f6",
    code: "#2e55c4",
    codeSoft: "#e8eefc",
    llm: "#b06508",
    llmSoft: "#fcf0dd",
  },
  dark: {
    bg: "#0d1117",
    fg: "#e4e9f0",
    muted: "#97a3b3",
    line: "#30363d",
    sunk: "#161b22",
    code: "#86a5ff",
    codeSoft: "#18233d",
    llm: "#f0ae4f",
    llmSoft: "#33250f",
  },
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A box with a title and lines below it.
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {Kind} kind
 * @param {string} title
 * @param {string[]} [lines]
 * @param {{ mono?: boolean, size?: number }} [opts]
 * @returns {string}
 */
function box(x, y, w, h, kind, title, lines = [], opts = {}) {
  const size = opts.size ?? 14;
  const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="b-${kind}"/>`];
  out.push(
    `<text x="${x + 12}" y="${y + 22}" class="t-${kind}" font-size="${size}">${esc(title)}</text>`,
  );
  lines.forEach((line, i) => {
    const cls = opts.mono ? "m" : "s";
    out.push(`<text x="${x + 12}" y="${y + 41 + i * 17}" class="${cls}">${esc(line)}</text>`);
  });
  return out.join("");
}

/**
 * @param {string} d
 * @param {Kind} kind
 * @param {{ dashed?: boolean }} [opts]
 * @returns {string}
 */
function arrow(d, kind, opts = {}) {
  const dash = opts.dashed ? ' stroke-dasharray="5 4"' : "";
  return `<path d="${d}" class="a-${kind}"${dash} marker-end="url(#h-${kind})"/>`;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {string} s
 * @param {string} [cls]
 * @param {string} [anchor]
 * @returns {string}
 */
function label(x, y, s, cls = "l", anchor = "start") {
  return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
}

/**
 * @param {typeof THEMES.light} c
 * @param {number} w
 * @param {number} h
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function svg(c, w, h, title, body) {
  const markers = /** @type {Kind[]} */ (["code", "llm", "plain"])
    .map((k) => {
      const fill = k === "code" ? c.code : k === "llm" ? c.llm : c.muted;
      return `<marker id="h-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${fill}"/></marker>`;
    })
    .join("");
  const style = `
text{font-family:${FONT}}
.t-code{fill:${c.code};font-weight:600}.t-llm{fill:${c.llm};font-weight:600}.t-plain{fill:${c.fg};font-weight:600}
.s{fill:${c.muted};font-size:12px}.m{fill:${c.muted};font-size:11.5px;font-family:${MONO}}
.l{fill:${c.muted};font-size:11.5px}.cap{fill:${c.muted};font-size:12px;font-weight:600;letter-spacing:.04em}
.h{fill:${c.fg};font-size:16px;font-weight:700}
.b-code{fill:${c.codeSoft};stroke:${c.code};stroke-width:1.2}.b-llm{fill:${c.llmSoft};stroke:${c.llm};stroke-width:1.2}
.b-plain{fill:${c.bg};stroke:${c.line};stroke-width:1.2}
.chip{fill:${c.bg};stroke:${c.line};stroke-width:1}
.g{fill:none;stroke:${c.muted};stroke-width:1.2;stroke-dasharray:6 4}.g2{fill:${c.sunk};stroke:${c.line};stroke-width:1.2}
.a-code{fill:none;stroke:${c.code};stroke-width:1.6}.a-llm{fill:none;stroke:${c.llm};stroke-width:1.6}.a-plain{fill:none;stroke:${c.muted};stroke-width:1.4}
.br{fill:none;stroke:${c.line};stroke-width:2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><defs>${markers}<style>${style}</style></defs><rect width="${w}" height="${h}" fill="${c.bg}"/>${body}</svg>\n`;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {Lang} lang
 * @returns {string}
 */
function legend(x, y, lang) {
  const t = lang === "zh" ? ["确定性代码", "调用模型"] : ["Deterministic code", "Model call"];
  const second = x + (lang === "zh" ? 112 : 158);
  return [
    `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="3" class="b-code"/>`,
    label(x + 18, y, t[0] ?? ""),
    `<rect x="${second}" y="${y - 10}" width="12" height="12" rx="3" class="b-llm"/>`,
    label(second + 18, y, t[1] ?? ""),
  ].join("");
}

const SYSTEM = {
  en: {
    title: "ocra system overview",
    entries: "WHO STARTS A REVIEW",
    terminal: ["Developer terminal", "ocra review"],
    actions: ["GitHub Actions", "on pull requests"],
    gitlab: ["GitLab CI", "on merge requests"],
    eval: ["ocra-eval", "golden set · benchmarks"],
    engine: "OCRA ENGINE · OPEN SOURCE · npm @open-cr-agent/*",
    cli: ["cli · the ocra command", "review · plan · config layers · session log"],
    core: ["core · domain and pipeline", "depends on no other package in the repository"],
    chips: [
      ["Pipeline", "11 stages", "coverage list"],
      ["ReviewContext", "one read policy", "no secrets · no .git"],
      ["Findings", "JSON report v1", "SARIF in / out"],
      ["Spend", "cost limit", "tokens · dollars"],
    ],
    vcs: "VcsAdapter",
    platform: ["vcs-platform", "shared trust rules · state"],
    github: ["vcs-github", "pull requests"],
    gitlabA: ["vcs-gitlab", "merge requests"],
    local: ["vcs-local", "working tree · ranges · commits"],
    runtime: "AgentRuntime",
    direct: ["runtime-direct", "own tool loop · OpenAI-compatible"],
    opencode: ["runtime-opencode", "on the OpenCode SDK"],
    chain: "both: ChainRunner failback · circuit breakers",
    models: ["Model providers", "Gemini · OpenAI-compatible", "OpenRouter · Anthropic"],
    hosts: ["GitHub / GitLab API", "comments · threads · permissions"],
    cloud: ["ocra Cloud (optional)", "account settings · review history"],
    publish: "read the change · publish comments",
    upload: "login · upload",
  },
  zh: {
    title: "ocra 系统全景",
    entries: "入口 · 谁触发审查",
    terminal: ["开发者终端", "ocra review"],
    actions: ["GitHub Actions", "PR 触发"],
    gitlab: ["GitLab CI", "MR 触发"],
    eval: ["ocra-eval", "黄金用例 · 基准"],
    engine: "ocra 引擎 · 开源 · npm @open-cr-agent/*",
    cli: ["cli · ocra 命令", "review · plan · 分层配置 · 会话日志"],
    core: ["core · 领域模型与流水线", "不依赖仓库内任何其他包"],
    chips: [
      ["Pipeline", "11 个阶段", "取消 · 覆盖清单"],
      ["ReviewContext", "唯一读取策略", "拒读密钥与 .git"],
      ["Findings", "JSON 报告 v1", "SARIF 输入 / 输出"],
      ["Spend", "花费上限", "token · 美元"],
    ],
    vcs: "VcsAdapter",
    platform: ["vcs-platform", "共享的信任规则与状态"],
    github: ["vcs-github", "PR"],
    gitlabA: ["vcs-gitlab", "MR"],
    local: ["vcs-local", "工作区 · 区间 · 单个 commit"],
    runtime: "AgentRuntime",
    direct: ["runtime-direct", "自管工具循环 · OpenAI 兼容"],
    opencode: ["runtime-opencode", "基于 OpenCode SDK"],
    chain: "两者共用 ChainRunner：失败切换 · 熔断",
    models: ["模型服务商", "Gemini · OpenAI 兼容", "OpenRouter · Anthropic"],
    hosts: ["GitHub / GitLab API", "评论 · 线程 · 权限"],
    cloud: ["ocra Cloud（可选）", "账户设置 · 审查历史"],
    publish: "读取改动 · 发布评论",
    upload: "登录 · 上传",
  },
};

/**
 * @param {Lang} lang
 * @returns {{ w: number, h: number, title: string, body: string }}
 */
function system(lang) {
  const t = SYSTEM[lang];
  const p = [];
  // Entries.
  p.push(label(20, 34, t.entries, "cap"));
  const entries = [t.terminal, t.actions, t.gitlab, t.eval];
  entries.forEach(([title, sub], i) => {
    const y = 58 + i * 82;
    p.push(box(20, y, 180, 58, "plain", title ?? "", [sub ?? ""], { mono: i === 0 }));
    p.push(arrow(`M200 ${y + 29} C232 ${y + 29} 232 ${104 + i * 8} 262 ${104 + i * 8}`, "plain"));
  });
  // Engine.
  p.push(`<rect x="236" y="20" width="540" height="560" rx="12" class="g"/>`);
  p.push(label(252, 42, t.engine, "cap"));
  p.push(box(264, 62, 484, 62, "code", t.cli[0] ?? "", [t.cli[1] ?? ""]));
  p.push(arrow("M506 124 L506 146", "code"));
  p.push(`<rect x="264" y="150" width="484" height="160" rx="8" class="b-code"/>`);
  p.push(`<text x="276" y="172" class="t-code" font-size="14">${esc(t.core[0] ?? "")}</text>`);
  p.push(label(276, 191, t.core[1] ?? "", "s"));
  t.chips.forEach(([name, a, b], i) => {
    const x = 276 + i * 117;
    p.push(`<rect x="${x}" y="206" width="109" height="88" rx="6" class="chip"/>`);
    p.push(`<text x="${x + 10}" y="230" class="t-plain" font-size="13">${esc(name ?? "")}</text>`);
    p.push(label(x + 10, 252, a ?? "", "s"));
    p.push(label(x + 10, 270, b ?? "", "s"));
  });
  p.push(arrow("M380 310 L380 342", "code"));
  p.push(arrow("M636 310 L636 342", "llm"));
  // VcsAdapter.
  p.push(label(264, 340, t.vcs, "cap"));
  p.push(box(264, 348, 232, 52, "code", t.platform[0] ?? "", [t.platform[1] ?? ""], { size: 13 }));
  p.push(box(264, 412, 112, 52, "code", t.github[0] ?? "", [t.github[1] ?? ""], { size: 13 }));
  p.push(box(384, 412, 112, 52, "code", t.gitlabA[0] ?? "", [t.gitlabA[1] ?? ""], { size: 13 }));
  p.push(box(264, 476, 232, 52, "code", t.local[0] ?? "", [t.local[1] ?? ""], { size: 13 }));
  // AgentRuntime.
  p.push(label(516, 340, t.runtime, "cap"));
  p.push(box(516, 348, 232, 52, "llm", t.direct[0] ?? "", [t.direct[1] ?? ""], { size: 13 }));
  p.push(box(516, 412, 232, 52, "llm", t.opencode[0] ?? "", [t.opencode[1] ?? ""], { size: 13 }));
  p.push(label(516, 486, t.chain, "l"));
  // Outside.
  p.push(box(830, 62, 200, 58, "plain", t.cloud[0] ?? "", [t.cloud[1] ?? ""]));
  p.push(arrow("M748 92 L828 92", "plain", { dashed: true }));
  p.push(label(756, 84, t.upload));
  p.push(
    box(830, 348, 200, 76, "plain", t.models[0] ?? "", [t.models[1] ?? "", t.models[2] ?? ""]),
  );
  p.push(arrow("M748 386 L828 386", "llm"));
  p.push(box(830, 476, 200, 58, "plain", t.hosts[0] ?? "", [t.hosts[1] ?? ""]));
  p.push(arrow("M496 504 C640 560 760 520 828 505", "code"));
  p.push(label(560, 560, t.publish));
  p.push(legend(20, 604, lang));
  return { w: 1050, h: 620, title: t.title, body: p.join("") };
}

const AGENTS = {
  en: {
    title: "ocra review stages and agents",
    stages: [
      ["Ingest", "read the change"],
      ["Select", "skip binary, secrets"],
      ["Triage", "risk tier"],
      ["Bundle", "group files"],
      ["Matrix", "who reviews what"],
      ["Execute", "reviewer agents"],
      ["Anchor", "place by quoted code"],
      ["Filter", "memory · re-review"],
      ["Verify", "fact-check"],
      ["Judge", "dedupe · severity"],
      ["Publish", "verdict by code"],
    ],
    light: "light model",
    groups: ["planReview", "executeStage", "filterStage", "checkStage", "report"],
    matrix: ["Review matrix", "one task per", "bundle × reviewer"],
    sandbox: "ISOLATED AGENT TASKS · READ-ONLY TOOLS · NO SHELL, NO WEB",
    reviewers: [
      ["correctness", "standard", "logic, contracts, error handling"],
      ["security", "standard", "exploitable issues only"],
      ["performance", "standard", "measurable hot-path regressions"],
      ["docs", "light", "public API and docs drift"],
      ["agents-md", "light", "changes AGENTS.md should note"],
    ],
    tools: ["tools: read_file · read_diff · code_search", "       report_finding · task_done"],
    parallel: ["tasks run in parallel,", "each on its tier's", "model chain"],
    anchor: [
      "Anchor",
      "report_finding → quote matched in diff, files",
      "a light model relocates a paraphrase",
    ],
    verify: [
      "Verifier",
      "standard · one call per file, parallel",
      "drops only what the diff disproves",
    ],
    judge: ["Judge", "top · dedupes across reviewers", "calibrates severity, writes summary"],
    verdict: ["Verdict", "rubric in code over judged findings"],
  },
  zh: {
    title: "ocra 审查阶段与智能体",
    stages: [
      ["Ingest", "读取改动"],
      ["Select", "排除二进制与密钥"],
      ["Triage", "风险档位"],
      ["Bundle", "分组"],
      ["Matrix", "谁审哪个分组"],
      ["Execute", "审查员智能体"],
      ["Anchor", "按引用代码定位"],
      ["Filter", "记忆 · 复审对比"],
      ["Verify", "事实核查"],
      ["Judge", "去重 · 定级"],
      ["Publish", "结论由代码算"],
    ],
    light: "轻模型",
    groups: ["planReview", "executeStage", "filterStage", "checkStage", "report"],
    matrix: ["审查矩阵", "每个分组 × 审查员", "一个任务"],
    sandbox: "隔离的智能体任务 · 只读工具 · 无 shell、无网络",
    reviewers: [
      ["correctness", "standard", "逻辑、契约、错误处理"],
      ["security", "standard", "只报可利用的问题"],
      ["performance", "standard", "热点路径上可测量的退化"],
      ["docs", "light", "公开 API 与文档不一致"],
      ["agents-md", "light", "需要更新 AGENTS.md 的改动"],
    ],
    tools: ["工具：read_file · read_diff · code_search", "      report_finding · task_done"],
    parallel: ["各任务并行，", "各用所在层级的", "模型链"],
    anchor: [
      "Anchor 定位",
      "report_finding → 先在 diff、再在文件里匹配",
      "转述的引用由轻模型重新定位",
    ],
    verify: ["Verifier 核查", "standard · 每个文件一次调用，并行", "只删 diff 能证伪的"],
    judge: ["Judge 裁决", "top · 跨审查员去重", "校准严重度，写总结"],
    verdict: ["Verdict 结论", "代码按规则从裁决结果算出"],
  },
};

/** Stages that call a model, and those whose code falls back to a light model. */
const LLM_STAGES = new Set([5, 8, 9]);
const LIGHT_ASSIST = new Set([3, 6]);

/**
 * @param {Lang} lang
 * @returns {{ w: number, h: number, title: string, body: string }}
 */
function agents(lang) {
  const t = AGENTS[lang];
  const p = [];
  const x0 = 20;
  const sw = 86;
  const gap = 6;
  // The stage strip.
  t.stages.forEach(([name, sub], i) => {
    const x = x0 + i * (sw + gap);
    const kind = LLM_STAGES.has(i) ? "llm" : "code";
    p.push(`<rect x="${x}" y="20" width="${sw}" height="80" rx="8" class="b-${kind}"/>`);
    p.push(label(x + 8, 36, String(i + 1), "m"));
    p.push(`<text x="${x + 8}" y="55" class="t-${kind}" font-size="13">${esc(name ?? "")}</text>`);
    const words = wrap(sub ?? "", lang === "zh" ? 6 : 13);
    words.forEach((line, j) => {
      p.push(`<text x="${x + 8}" y="${73 + j * 14}" class="s" font-size="11">${esc(line)}</text>`);
    });
    if (LIGHT_ASSIST.has(i)) {
      p.push(`<circle cx="${x + sw - 12}" cy="32" r="5" class="b-llm"/>`);
    }
  });
  // Group brackets under the strip.
  const spans = [
    [0, 4],
    [4, 7],
    [7, 8],
    [8, 10],
    [10, 11],
  ];
  spans.forEach(([a, b], i) => {
    const xa = x0 + (a ?? 0) * (sw + gap);
    const xb = x0 + (b ?? 0) * (sw + gap) - gap;
    p.push(`<path d="M${xa} 110 L${xb} 110" class="br"/>`);
    p.push(label((xa + xb) / 2, 126, t.groups[i] ?? "", "m", "middle"));
  });
  // Execute expands below.
  const ex = x0 + 5 * (sw + gap);
  p.push(
    `<path d="M${ex} 100 L226 150 M${ex + sw} 100 L626 150" class="a-plain" stroke-dasharray="3 4"/>`,
  );
  // Matrix.
  p.push(box(20, 262, 170, 76, "code", t.matrix[0] ?? "", [t.matrix[1] ?? "", t.matrix[2] ?? ""]));
  // Reviewer sandbox.
  p.push(`<rect x="226" y="150" width="400" height="344" rx="12" class="g"/>`);
  p.push(label(240, 172, t.sandbox, "cap"));
  t.reviewers.forEach(([name, tier, scope], i) => {
    const y = 186 + i * 52;
    p.push(`<rect x="240" y="${y}" width="372" height="44" rx="8" class="b-llm"/>`);
    p.push(`<text x="252" y="${y + 19}" class="t-llm" font-size="13">${esc(name ?? "")}</text>`);
    p.push(label(252, y + 36, scope ?? "", "s"));
    const tw = (tier ?? "").length * 7 + 14;
    p.push(`<rect x="${600 - tw}" y="${y + 8}" width="${tw}" height="18" rx="9" class="chip"/>`);
    p.push(label(600 - tw / 2, y + 21, tier ?? "", "m", "middle"));
    p.push(arrow(`M190 300 C214 300 214 ${y + 22} 238 ${y + 22}`, "code"));
    p.push(arrow(`M612 ${y + 22} C640 ${y + 22} 640 300 668 300`, "llm"));
  });
  t.tools.forEach((line, i) => {
    p.push(label(240, 458 + i * 15, line, "m"));
  });
  t.parallel.forEach((line, i) => {
    p.push(label(20, 362 + i * 16, line, "l"));
  });
  // The checking chain.
  p.push(box(670, 262, 360, 76, "code", t.anchor[0] ?? "", [t.anchor[1] ?? "", t.anchor[2] ?? ""]));
  p.push(`<circle cx="1016" cy="276" r="5" class="b-llm"/>`);
  p.push(arrow("M850 338 L850 360", "code"));
  p.push(box(670, 362, 360, 76, "llm", t.verify[0] ?? "", [t.verify[1] ?? "", t.verify[2] ?? ""]));
  p.push(arrow("M850 438 L850 460", "llm"));
  p.push(box(670, 462, 360, 76, "llm", t.judge[0] ?? "", [t.judge[1] ?? "", t.judge[2] ?? ""]));
  p.push(arrow("M850 538 L850 560", "llm"));
  p.push(box(670, 562, 360, 58, "code", t.verdict[0] ?? "", [t.verdict[1] ?? ""]));
  p.push(legend(20, 610, lang));
  const lx = lang === "zh" ? 250 : 320;
  p.push(`<circle cx="${lx}" cy="606" r="5" class="b-llm"/>`);
  p.push(
    label(
      lx + 12,
      610,
      t.light === "light model" ? "code with a light-model fallback" : "代码为主，必要时调用轻模型",
    ),
  );
  return { w: 1050, h: 640, title: t.title, body: p.join("") };
}

/**
 * Splits text into lines of at most `max` characters, at spaces when there are any.
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function wrap(text, max) {
  if (!text.includes(" ")) {
    const out = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    const cur = lines[last] ?? "";
    if (cur && cur.length + 1 + word.length > max) lines.push(word);
    else lines[last] = cur ? `${cur} ${word}` : word;
  }
  return lines;
}

/**
 * Every diagram file, named as docs/images holds it.
 * @returns {Map<string, string>}
 */
export function renderDiagrams() {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const lang of /** @type {Lang[]} */ (["en", "zh"])) {
    for (const [name, draw] of /** @type {const} */ ([
      ["system", system],
      ["agents", agents],
    ])) {
      const d = draw(lang);
      for (const theme of /** @type {const} */ (["light", "dark"])) {
        files.set(`${name}-${lang}-${theme}.svg`, svg(THEMES[theme], d.w, d.h, d.title, d.body));
      }
    }
  }
  return files;
}
