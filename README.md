# Host Frame

A runnable Windows Chromium workspace for testing multiple users in one window.

## Run

Open `release/win-unpacked/Hostframe.exe`. Keep the entire `win-unpacked` directory together; this is an unsigned unpacked build.

For development, run `npm install` and `npm start` (Node 22+). The launcher clears `ELECTRON_RUN_AS_NODE` only for its own child process.

The first launch starts empty and walks you through your app's URL and login form, your first user and its sign-in. Launch with `--demo` (`npm start -- --demo`) to seed seven users and a local Dispatch demo instead; there, Jordan can assign the job and Alex can accept it.

A workspace holds one app: its environments, users, credentials and browser sessions. Switch, create, rename or delete workspaces from the drawer header or the gear menu; deleting one wipes all of its data in one step. Data lives under `workspaces/<id>/` in the app data folder. Agents can do the same through `workspace_list`, `workspace_create`, `workspace_switch`, `workspace_rename` and `workspace_delete` (which requires the exact workspace name as `confirmName`), then set the workspace up with `environment_save`, `user_create`, `account_create` and `credentials_put`. Toggle the dock with Ctrl+. and the drawer with Ctrl+Shift+S. Drag the dock's grip to any window edge. Users and accounts can be removed from the drawer or the user's Manage dialog.

## Connect your SaaS

1. Select QA or Production, then open **Environment settings**. Enter its base URL, login path and CSS selectors for the email, password and submit controls. Use **Add another environment** for your actual Local dev server; the included Local demo stays separate.
2. Configure an optional success marker. An optional identity text selector must exactly match the account label. Without a success marker, login reports submission only, not authenticated identity.
3. Add Users with optional role labels. Add one or more account entries per user/environment and set their email/password credentials.
4. Open accounts through the sidebar. Drag split dividers, use arrow keys on focused dividers, or use pane menus for splits, temporary copies, DevTools and screenshots.

Hosted auth providers (Clerk, Auth0, etc.) often redirect the login page through their own domain. Hostframe blocks cross-origin navigation by default; when that happens the pane bar shows **blocked · allow &lt;host&gt;**, and one click adds that origin to the environment's *Extra allowed origins* and reloads. Credentials are still only filled on the environment's own origin. Errors are written to `hostframe.log` in the app data folder.

A new origin for an environment with existing accounts requires a new environment. Stored credentials must not silently move to another website. Other environments never supply fallback credentials.

## Implemented

- Electron 44 Chromium WebContentsView panes, sandboxed with Node disabled and context isolation enabled.
- Seven initial users, optional roles, multiple accounts and configurable environment URLs.
- Persistent per-account sessions, shared extra panes, nested split layouts and focus mode.
- Saved accounts/panes and restored split layout after normal restart.
- Disposable in-memory copies with fresh cookies and inherited credential references. Overrides belong only to the copy. Deleting the copy closes all its panes and clears its storage, cache, authentication state and overrides.
- Windows-backed encrypted vault; atomic credential create/overwrite, revision conflict checks and metadata-only status. No read/reveal/export API.
- Protected email/password login recipes. Shared-session inspection is locked during login, views are hidden while credentials are filled, and fields are cleared afterward.
- Local named-pipe broker, CLI and MCP stdio adapter. Desktop toggle to pause agent access.
- Bounded navigate/click/fill/wait/snapshot tools and PNG screenshots returned as MCP image content.
- Per-pane DevTools; agent actions pause for the shared session while an inspector is open.

## Connect an agent

The desktop must be running. MCP configuration:

The adapter uses MCP TypeScript SDK v2 and supports protocol `2026-07-28` through the modern `serveStdio` entry point. Modern clients use self-contained requests without the old initialization handshake. Older clients can still connect through the SDK's legacy compatibility path; they do not receive the new protocol behavior. Clients using SDK v2 must explicitly enable `versionNegotiation` (`auto`, or pin `2026-07-28`). Restart an agent's MCP connection after updating the adapter.

The tool catalog has deterministic ordering and a five-minute private cache hint. This caches tool definitions only, never account state, credentials, or tool execution results. Local stdio and the Windows named-pipe broker remain the transport architecture.

```json
{
  "mcpServers": {
    "hostframe": {
      "command": "node",
      "args": ["D:/Code/Project/web-roles/dist/mcp.cjs"]
    }
  }
}
```

CLI:

```powershell
npm run cli -- state_get
node dist/cli.cjs --help
node dist/cli.cjs credentials_put --stdin
```

For credential writes, provide JSON through stdin instead of command-line arguments. The schema in `src/contracts.ts` requires `accountId`, `email`, `password` and `expectedRevision` (0 for a new entry). A temporary override also includes `temporaryId`. `credentials_status` returns configuration/revision metadata, never email, password or masked fragments.

Overwriting a vault entry does not change the website password or invalidate existing logged-in sessions. `credentials_generate` creates and stores a password without returning it; it does not register a website account. Agents that create test accounts through their existing application tools can store the resulting pair with `credentials_put` and use `auth_login` afterward.

## Current limits

This is a development preview, not a hardened general-purpose browser or audited credential manager. Evaluate it with test accounts.

- A password supplied by an agent is already known to that agent and may be retained in its transcript. Write-only storage cannot erase that history. The browser does not expose arbitrary JavaScript, cookie export, raw CDP, raw network logs or filesystem tools.
- Windows DPAPI and the broker token do not isolate secrets from an independently privileged same-user process. The local pipe requires a random token stored under your user profile. Connect only trusted agents; current enable/pause is workspace-wide. Per-client account/environment grants remain future work.
- Cross-origin top-level navigation requires an exact origin in the environment's Extra allowed origins. This supports hosted authentication redirects such as Clerk handshakes; popups, downloads and permission requests remain denied. OAuth, MFA and CAPTCHA automation are not implemented. Saved credentials are filled only on the environment's base origin. A compromised website receiving credentials can still expose them.
- Screenshots require a visible rendered pane. Login-page capture is blocked; forms/inputs are masked elsewhere. Sensitive text outside forms can still appear. Full-page captures, composited workspace images, annotation, recordings and export management are not implemented yet.
- Registration recipes for browser-generated credentials, scenario runners, request/console diagnostics and stronger capability scoping remain follow-up work. No source-editing tools are included.
- Temporary copies isolate browser storage, not backend accounts or databases. Same credentials still mean the same SaaS account. Copies are not restored after restart. In-memory cleanup is not a promise of forensic erasure or immediate process-memory shrinkage.
- The demo server resets on restart, so demo users need to log in again. Demo credentials are public dummy values. Real SaaS sessions obey their own persistence and expiration policies. Unreadable real vault entries require replacement; no automatic credential recovery is promised.
- The packaged build is unsigned and has no updater. Electron uses Chromium but is not the Chrome product; repeat release-critical checks in real Chrome.

## Storage

Hostframe retains the original Roleframe storage directory, broker pipe name, and application ID for compatibility with existing accounts, sessions, and agent connections. The executable and displayed product name are now `Hostframe`.

Workspace metadata, encrypted vault and browser profiles: `%APPDATA%/Roleframe/desktop`.

Agent discovery/token: `%APPDATA%/Roleframe/agent-connection.json`. Treat this token as private. No runtime credentials or data are published to Subir.

## Build and checks

```powershell
npm run typecheck
npm test
npm run smoke
node scripts/check-agent.mjs
npm run package
```

The smoke check uses a separate profile under `artifacts`, exercises actual Chromium sessions and Windows encryption, and briefly displays a window for capture. It checks independent identities, cross-user state, temporary-cookie isolation, copy-owned credential overrides, cleanup, screenshots and navigation restrictions. Local auth-provider fixtures also verify a blocked redirect, an explicitly allowed handshake round trip, rejection of other hosts, and refusal to fill saved credentials on the provider origin.

`npm test` rebuilds the adapter and checks both modern and legacy stdio connections against a private test broker, including the negotiated protocol, absence of a modern initialization handshake, catalog cache hints, argument validation/defaults, PNG content, and error redaction. It does not access the user's desktop or credentials.

The separate `scripts/check-agent.mjs` check requires a running desktop with the included demo. It pins protocol `2026-07-28` and checks modern stdio discovery, tool listing, metadata-only credentials, login, DOM snapshot and PNG image content. Results are saved in `artifacts/smoke-result.json` and `artifacts/agent-check.json`.

## Design references

- [Published plan and mockup](https://pages.subir.dev/a1a82046-4c59-445d-b657-25f7b3386ab1/)
- [Full research and longer-term plan](PLAN.md)

The public mockup is a design proposal, not a claim that all planned features are implemented. Claude Code reported no active login, so the implementation was authored directly without changing authentication, proxy or billing settings.
