# Agent Notes

## Required Orientation

Before working on this repository, read `PROJECT_ARCHITECTURE.md` and this
file. Keep `PROJECT_ARCHITECTURE.md` accurate when a change affects the
application architecture, runtime dependencies, test workflow, security
boundary, or deployment model.

## Local WSL Toolchain

- Source `scripts/wsl-env.sh` before using project commands. It prepends the
  repository-local Node 22 and pnpm binaries when those tools have been
  installed under `.tools/`.
- The repository-local `.tools/` directory is intentionally ignored: it is a
  reproducible per-checkout tool cache, not source code. If it is absent, use
  the documented system prerequisites or reinstall the local tools.

## PostgreSQL Integration

- Use `pnpm test:self-host:integration` for database integration tests. It creates isolated temporary databases through `TEST_DATABASE_ADMIN_URL` and must never target a production database.
- Use `pnpm self-host:test-db:up` and `pnpm self-host:test-db:reset` for the repository PostgreSQL 16 test service when Docker is available.
- If `TEST_DATABASE_ADMIN_URL` is absent, integration tests must report an explicit skip. Do not replace PostgreSQL behavior with an in-memory database.

## Cursor Cloud specific instructions

- Node 22 and `pnpm` are preinstalled; the update script only runs `pnpm install`.
- Scripts/commands are defined in `package.json`. Notable gotchas:
  - `pnpm test` runs Vitest in watch mode (never exits). For a one-shot run use `pnpm exec vitest run`.
  - There is no `lint` script. Typecheck with `pnpm exec tsc --noEmit` (production `pnpm build` runs `tsc && vite build`).
- The dev server (`pnpm start`, Vite) binds to `localhost` only, so `curl http://127.0.0.1:5173` fails while `curl http://localhost:5173` works. Pass `--host` to expose it on other interfaces.
- `pnpm start` serves the self-hosted browser application. It expects the same-origin `/api/v1` backend; use the Compose deployment or an explicit local reverse proxy for end-to-end browser checks.

## User-facing copy

Treat UI text as scarce. The interface is not documentation.

Default to no explanatory text.

Every user-facing sentence must do at least one of the following:

- help the user make a decision;
- prevent a plausible and consequential mistake;
- communicate information the UI cannot otherwise express;
- satisfy a necessary legal, security, privacy, or accessibility requirement.

Otherwise, remove it.

Do not add defensive or reassuring copy such as:

- "This only affects..."
- "This will not..."
- "Don't worry..."
- "Your other settings remain unchanged..."
- "You can always change this later..."

unless the distinction is genuinely non-obvious and matters to the user's decision.

Do not explain what a control obviously does.
Do not restate labels, headings, selected values, or visible state.

Prefer:

control alone > short label > short helper text > paragraph.

Before finishing any UI task, audit all user-facing strings and remove copy that does not change user behavior or understanding.
