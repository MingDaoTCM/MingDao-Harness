# Security Policy

MingDao Harness (`mingdao`) is a zero-dependency agent harness that runs tools, executes shell
commands, stores model API keys locally, can host a sync server, and loads third-party "Packs" into
its own process. This document states what is supported, how to report a problem privately, what is in
scope, and — importantly — **which security boundaries are known to be incomplete**.

## Supported versions

Security fixes are provided for the **latest minor release only**.

| Version | Supported |
| --- | --- |
| **0.6.x** (current: **0.6.8**) | Yes |
| 0.5.x and older | No |

Upgrade with `npm i -g mingdao-harness@latest` (npm installs), or `mingdao update` / `mingdao rollback`
for git installs. Fixes are not backported to older minors.

## How to report

**Preferred: GitHub Security Advisories (private).**
<https://github.com/MingDaoTCM/MingDao-Harness/security/advisories/new>

**Fallback email:** `netmi@foxmail.com` — use this if you cannot use GitHub, or if the report includes
data you would rather not attach to a GitHub account.

Please include: the affected version (`mingdao --version`), your platform, a minimal reproduction, the
concrete impact, and whether the issue requires a malicious Pack, a malicious MCP server, or an
already-authenticated local user.

**Acknowledgement target: within 72 hours.** This is a goal we aim for, **not a contractual
commitment** — this is a small project without an on-call rotation. If you do not hear back, please
follow up on the same channel.

Please do not open a public issue for an unfixed vulnerability. Credit is offered on request.

## What's in scope

- `src/web/**` — the local WebUI server: token handling, Host-header check, cross-site request
  rejection, task/session API authorization.
- `src/sync-server.js` — the self-hosted sync server: authentication, registration modes, path
  handling, data isolation between accounts.
- `src/packs.js` + `src/constraints.js` — Pack loading, the trust gate, manifest validation, and
  constraint evaluation (a bypass of the trust gate is in scope).
- `src/tools/**` — tool implementations: filesystem fence (`withinRoot`), shell execution and
  sandboxing, the fetch tool's SSRF checks, credential/env exposure to subprocesses.
- `src/permissions.js` — the permission decision engine: `allow` / `deny` / `denyStrict` matching and
  the `readonly` / `ask` / `auto` modes.
- `desktop/**` — the Electron shell: window navigation and `openExternal` handling, the contextBridge
  preload surface, IPC handlers.

Reports that affect anything else in `src/` are welcome too; the list above is where the trust
boundaries live.

## Out of scope

- **A local, already-authorized user reading their own API key.** Keys are stored in plaintext at
  `<home>/credentials.json` with mode 600 and are readable by anything running as that user. This is
  the documented design (there is no OS keychain integration); it is not a vulnerability.
- **Windows PID ownership is best-effort.** Before killing a task or a scheduler daemon, ownership of
  the pid is verified on Linux (`/proc/<pid>/cmdline`) and macOS (`ps`). Windows has neither, and the
  project deliberately does not add a PowerShell/WMI dependency, so the check reports "unknown" and the
  caller falls back to "the process is alive". A pid-reuse mis-kill on Windows is a **known design
  boundary**, documented in the security-model table of [`README.en.md`](README.en.md) — not a bug
  report we can act on.
- **Pack code running inside the host process.** `pack.mjs` is imported into the harness process with
  full Node privileges, and `manifest.permissions` is a declaration that the kernel does **not**
  enforce. Installing a Pack is equivalent to running its code; the mitigation is the explicit
  `mingdao pack trust` gate plus your own review. See the Pack trust row of the
  [`README.en.md`](README.en.md) security-model table. (This boundary is real, not acceptable — it is
  listed again under "Known boundaries" below.)
- **Upstream model providers and third-party endpoints.** Key leakage, prompt handling, abuse
  detection, availability and content issues on a model vendor's side are theirs to fix.
- **Anything that requires an attacker who already has code execution as your user**, unless it
  escalates beyond what that access already grants.

## Hardening checklist for deployers

1. **Prefer `readonly` or `ask` over `auto`.** If you rely on `deny` rules, set `denyStrict: true` —
   otherwise a `deny` hit merely prompts, and answering `y` bypasses the rule you wrote.
2. **Keep the WebUI on loopback.** If you must expose it, configure `web.token` (or
   `MINGDAO_WEB_TOKEN`) and terminate TLS in front of it. Never pass a token as a literal argument
   (`--auth-token=<token>` lands in `argv`, `ps` and shell history); use `--auth-token=-` with the
   token on stdin.
3. **Use `config.net` with an explicit `allow` list and `mode: "block"`** so unexpected kernel egress
   fails closed — and remember it does not constrain subprocesses (see Known boundaries).
4. **Do not use `config.json` as a key store.** Keep keys in the credential store or environment
   variables, keep `credentials.json` at mode 600, and keep `MINGDAO_HOME` on a path only you can read.
5. **Treat Packs as untrusted code.** Run `mingdao pack verify <dir>` (static; `--runtime` executes the
   Pack) and read `pack.mjs` before `mingdao pack trust`; never trust a freshly cloned repository you
   have not reviewed.
6. **Enable the audit trail and the ledger.** Keep `config.audit` on, review `mingdao audit`
   periodically, and run `mingdao ledger verify` on turns you care about. For unattended jobs, prefer
   `readonly` or `denyStrict` over `auto`.
7. **Sandbox shell execution where you can.** On Linux with `bubblewrap` installed, set
   `config.sandbox` to `readonly` or `safe` (no network). Elsewhere the sandbox downgrades to `off` and
   says so — compensate with OS-level isolation or a container.
8. **Run the desktop build only from a source you trust** and verify the checksum published on the
   Release page; current desktop builds are unsigned (see below).

## Known boundaries

These are **real, currently unclosed** items, registered in
[`docs/internal/AUDIT-v0.6.1-第三方报告登记.md`](docs/internal/AUDIT-v0.6.1-第三方报告登记.md) (sections
"未闭合（如实登记）" and "未纳入本批（如实登记）"). They are listed here rather than omitted so a reviewer can
price them in.

1. **The egress gate (`config.net`) does not cover child processes.** Bash subprocesses (your own
   `curl`), MCP server processes, `config.tools` / Pack-spawned subprocesses, and the Electron shell's
   update check make their own network requests that the gate never sees. It demonstrates "the kernel
   did not exfiltrate", not "this machine never egressed". Process-level enforcement requires an egress
   proxy or firewall.
2. **Packs have no isolation.** `pack.mjs` runs in the host process with full Node privileges, and
   `manifest.permissions` is not enforced by the kernel. Capability brokering or subprocess isolation
   for Packs requires an architectural change and is not implemented.
3. **Electron code signing and update-package signature verification are not done.** Current builds
   are unsigned (see [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md), which describes the steps to sign);
   the auto-updater does not verify a signature on the downloaded update package beyond the transport.
4. **IDE plugin token storage needs hardening.** The VS Code and JetBrains plugins drive the local
   WebUI over loopback; the broader item (secure token storage, and distinguishing HTTP 401 from
   "server unreachable") is registered as open work.
5. **Ledger events are tamper-evident but not signed.** The hash chain plus the `run.end` seal detect
   modification and truncation after the fact, but there is no trusted timestamp and optional signing
   (`--sign-key`) is not implemented — so the ledger is not audit-grade non-repudiation, and
   `mingdao ledger verify` says exactly that in its own output.

We do not claim this project is vulnerability-free, and this document is not a marketing statement.
