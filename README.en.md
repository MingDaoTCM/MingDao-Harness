# MingDao Harness — English README

> **Language policy.** The canonical documentation of this project is **Chinese**.
> The Chinese [`README.md`](README.md) and everything under [`docs/`](docs/) are the reference.
> This English README covers only the minimum needed to **evaluate and deploy** the project.
> Where this file and the Chinese docs disagree, **the Chinese docs and the code win**.
> (中文：规范文档为中文，本英文 README 只覆盖评估与部署所需的最低限度内容；两者不一致时以中文文档与代码为准。)

---

## What it is

MingDao Harness (`mingdao`, short alias `mdh`) is a **zero-runtime-dependency** agent harness written
in plain Node.js: a model loop plus tools plus a permission layer, driven from a terminal TUI, a local
WebUI, an Electron desktop shell, or an IDE plugin. It ships with a declarative-plus-programmable
"Pack" system for domain packages. It is **not** a sandbox and **not** a security boundary for
untrusted code you choose to load — see the security model below, including the parts it deliberately
does not cover (this file is written so a reviewer can decide that, not to make the project look safer
than it is).

- Node.js **>= 18.17** (`package.json` `engines`), no build step, no npm runtime dependencies.
- Current version: **0.6.8** · License: **MIT**.
- Repo: <https://github.com/MingDaoTCM/MingDao-Harness> · Package: `mingdao-harness` on npm.

## Quickstart (3 steps)

**1. Install.**

```bash
# Any platform, via npm (installs both `mingdao` and `mdh`)
npm i -g mingdao-harness
```

Or take the **desktop build** from GitHub Releases (Electron; unsigned — see "Known boundaries" in
[`SECURITY.md`](SECURITY.md)): <https://github.com/MingDaoTCM/MingDao-Harness/releases>

**2. Configure a key.**

```bash
mingdao init          # wizard: provider -> API Key (hidden input) -> model -> permission -> sandbox
```

**3. Run.**

```bash
mingdao               # interactive TUI (REPL)
mingdao web           # WebUI on http://127.0.0.1:3820 by default
```

One-shot / scripted use:

```bash
mingdao "explain this stack trace"
mingdao --format json "summarize the diff"     # single-line structured output
mingdao run "run the test suite and fix failures"   # background task
```

## Security model

Every row states a **mechanism** and, in the same row, **its boundary**. A mechanism that is not
enforced by the kernel is described as a declaration, not as a control.

| Mechanism | What it does | Its boundary (read this) |
| --- | --- | --- |
| **Permission modes** — `config.permission` | `"ask"` (default), `"auto"`, `"readonly"`, or an object `{ "mode": "ask", "allow": [...], "deny": [...], "denyStrict": false }`. Rules match a tool name or `tool:argument-prefix*`. Read-only tools (`read`, `glob`, `grep`, `ls`, `skill`, `git`, `fetch`) auto-pass in every mode. | `deny` is **not** a hard block by default: a hit prompts "force allow this once?" and a `y` bypasses your own rule. Only `denyStrict: true` removes that override (and additionally refuses `sh -c` / `eval`-wrapped commands, because a deny rule cannot see the real command inside the argument). Under `auto` nothing else prompts, so `deny` is the only rule that can intervene — and it remains bypassable with a `y` until `denyStrict` is set. `allow` prefix rules for `bash` deliberately refuse to match any command containing shell metacharacters. |
| **Sandbox** — `config.sandbox` | `"off"` (default), `"readonly"` (whole filesystem read-only, `/tmp` writable, network available), `"safe"` (read-only + no network via `unshare-net`; working dir and `/tmp` writable). Implemented with **bubblewrap** on **Linux only**. | If the platform is not Linux or `bwrap` is missing/incapable, it **downgrades to `off`** and says so in the tool result — it never silently pretends to be sandboxed. It wraps the `bash` tool only; the file tools are governed by the permission modes, not by this. |
| **Credential separation** | API keys live in `<home>/credentials.json` (`<home>` defaults to `~/.mingdao`, overridable with `MINGDAO_HOME`), written atomically and forced to mode **600**. `config.json` is key-free, so it is shareable and committable. Resolution order: environment variable → local credential store → legacy `config.json` field. Manage with `mingdao key`. | The legacy `config.json` `"apiKey"` field is still **read** for backward compatibility — do not use it. Keys are stored as plaintext in your home directory (no OS keychain), so any process running as your user can read them. `mingdao key status` and logs only ever print a masked form. |
| **Telemetry opt-out** | Only **packaged desktop builds** send anything, and only one event: after an update finishes downloading, a `POST` to `https://harness.mingdao.ai/updok` with `{"kind":"update","os":...,"ver":...}` — no user identifier, no session, no code. | It is **opt-out, not opt-in**: on by default in packaged builds. Disable with `MINGDAO_NO_TELEMETRY=1` or `"telemetry": false` in `config.json`; updates still download and install. The CLI and the WebUI send **no** telemetry at all. |
| **PID ownership** | Before `killTask` / `stopDaemon` signals a pid, it verifies the pid still belongs to the process we started (Linux reads `/proc/<pid>/cmdline`, macOS falls back to `ps -ww -o command=`). Three-valued: ours / definitely not ours / unknown. | **Windows has neither `/proc` nor `ps`**, and the project deliberately does not take a PowerShell/WMI dependency for this check, so ownership is reported as unknown and the caller falls back to best-effort "process is alive". Deploy on Linux or macOS if you need precise pid-ownership checks. |
| **Egress gate** — `config.net` | `{ "allow": ["api.deepseek.com", "*.internal.corp", "10.0.0.0/8"], "mode": "warn", "allowLoopback": true }` — `warn` (default) logs and allows, `block` refuses. Decisions are made at a single HTTP exit and recorded per event (host, port, decision, matched rule); `mingdao net report` exports the record as evidence. Non-`fetch` paths (`node:https` sync, `safe-fetch` for skill/registry/model discovery) are wired into the same decision point. Loopback is exempt; private ranges are not. | **It does not cover child processes.** Your own `curl` inside `bash`, **MCP server processes**, `config.tools` and Pack-spawned subprocesses, and the Electron shell's update check all make their own requests that the gate never sees. It proves *"the kernel did not exfiltrate"*, **not** *"this machine never egressed"*. `net.jsonl` records hosts/ports/decisions, never request bodies or full URLs. If unconfigured, the gate is not installed at all. For process-level enforcement use an egress proxy or firewall. |
| **SSRF protection** | One implementation (`src/ssrf-guard.js`): literal private / loopback / link-local / cloud-metadata hosts are refused (IPv4 plus all IPv6 forms, including IPv4-mapped, NAT64 and zone-ids); a hostname is resolved and **every** resolved address is checked; a hostname that fails to resolve is refused. The **validated IP is pinned to the connection layer** (via the `lookup` option of `node:http(s)`), so the check-time and connect-time resolutions cannot differ — this closes DNS rebinding. Redirects are re-checked per hop and cross-origin hops drop credential headers using a reverse allowlist. | The rule is fail-closed by design, which means it can over-block unusual-but-legitimate targets (odd IPv6 forms, `%`-scoped hosts); the fix is to use a literal, routable address or a proper hostname. It protects harness-initiated requests; it cannot constrain a subprocess' own networking (see the row above). |
| **Pack trust** | A project-level `.mingdao/packs/**` is **not mounted** until you explicitly run `mingdao pack trust <project-dir>`. Trust is pinned to content: if the Pack's content changes afterwards, trust lapses automatically. `mingdao pack verify <dir>` is **static by default** and does not execute Pack code; only `--runtime` imports it. | `manifest.permissions` (`fs` / `net` / `env`) is a **declaration, not enforcement**. The kernel does not enforce it: `pack.mjs` is imported into the **host process** and runs with full Node privileges — it can read and write any file and reach the network — and Pack-contributed tools are **not** subject to `config.permission`. Packs you list explicitly in `config.packs` bypass the trust gate, because that is your own written authorization. Treat installing a Pack as equivalent to running its code. |
| **Execution ledger** | Per-turn event streams under `<home>/ledger/`, each event chained to the previous one by a truncated SHA-256 digest starting from a fixed genesis value, plus a `run.end` seal sidecar. Details are redacted on write and again on export. Inspect with `mingdao ledger list\|show\|export\|verify` (there is also `replay`, which re-evaluates recorded calls against your *current* rules offline). | Hash chain + seal prove "unchanged and not truncated **since it was written**". There is **no trusted timestamp and no signature** (optional signing is not implemented), so it is **not** audit-grade non-repudiation — `verify` says so in its own output. |
| **WebUI exposure** | Binds `127.0.0.1:3820` by default. When bound to a non-loopback address without a configured token, the server generates a random token for that run and prints a `?token=` URL. Tokens also accepted via `X-MingDao-Token` or `Authorization: Bearer`. Host header is checked against loopback/bind names (anti-DNS-rebinding), cross-site browser requests are rejected, and cloud-metadata endpoints are always refused. | On loopback with no token configured there is **no authentication** (local trust by design). With `host: 0.0.0.0` the Host-header check is relaxed and the **token becomes the only boundary**, so a token is mandatory in that mode. The token is deployment-level: everyone sharing it is the same user, and task/session lists are mutually visible. |

## Command index

Commands are grouped here for evaluation; `mingdao --help` and `src/help.js` are the source of truth.

| Command | Purpose |
| --- | --- |
| `mingdao` | Interactive TUI (REPL). |
| `mingdao "question"` | One-shot question; `--format json` for structured output. |
| `mingdao init` | First-run wizard (provider → API Key → model → permission → sandbox). |
| `mingdao run "<task>"` | Start a background task (managed via `mingdao tasks`). |
| `mingdao tasks [watch\|kill <id>]` | List / live-refresh / stop background tasks. |
| `mingdao web [port]` | Start the WebUI (default `http://127.0.0.1:3820`); `--auth-token` (or `--auth-token=-` from stdin). |
| `mingdao diagnose` | Build one redacted diagnostic bundle (logs / audit / config) for bug reports. |
| `mingdao audit [n]` | Show the tool-call audit log (default last 20 entries). |
| `mingdao ledger list\|show\|export\|verify\|replay` | Execution ledger: inspect, export, verify the hash chain, or replay against current rules. |
| `mingdao net report\|policy` | Egress record export and current `config.net` policy. |
| `mingdao key [status\|set\|remove\|import] [provider]` | Manage the local credential store (never writes keys into `config.json`). |
| `mingdao pack list\|verify\|info\|new\|trust\|untrust` | Discover, statically validate, scaffold, and trust domain Packs. |
| `mingdao batch <file\|->` | Batch API (half price) over one question per line; `--model`, `--max-tokens`, `--max-cost`. |
| `mingdao cost [report [YYYY-MM\|all]]` | Cost report / monthly export; `--by pack` for per-Pack attribution. |
| `mingdao schedule add\|list\|remove\|pause\|resume\|chain` | Scheduled and chained tasks. |
| `mingdao sync login\|status\|push\|pull\|logout` | Cross-device session sync client; also `passwd` (change password), `share` / `shares` / `accept` / `unshare` (session sharing) and `conflicts` / `conflict-resolve`. |
| `mingdao sync-server [port]` | Self-hosted zero-dependency sync server. |
| `mingdao skill search\|install\|uninstall\|update\|trust` | Skill library (built-in plus a remote registry). |
| `mingdao sessions search <keyword>` | Full-text search over historical sessions. |
| `mingdao workspace add\|list\|use\|path\|remove` | Register and switch project directories. |
| `mingdao mcp preset list\|add <name>` | MCP ecosystem presets; `mcpServers` in `config.json` for arbitrary servers. |
| `mingdao update [--check]` / `mingdao rollback` | Self-update (git installs) / roll back to the previous revision; `update --pricing` refreshes the price table. |
| `mingdao desktop` | Launch the Electron desktop build. |
| `mingdao autostart on\|off` | Start the server automatically at login. |
| `mingdao --preset <name>` | Apply a declarative agent preset (tool allowlist / permission / model). In-session the equivalent is `/preset`. |
| `mingdao --help` / `--version` | Help / version. |

## Docs index

The full reference is **Chinese**; these are the entry points worth knowing:

- [`docs/CONFIG.md`](docs/CONFIG.md) — every `config.json` field: permission rules, sandbox, `config.net`, hooks, MCP, sync, cost guard.
- [`docs/CONFIG.en.md`](docs/CONFIG.en.md) — English configuration reference (verified against the code): permissions, sandbox & env filtering, egress gate and its limits, cost guard, WebUI exposure, audit/ledger, full field table.
- [`docs/PACK-API.md`](docs/PACK-API.md) — the Pack contract (manifest, contributions, constraint kinds, and which of them are **not** implemented).
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — built-in providers and writing a custom OpenAI-compatible provider.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map and data flow.
- [`docs/DEVELOPER.md`](docs/DEVELOPER.md) — stable export surface and embedding the harness as a library.
- [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md) — desktop code-signing / notarization status and the steps to sign.
- [`docs/internal/AUDIT-v0.6.1-第三方报告登记.md`](docs/internal/AUDIT-v0.6.1-第三方报告登记.md) — third-party audit register, including the sections that list **what is still unclosed**. (`docs/internal/` holds internal process records and is not shipped in the npm package.)
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, scope, hardening checklist, known boundaries.
- [`docs/internal/`](docs/internal/) — plan/strategy/release/audit records (Chinese, not shipped in the npm package).

**Language policy (restated).** Canonical docs are Chinese; this English README covers the minimum
needed to evaluate and deploy; **when they disagree, the Chinese docs and the code win.**

## Reporting security issues

Please use GitHub Security Advisories (private) rather than a public issue — see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
