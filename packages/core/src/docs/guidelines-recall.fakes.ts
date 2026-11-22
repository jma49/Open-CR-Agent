// A monorepo's AGENTS.md and the changes whose reviews need its sections:
// the recall corpus for guideline selection (ADR-0058).
export const MONOREPO_GUIDELINES = `# AGENTS.md

Rules for everyone working here. Run \`npm run verify\` before every push.

## Security

- Never log a token or a request body; see \`src/log/redact.ts\` for the helper.
- Validate every input at the boundary (\`api/http.ts\`).

## Testing

New behaviour ships with a test; never mock the database.

## \`web/\`

The console is React. Style through the tokens in \`web/src/tokens.css\` only.

### Components

Components stay under 200 lines; one per file.

## \`api/\` and \`worker/\`

Routes read bodies only through \`jsonBody\`; every query goes through \`scoped()\`.

### Migrations

Never edit an applied migration; run \`npm run db:generate\`.

## docs/manual/

The manual has an English and a Chinese page for everything.

## Commit messages

Conventional Commits, imperative, at most 72 characters.
`;

export interface GuidelineCase {
  name: string;
  files: string[];
  // Headings the review of these files must be given.
  needs: string[];
  // Headings about other parts that it should not be given.
  spares: string[];
}

const GENERAL = ["AGENTS.md", "Security", "Testing", "Commit messages"];

export const GUIDELINE_CASES: GuidelineCase[] = [
  {
    name: "a console component",
    files: ["web/src/components/Button.tsx"],
    needs: [...GENERAL, "`web/`", "Components"],
    spares: ["`api/` and `worker/`", "Migrations", "docs/manual/"],
  },
  {
    name: "a route and its migration",
    files: ["api/routes/reviews.ts", "api/migrations/0042_add.sql"],
    needs: [...GENERAL, "`api/` and `worker/`", "Migrations"],
    spares: ["`web/`", "Components", "docs/manual/"],
  },
  {
    name: "the worker",
    files: ["worker/queue.ts"],
    needs: [...GENERAL, "`api/` and `worker/`", "Migrations"],
    spares: ["`web/`", "Components", "docs/manual/"],
  },
  {
    name: "a manual page",
    files: ["docs/manual/en/install.mdx"],
    needs: [...GENERAL, "docs/manual/"],
    spares: ["`web/`", "Components", "`api/` and `worker/`", "Migrations"],
  },
  {
    name: "a root file",
    files: ["package.json"],
    needs: GENERAL,
    spares: ["`web/`", "Components", "`api/` and `worker/`", "Migrations", "docs/manual/"],
  },
  {
    name: "a change across parts",
    files: ["web/src/api.ts", "api/routes/reviews.ts", "docs/manual/zh/install.mdx"],
    needs: [
      ...GENERAL,
      "`web/`",
      "Components",
      "`api/` and `worker/`",
      "Migrations",
      "docs/manual/",
    ],
    spares: [],
  },
  {
    name: "a path in another case",
    files: ["WEB/Src/Page.tsx"],
    needs: [...GENERAL, "`web/`", "Components"],
    spares: ["`api/` and `worker/`"],
  },
];
