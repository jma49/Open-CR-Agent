import { posix } from "node:path";
import picomatch from "picomatch";
import { TEST_FILES } from "../review/reviewers/scopes.js";

// How a language writes a doc comment, which edits.ts checks every inserted
// block against.
export type DocComment =
  | { kind: "block" }
  | { kind: "line"; marker: "//" | "///" }
  | { kind: "python" };

// Where a new test of a source file goes. `looksAt`: the directories whose
// files tell the repository's convention; `pathFor` is given their files.
// Undefined: the source has no conventional test path.
export interface TestConvention {
  looksAt(source: string): string[];
  pathFor(source: string, files: (dir: string) => readonly string[]): string | undefined;
}

export interface Language {
  name: string;
  doc: DocComment;
  // How the model should write the doc comment.
  docStyle: string;
  // Absent: ocra writes no tests in this language.
  tests?: TestConvention;
}

const isTest = picomatch(TEST_FILES, { dot: true, nocase: true });

export function isTestFile(path: string): boolean {
  return isTest(path);
}

const jsTests: TestConvention = {
  looksAt: (source) => [posix.dirname(source), posix.join(posix.dirname(source), "__tests__")],
  pathFor(source, files) {
    const { dir, name, ext } = posix.parse(source);
    const folder = posix.join(dir, "__tests__");
    if (files(folder).some(isTestFile)) return posix.join(folder, `${name}.test${ext}`);
    const beside = files(dir || ".");
    const specs = beside.some((f) => /\.spec\.[^./]+$/.test(f));
    const tests = beside.some((f) => /\.test\.[^./]+$/.test(f));
    return posix.join(dir, `${name}.${specs && !tests ? "spec" : "test"}${ext}`);
  },
};

const pythonTests: TestConvention = {
  looksAt: (source) => [posix.dirname(source), "tests"],
  pathFor(source, files) {
    const { dir, name } = posix.parse(source);
    const beside = files(dir || ".").map((f) => posix.basename(f));
    const suffixed = beside.some((f) => /^(?!test_).+_test\.py$/.test(f));
    const prefixed = beside.some((f) => /^test_.+\.py$/.test(f));
    if (suffixed && !prefixed) return posix.join(dir, `${name}_test.py`);
    if (!prefixed && files("tests").some((f) => /(^|\/)test_[^/]+\.py$/.test(f))) {
      return `tests/test_${name}.py`;
    }
    return posix.join(dir, `test_${name}.py`);
  },
};

const goTests: TestConvention = {
  looksAt: () => [],
  pathFor(source) {
    const { dir, name } = posix.parse(source);
    return posix.join(dir, `${name}_test.go`);
  },
};

// Maven and Gradle keep tests in a tree beside the sources.
function jvmTests(language: "java" | "kotlin", ext: string): TestConvention {
  const main = new RegExp(`(^|/)src/main/${language}/`);
  return {
    looksAt: () => [],
    pathFor(source) {
      if (!main.test(source)) return undefined;
      const { dir, name } = posix.parse(source.replace(main, `$1src/test/${language}/`));
      return posix.join(dir, `${name}Test${ext}`);
    },
  };
}

const block = { kind: "block" } as const;
const jsDoc = "JSDoc: /** ... */, with @param and @returns where they add to the names and types";
const typescript: Language = { name: "TypeScript", doc: block, docStyle: jsDoc, tests: jsTests };
const javascript: Language = { name: "JavaScript", doc: block, docStyle: jsDoc, tests: jsTests };

const LANGUAGES: Readonly<Record<string, Language>> = {
  ".ts": typescript,
  ".tsx": typescript,
  ".mts": typescript,
  ".cts": typescript,
  ".js": javascript,
  ".jsx": javascript,
  ".mjs": javascript,
  ".cjs": javascript,
  ".py": {
    name: "Python",
    doc: { kind: "python" },
    docStyle: 'a """ docstring (PEP 257) as the first statement of the body, indented like it',
    tests: pythonTests,
  },
  ".go": {
    name: "Go",
    doc: { kind: "line", marker: "//" },
    docStyle: "// comment lines that start with the declared name, as godoc reads them",
    tests: goTests,
  },
  ".rs": {
    name: "Rust",
    doc: { kind: "line", marker: "///" },
    docStyle: "/// outer doc comment lines, in Markdown",
  },
  ".java": {
    name: "Java",
    doc: block,
    docStyle: "Javadoc: /** ... */ with @param, @return and @throws where they help",
    tests: jvmTests("java", ".java"),
  },
  ".kt": {
    name: "Kotlin",
    doc: block,
    docStyle: "KDoc: /** ... */ with @param and @return where they help",
    tests: jvmTests("kotlin", ".kt"),
  },
};

// Undefined for a file that is not code ocra writes for: other languages,
// type declarations, and anything without an extension.
export function languageOf(path: string): Language | undefined {
  if (/\.d\.[cm]?ts$/i.test(path)) return undefined;
  return LANGUAGES[posix.extname(path).toLowerCase()];
}
