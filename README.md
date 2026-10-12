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

Saved login supports forms with both fields together and email-first flows such as Clerk: fill the email, click Continue, wait for the password, then submit. Configure the email selector for your form (for example `input[name="identifier"]` for Clerk) and a submit selector that matches both steps. Each step must remain on the app's origin. MFA, email codes, CAPTCHA and social sign-in require manual interaction.

A new origin for an environment with existing accounts requires a new environment. Stored credentials must not silently move to another website. Other environments never supply fallback credentials.

## Record and replay in another language

Record a feature once in the language you work in, then replay it with the app switched to another language. The desktop view takes ¾ of the window and an emulated phone takes ¼. Every action runs on both.

1. Press ● in the dock (or **Record actions** in a pane menu, or Ctrl+Shift+R) and use the page normally. The pane bar shows **REC** with a step count. Press ● again to stop.
2. The step editor opens. Each step has a delay: the real pause you made while recording, capped between 0.3 and 3 s. Edit any delay, set the overall speed (0.5×–2×), and enter replacement text for anything you typed (for example "Arreglar fregadero" for "Fix sink"). You can also mark a step **Skip on phone**, or remove steps.
3. Press **Replay web | mobile**, or ▶ next to a recording in the dock's Recordings list. Replay runs in two temporary copies of the account's session, so your own session and its language are not touched. Each step waits until both views have finished it. Use play/pause (Space), step back/forward, speed and **Exit replay** in the bar.

Steps are matched by `data-testid`, `data-test`, `data-cy`, stable ids, `name`, link `href` or `aria-controls`, and never by visible text, so a button found in English is still found in Spanish. Steps with no stable attribute are flagged **fragile** in the editor; adding a `data-testid` to that element in your app makes the step reliable.

**Dialogs and menus.** Inside a dialog, menu, listbox or popover, a step's position-based selector starts at that dialog (`[role="dialog"] > …`) instead of at `<body>`, where portaled dialogs land in a different order every session. React `useId` ids in every format (`:r3:`, `«r3»`, `_r_3_`) are treated as generated and never used. Pressing the backdrop to close a dialog is recorded as a **Close** step; replay presses Escape, and if the dialog stays open it taps the backdrop. Before acting, replay waits until the target is visible, on top and no longer moving, so it never presses a button while a dialog is still animating open or something else is covering it.

**What viewers see.** On the web a pointer glides to each target, and on the phone a fingertip lands on it. A ring outlines the element about to be used, every press ripples, and Enter/Escape show a key badge. These are drawn above modal dialogs too. Targets that are already on screen aren't scrolled; others scroll smoothly into view. Part of each step's recorded pause is used for the pointer's movement, so the pace stays steady. Turn this off with **Show cursor & taps** in the step editor.

**When a step fails.** The bar says which view failed, what went wrong and what to try. For example, it may point out that a Save button never appeared because the previous step changed nothing, or that a dialog is covering the target. Each failed view has three tools:
- **Show matches** outlines what the step's selectors match in that view, numbered by selector. Orange means the match is covered.
- **Inspect** opens DevTools for that view.
- **Pick the right element** lets you click the element the step should use. Your click replaces the step's selectors, is saved, and counts as doing the step in that view; the other view retries with the new selectors. On the phone, when the target is hidden behind a menu, this becomes **I'll tap it on the phone** and saves a phone-only pre-step instead.

**Details** shows:
- what was clicked while recording (tag, attributes, text, the dialog it was in, and its position),
- a timeline of what replay saw while it waited (for example "covered by div.overlay" from 0.4 s),
- every selector with its match count, visibility and what covered it.

While a view is still looking for its target, a blue line under the bar says what it sees right now. **Log** lists every step for both views with its outcome, time, the selector that matched and notes such as "already on" or "closed with Escape". Each failure also writes a report with both screenshots, recent page console errors, the wait timeline and step timings to `workspaces/<id>/replay-reports/` (the 30 most recent are kept). **Copy report** puts it on the clipboard; **Open report folder** shows it in Finder or Explorer.

Clicks on things that don't look clickable, such as a heading or empty space (usually clicked to dismiss focus), are recorded as **optional**. Replay clicks the same spot, or skips the step if the element can't be found.

If Hostframe is rebuilt while it is running, a red banner says so. Quit and start it again, because the running app still uses the old code.

**Phone menus.** If a target exists on the phone but is hidden, for example a nav link collapsed behind ☰, replay taps the control that reveals it before continuing. It looks for `aria-controls`, then `aria-expanded` inside the header or nav, then common hamburger class and label patterns. If none is found, replay pauses on that step. Press **I'll tap it on the phone**, then tap the menu button yourself in the phone view. That tap is saved as a phone-only step and replay continues; later replays tap it automatically.

**Language.** Replay always sends `Accept-Language` and overrides the browser locale (`navigator.language`, `Intl`). If your app reads the language from somewhere else, set it under **Environment settings → Replay language**: a cookie name (for example `NEXT_LOCALE`), a localStorage key (for example `i18nextLng`), or a language prefix as the first URL segment (`/en/jobs` → `/es/jobs`). If the language is saved on the user's profile on your server, replay with an account whose profile is set to that language.

Replay really performs each action in both views, so a recorded **Save** saves twice. Use QA or Local data. Login pages and password fields are never recorded; signing in becomes a **Sign in** step that uses the vault. Recordings are stored per workspace in `workspaces/<id>/recordings/` and are available to agents through `recording_*` and `replay_*` tools.

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
- Screenshots require a visible rendered pane. Login-page capture is blocked; forms/inputs are masked elsewhere. Sensitive text outside forms can still appear. Full-page captures, composited workspace images, annotation, video export of replays and export management are not implemented yet.
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

The smoke check uses a separate profile under `artifacts`, exercises actual Chromium sessions and Windows encryption, and briefly displays a window for capture. It checks independent identities, cross-user state, temporary-cookie isolation, copy-owned credential overrides, cleanup, screenshots and navigation restrictions. It also records a flow in the English demo, replays it in Spanish on web and on a 393 px phone (opening the collapsed menu automatically), checks the per-language typed text, and saves `artifacts/replay-web.png` and `artifacts/replay-mobile.png`. The same flow opens a portaled, animated dialog, picks an option, saves it, then reopens the dialog and closes it from the backdrop. The smoke test checks that those steps are anchored to the dialog and replay on both views, and saves a mid-dialog frame as `artifacts/replay-dialog-*.png`. A deliberately broken step checks the failure explanation, the saved report and **Copy report**, which replaces your clipboard contents. Local auth-provider fixtures also verify a blocked redirect, an explicitly allowed handshake round trip, rejection of other hosts, and refusal to fill saved credentials on the provider origin.

`npm test` rebuilds the adapter and checks both modern and legacy stdio connections against a private test broker, including the negotiated protocol, absence of a modern initialization handshake, catalog cache hints, argument validation/defaults, PNG content, and error redaction. It does not access the user's desktop or credentials.

The separate `scripts/check-agent.mjs` check requires a running desktop with the included demo. It pins protocol `2026-07-28` and checks modern stdio discovery, tool listing, metadata-only credentials, login, DOM snapshot and PNG image content. Results are saved in `artifacts/smoke-result.json` and `artifacts/agent-check.json`.

## Design references

- [Published plan and mockup](https://pages.subir.dev/a1a82046-4c59-445d-b657-25f7b3386ab1/)
- [Full research and longer-term plan](PLAN.md)

The public mockup is a design proposal, not a claim that all planned features are implemented. Claude Code reported no active login, so the implementation was authored directly without changing authentication, proxy or billing settings.
