# BaselineLens

## Project context

A two-audience desktop dashboard for evaluating a Windows 11 endpoint against a hardening baseline (e.g. CIS Microsoft Intune for Windows 11 Benchmark v4.0.0). Manager-facing **Overview** tab reads as a one-page report; admin-facing **Console** tab is a filterable workbench.

**Stack:** Tauri 2 (Rust backend) + React 19 + TypeScript (Vite frontend) + PowerShell (audit scripts spawned at runtime). Distributed as a single Windows `.msi` installer.

**Architecture (settled):** the dashboard renders a structured `BenchmarkSpec` produced at runtime by a Rust parser that reads a CIS PDF the user supplies. The audit step generates a `.ps1` from that spec, spawns `powershell.exe`, captures JSON results, and merges them back. **No Benchmark-derived creative content ships in the repo.**

**v1 scope:** local-only audit (the dashboard runs on the device being audited). Cross-machine PS export is deferred.

Hi-fi design lives under `design/` — preserved as reference; the React port lives under `src/`.

## Critical rules

- **Never commit CIS Benchmark prose.** Recommendation titles (their specific phrasing), descriptions, rationale text, and audit/remediation procedure text are off-limits. **Factual OS configuration data** — registry paths, GPO paths, expected DWORD/string/binary values — is fact, not prose, and is fine to ship. Test fixtures must use invented prose; real OS setting paths alongside is fine.
- **Marketing/UI copy stays nominative.** Acceptable: "parses CIS Microsoft Intune for Windows 11 Benchmark PDFs you provide." Never: "CIS-compliant," "CIS-certified," or anything implying CIS endorsement. Applies to in-app strings, error messages, docstrings.
- **Don't commit without an explicit user ask.** A task list entry is not authorization; only a direct instruction is.
- **Don't write README.md or other user-facing docs preemptively.** Defer until there's working code worth describing.

## Rust conventions

`rustfmt` with default config IS our formatting style. The official Rust Style Guide (https://doc.rust-lang.org/style-guide/) documents what `rustfmt` enforces — when in doubt, defer to `rustfmt`.

### Naming

Follow the [Rust API Guidelines naming chapter](https://rust-lang.github.io/api-guidelines/naming.html). Refer there for case conventions, conversion prefixes (`as_`/`to_`/`into_`), getter style (unprefixed), predicate style (`is_`/`has_`), and constructor patterns (`new`/`with_`/`from_`).

### Error handling

- Use `thiserror` for crate-defined error types (`#[derive(Error, Debug)]`).
- Use `anyhow` only at the absolute outer boundary (`main.rs`) where catch-all is acceptable.
- **Never `.unwrap()` outside tests or `main.rs`.** Propagate with `?`. If a value is genuinely infallible-by-construction, use `.expect("specific reason this is infallible")` — never bare `.expect("oops")`.
- Tauri commands return `Result<T, String>` — Tauri serializes the error string for the frontend.

### Visibility

- Default to private. Add visibility only when the symbol is used outside its module.
- `pub(crate)` for cross-module use within the crate.
- `pub` only at the public API boundary (small for an app — most code is `pub(crate)` or private).

### Module organization

- One concept per module. If a `mod foo` grows past ~300 lines or accumulates unrelated responsibilities, split it.
- Unit tests live at the bottom of the file they test, in `#[cfg(test)] mod tests { ... }`.
- Integration tests live in `src-tauri/tests/`.

### Imports

- **Types** (structs, enums, traits): import directly. `use crate::storage::model::UserState;` then write `UserState`.
- **Functions / macros**: import the parent module. `use crate::storage::persist;` then write `persist::load_user_state()`. The module prefix at the call site documents where the function lives — context that gets lost when you import the function itself.
- Three import blocks separated by blank lines: stdlib, third-party crates, then internal (`crate::...`).
- Multi-item imports alphabetized: `{AppState, UserState}` not `{UserState, AppState}`.

### Comments and doc comments

- Comments explain *why*, not *what*. The code already says what.
- No comments referencing current task state ("added for X", "TODO from issue Y") — those belong in commit messages or PR descriptions.
- `///` doc comments on public-API symbols. No doc-comment theater on private internals.
- **Docstrings use descriptive third-person present tense** — "Returns the parsed BenchmarkSpec," "Parses the PDF at `path`," "Spawns the audit script and captures JSON output." Not imperative — "Return the spec," "Parse the PDF," "Spawn the script." Matches the Rust standard library convention. Same applies to TSDoc/JSDoc and PowerShell comment-based help.

### Cargo.toml

- Dependencies sorted alphabetically within their section.
- Pin major version with caret (`"2"` means `^2.x`); avoid `*` or unbounded.
- Group ordering: `[dependencies]`, `[build-dependencies]`, `[dev-dependencies]`.

### Lint

`cargo clippy --all-targets` before commit. Fix warnings as they appear; we don't deny-on-warnings yet.

## Tauri conventions

- **Commands** (`#[tauri::command]`): small, single-purpose, return `Result<T, String>`. `snake_case` on the Rust side; the same name is invoked from TS (`invoke('parse_pdf', { path })`).
- **State**: managed via `tauri::State<T>`; never globals or `static mut`. State types implement `Send + Sync`; wrap mutability in `Mutex`/`RwLock`.
- **TS bindings**: generate from Rust structs via `tauri-specta` (when added). Never hand-maintain dual definitions.
- **Capabilities** (`src-tauri/capabilities/`): minimum-permissions principle. Don't grant `fs:default` or `shell:allow-execute` blanket; allowlist specific commands and paths.
- **`tauri.conf.json`**: edit by hand. The Tauri VS Code extension provides schema autocomplete.

## Frontend conventions (React + TypeScript)

- No explicit `any`, even where TS would let you. Use `unknown` and narrow.
- **Function components only.** Hooks for state; no class components.
- **Styling**: CSS tokens from `src/styles/tokens.css` (ported from `design/v2/tokens-v2.css`). No inline styles for layout; inline only for one-off dynamic values that depend on data.
- **Component file layout**: one component per file unless tightly-coupled siblings; co-locate component-local types at the top of the file.
- **Imports**: external packages first, then `@/` aliases, then relative — separated by a blank line.

## PowerShell conventions

- **Target version: PowerShell 5.1** (the default on Windows 11). PS 7 will run 5.1 syntax, but we don't require users to have PS 7. Avoid 7-only features: `??` (null-coalescing), `?.` (null-conditional), ternary `condition ? a : b`, `ForEach-Object -Parallel`, `Get-Error`, `pwsh`-only modules. Dev environment on Mac is PS 7 (`pwsh`); real audit-cmdlet testing must happen on Windows since most cmdlets we use (`Get-ItemProperty HKLM:\...`, `Get-BitLockerVolume`, `secedit`, etc.) are Windows-only.
- **Templates** (`ps/templates/*.ps1.tera`): one rule type per template (registry, secedit, BitLocker, etc.). Tera variables only at the top of the file.
- **Output contract**: every audit script emits a single JSON document to stdout — `[{id, status, current_value, expected_value}]`. Errors go to stderr, never to stdout.
- **Naming**: PowerShell-approved verbs (`Get-`, `Set-`, `Test-`, `Invoke-` — see `Get-Verb`).
- **Style**: PSScriptAnalyzer defaults; no aliases (`gci` → `Get-ChildItem`); `param()` blocks at the top with explicit types.

## Toolchain — common commands

```
# Dev (frontend hot-reload + Tauri rebuild on Rust change)
npm run tauri dev

# Production build (.msi on Windows; .app on Mac)
npm run tauri build

# Rust
cargo fmt                           # format
cargo clippy --all-targets          # lint
cargo check                         # typecheck without producing artifacts
cargo test                          # run tests

# Frontend
npm run dev                         # Vite alone (no Tauri shell)
npm run build                       # type-check + Vite production build
```

## Commits and branching

**Format: [Conventional Commits](https://www.conventionalcommits.org/).** `type(scope): subject` + optional body.

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `build`, `ci`, `test`, `perf`, `style`.

Scopes (optional): `parser`, `audit`, `ui`, `tokens`, `ps`, `tauri`, `deps`.

Subject in imperative mood, lowercase, ≤70 chars, no trailing period. Body explains *why*; wrap at 72 chars.

Examples:
- `feat(parser): extract recommendation IDs from CIS PDF`
- `fix(audit): handle missing registry keys without panicking`
- `chore(deps): bump tauri to 2.11.1`
- `docs: add CIS content policy`

**Branching: trunk-based.** Default to commits direct to `main`. Use a feature branch only when:
1. Multi-day exploratory work that might be abandoned (clean throwaway via `git branch -D`).
2. CI gating is added (PRs trigger checks).
3. Another contributor joins.

When branching, use `type/short-description` (`feat/parser-extraction`, `fix/registry-key-panic`). Squash-and-merge to keep `main` linear.

## Repo layout

```
baselinelens/
├── CLAUDE.md, .gitignore, .gitattributes
├── package.json, tsconfig.json, vite.config.ts, index.html
├── src/                  # React frontend (TS) — to be populated from design/v2/
├── src-tauri/            # Rust backend
│   ├── Cargo.toml, tauri.conf.json, build.rs
│   ├── src/
│   ├── capabilities/
│   ├── icons/
│   └── tests/fixtures/   # synthetic prose required; real OS setting paths/values OK
├── ps/                   # PowerShell template fragments + helpers (to be created)
└── design/               # design reference; HTML/JSX prototype + tokens
```
