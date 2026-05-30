# BaselineLens

## Project context

A two-audience desktop dashboard for evaluating a Windows 11 endpoint against a hardening baseline (e.g. CIS Microsoft Intune for Windows 11 Benchmark v4.0.0). Manager-facing **Overview** tab reads as a one-page report; admin-facing **Console** tab is a filterable workbench.

**Stack:** Tauri 2 (Rust backend) + React 19 + TypeScript (Vite frontend) + PowerShell (audit scripts spawned at runtime). Distributed as a single Windows `.msi` installer.

**Architecture (settled):** the dashboard renders a structured `Baseline` produced at runtime by a Rust parser that reads a CIS PDF the user supplies. The audit step writes the baseline to disk as JSON, spawns `powershell.exe` against a static dispatcher script (`ps/audit.ps1`, baked into the binary via `include_str!`) that reads the baseline JSON and dispatches per recommendation, captures NDJSON results on stdout, and merges them back. **No Benchmark-derived creative content ships in the repo.**

**v1 scope:** local-only audit (the dashboard runs on the device being audited). Cross-machine PS export is deferred.

## Critical rules

- **Never commit CIS Benchmark prose.** Recommendation titles (their specific phrasing), descriptions, rationale text, and audit/remediation procedure text are off-limits. **Factual OS configuration data** — registry paths, GPO paths, expected DWORD/string/binary values — is fact, not prose, and is fine to ship. Test fixtures must use invented prose; real OS setting paths alongside is fine.
- **Marketing/UI copy stays nominative.** Acceptable: "parses CIS Microsoft Intune for Windows 11 Benchmark PDFs you provide." Never: "CIS-compliant," "CIS-certified," or anything implying CIS endorsement. Applies to in-app strings, error messages, docstrings.
- **Don't commit without an explicit user ask.** A task list entry is not authorization; only a direct instruction is.

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
- **TS bindings**: generate from Rust structs via `tauri-specta`. Never hand-maintain dual definitions.
- **Capabilities** (`src-tauri/capabilities/`): minimum-permissions principle. Don't grant `fs:default` or `shell:allow-execute` blanket; allowlist specific commands and paths.
- **`tauri.conf.json`**: edit by hand. The Tauri VS Code extension provides schema autocomplete.

## Frontend conventions (React + TypeScript)

- No explicit `any`, even where TS would let you. Use `unknown` and narrow.
- **Function components only.** Hooks for state; no class components. The sole exception is the top-level error boundary (`src/ErrorBoundary.tsx`).
- **App-wide state goes through context, not prop drilling.** Display preferences (theme, time format, density) reach their consumers via `src/app/PreferencesContext.tsx` (`usePreferences()`), not threaded through intermediaries like Dashboard. `App` still owns the state and persistence; the context only delivers it. One context per concern; memoize the value (App re-renders often). Don't reach for context for state with a single consumer.
- **Styling**: CSS tokens from `src/styles/tokens.css`. No inline styles for layout; inline only for one-off dynamic values that depend on data.
- **Component file layout**: one component per file unless tightly-coupled siblings; co-locate component-local types at the top of the file.
- **Imports**: external packages first, then `@/` aliases, then relative — separated by a blank line.

## PowerShell conventions

- **Target version: PowerShell 5.1** (the default on Windows 11). PS 7 will run 5.1 syntax, but we don't require users to have PS 7. Avoid 7-only features: `??` (null-coalescing), `?.` (null-conditional), ternary `condition ? a : b`, `ForEach-Object -Parallel`, `Get-Error`, `pwsh`-only modules. Dev environment on Mac is PS 7 (`pwsh`); real audit-cmdlet testing must happen on Windows since most cmdlets we use (`Get-ItemProperty HKLM:\...`, `Get-BitLockerVolume`, `secedit`, etc.) are Windows-only.
- **Layout**: `ps/audit.ps1` is one static dispatcher that reads the parsed baseline JSON at runtime and branches via `switch ($audit.type)`. There are no per-rule template files — a new rule type is a new dispatch arm here plus a new `AuditProcedure` variant in `parser/model.rs` and a classifier under `parser/classify/`. The Rust runner stages four helper scripts plus the dispatcher to one directory, then runs a bootstrap that verifies each staged file against the SHA-256 digest the trusted binary computed before dot-sourcing it into a single shared scope (this digest-checked launcher replaced the dispatcher's earlier `$PSScriptRoot` self-sourcing to close a script-tampering hole). The helpers: `audit-registry.ps1` (registry reads + path resolution), `audit-security-policy.ps1` (secedit/auditpol dumps, SID/principal resolution, display-name maps), `audit-system-read.ps1` (escalates ACL-locked registry reads — e.g. the Defender Policy Manager key — to SYSTEM via a one-shot scheduled task), and `device-info.ps1` (also runs standalone for the onboarding device-info command). Helpers are grouped by concern, not by rule type. Dot-sourcing shares their functions and `$script:` state across the run.
- **Output contract**: scripts emit NDJSON to stdout — one JSON object per line, discriminated by `type` (e.g. `{"type":"device",...}`, `{"type":"result",...}`). Errors go to stderr, never to stdout.
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
├── LICENSE-MIT, LICENSE-APACHE
├── package.json, tsconfig.json, tsconfig.node.json
├── vite.config.ts, vitest.config.ts, index.html
├── scripts/              # bump-version.js (sync version across package.json, tauri.conf.json, Cargo.toml)
├── src/                  # React frontend (TS)
│   ├── App.tsx, main.tsx, ErrorBoundary.tsx   # shell + top-level boundary
│   ├── Overview.tsx, Console.tsx, Onboarding.tsx  # the three top-level screens
│   ├── app/             # post-load shell (Dashboard, SettingsMenu, banners) + PreferencesContext
│   ├── overview/        # Overview's per-section components + util.ts
│   ├── console/         # Console table, filters, saved views
│   │   └── drawer/      # the recommendation detail drawer's sections
│   ├── data/            # pure logic: scoring, deltas, filtering, export (unit-tested)
│   ├── format.ts        # timestamp/age display formatters
│   ├── bindings.ts      # generated by tauri-specta on each debug build — do not edit
│   ├── styles/          # tokens.css design tokens
│   └── test/            # shared vitest fixtures (*.test.ts live next to their source)
└── src-tauri/           # Rust backend
    ├── Cargo.toml, tauri.conf.json, build.rs
    ├── src/
    │   ├── lib.rs       # builds the Specta command list + Tauri app; exports bindings.ts in debug
    │   ├── commands.rs  # #[tauri::command] surface
    │   ├── host.rs      # standalone device-info reader for the onboarding strip
    │   ├── parser/      # CIS PDF → Baseline (pdf, structure, classify/*, model)
    │   ├── audit/       # script generation, runner, elevation, NDJSON merge, model
    │   └── storage/     # appdata paths + JSON persistence
    ├── ps/              # PowerShell baked in via include_str!: audit.ps1 dispatcher,
    │                    #   audit-registry.ps1 + audit-security-policy.ps1 +
    │                    #   audit-system-read.ps1 helpers, device-info.ps1
    ├── capabilities/
    ├── icons/
    └── tests/fixtures/  # synthetic prose required; real OS setting paths/values OK
```

Frontend tests run on **vitest** (`npm test`); `tsc --noEmit` type-checks the whole `src/` tree including tests. TS bindings are regenerated from the Rust command/type metadata on every debug build (see `lib.rs`), so `src/bindings.ts` is never hand-edited.
