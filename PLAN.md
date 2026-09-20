# User browser: research and implementation plan

Implementation update: the first Windows Electron build is now available. See [README.md](README.md) for implemented behavior, launch instructions, agent setup and explicit remaining work. The research below remains the longer-term design; it is not a claim that every planned feature has shipped.

Research date: 2026-09-19. Revision 2 incorporates the user?s environment, login, duplication and agent requirements. Proposal only; no desktop browser has been implemented. The published HTML is an illustrative mockup using fictional data.

## Recommendation

Build a Windows-first Electron + TypeScript desktop application using Chromium WebContentsView instances inside one window. Use React for the trusted application shell if desired. Store one persistent Electron session partition per project, environment, and account. Use a recursive split tree for the window layout. Provide a single typed local command service consumed by the UI, CLI, and MCP adapter.

The important distinction: a pane displays a page; an account profile owns its session. Owner, Driver, and Intaker can open the same origin with independent cookies, local storage, IndexedDB and service-worker state. Two panes intentionally assigned the same profile share that profile's cookies and origin storage; sessionStorage remains page-scoped. Profiles do not create backend roles: the SaaS must already authorize the corresponding test accounts.

Example identity: project=dispatch, environment=local, account=driver-alex, partition=persist:dispatch-local-driver-alex. Use opaque stable IDs in implementation; role is a mutable label, not a unique account key. Partition names are identifiers, not secrets. Keep Local, QA, and Production credentials and sessions separate. Changing a pane's account creates/rebinds a view with the appropriate session before loading its URL; changing a label or adding a role header is insufficient.

## Options and tradeoffs

| Approach | Fit | Important tradeoff |
|---|---|---|
| Electron + WebContentsView | Recommended: Chromium, custom native split views, persistent session partitions, TypeScript, screenshots and DevTools APIs | Own security updates, window lifecycle, popups and automation adapter; larger distribution and memory footprint |
| Windows WebView2 + profiles | Strong Windows-only alternative: Chromium-based Edge runtime; multiple profiles in one user-data folder | Native host integration and automation plumbing; not the Chrome product; less portable |
| Zen + Firefox containers | Closest interaction reference and a possible manual workflow using container support | Firefox engine, not Chromium; unified role-aware agent control still needs engineering |
| Playwright browser contexts | Good immediate automated-test foundation: clean, isolated sessions per actor | Does not itself provide the requested native tiled browsing workspace; Electron integration is experimental |
| Chrome extension | Useful controls or capture companion | Ordinary tabs in a profile share cookies/storage. Cookie partitionKey refers to partitioned cookies, not arbitrary independent full profiles per pane. Iframes add framing restrictions and do not solve identity isolation |
| Chromium fork / CEF | Maximum embedding control | Substantially more browser/runtime engineering; unnecessary for first release |

Recommendation is an engineering judgment, not a benchmark. Electron uses Chromium but is not shipping Google Chrome: repeat release-critical checks in Chrome for Testing / real Chrome. Confirm actual embedded-login compatibility, extensions, passkeys, device APIs, and Chromium version before claiming parity.

## Confirmed requirements

- **Users** are the primary UI concept. Each user has a display name and optional role label; no role is required. Several users may have the same role. A User here is a saved browser identity configuration, not necessarily a newly created backend account.
- Email and password are the main testing login method. Each user has separate credential entries for Local, QA, and Production, with more than one account entry allowed within an environment.
- Each project defines environments with a base URL and optional login URL/path. Environment configuration can add named deployment targets later; a new identity/security boundary gets a separate environment ID rather than silently reusing an old session.
- Support at least seven users and seven simultaneously visible panes in the first workspace MVP. Do not hard-code a four-user or four-pane ceiling. Saved grids, nested splits, focus mode and scroll/zoom affordances must keep larger workspaces usable.
- Agents operate the website through MCP/CLI, including screenshots returned as images for vision-capable clients. Source-code editing is outside this browser?s tool interface.
- A temporary copy inherits configuration and credential access, but gets an isolated browser session. Deleting the copy cleans up its own local data without deleting its source user or backend account.

## Product model

Project ? Environment (Local / QA / Production) ? User?s account entry ? Browser session ? Pane.

A User groups related testing identities across environments. A pane is permanently bound to one session instance until explicitly rebound; role labels never determine session ownership.

| Entity | Fields / behavior |
|---|---|
| Project | ID, label, environments, users, login recipes |
| Environment | Stable ID, label, base URL, optional login URL/path, allowed origins |
| User | Stable ID, display name, optional role label, environment account entries |
| Account entry | Stable ID, user ID, environment ID, label (e.g. Alex / Taylor), email, encrypted password reference, optional role override, login recipe |
| Session instance | Stable ID, account entry ID, persistent partition or disposable in-memory partition, optional source instance ID, lifecycle state |
| Pane | Stable ID, session ID, URL, viewport, owning webContents ID |
| Workspace | Saved split tree, selected environment, pane bindings; can opt into explicit per-pane environment comparison |
| Run | Scenario steps, explicit pane/user/environment targets, assertions, evidence and per-pane action leases |

Example: User ?Delivery tester?, role ?Driver?, has Local account ?Alex?, QA accounts ?Alex? and ?Taylor?, and Production account ?Test driver?. Each account entry has its own email/password and session. Optional role labels describe the saved setup; the app?s real authenticated identity/permissions must be verified after login. A different role in an environment can be shown using the account entry override.

Session identity is projectId + environmentId + userId + accountEntryId + sessionInstanceId. Use opaque stable IDs in storage, not email strings. Two ordinary panes can share one session instance; a temporary copy gets a new sessionInstanceId. Persistent partitions use `persist:`. Temporary partitions omit it.

The environment switch rebinds panes to that environment?s account entries and sessions, then navigates to the configured base URL plus the pane?s relative route. A user with no credentials for the target environment shows ?Not configured?; never reuse another environment?s credentials or fall back to another account. Existing sessions remain available when switching back. Show the environment, user, account label and optional role on every pane. Environment switch cancels pending actions, changes binding generation, and invalidates old element references. Multiple account entries use an explicit saved selection rather than silently choosing the first.

All-seven overview, four-way, two-column and focus-plus-stack presets are starting points, not user limits. Support keyboard split/close/focus controls, draggable dividers and minimum sizes. Closing a normal pane retains its profile. Reset clears only the selected session. Suspend hidden views where appropriate, but explicitly resume/render before screenshot or interaction. Release child webContents when views/windows close and measure CPU/memory with seven active panes plus temporary copies.

Native WebContentsView surfaces are not ordinary DOM elements. The main process owns their bounds, clipping, visibility, and focus. Shell drawers and menus must reserve space or explicitly hide/reposition overlapping views; a high CSS z-index alone is not the overlay solution. Resize through a validated IPC boundary. Keep the shell session separate from all SaaS sessions.

## Credentials and email/password login

1. The desktop User editor has Local, QA and Production tabs. Each tab displays its environment URL and one or more account entries: label, email, password and login recipe. Add another account for a second identity with the same role. A missing entry is clearly marked ?Not configured?. The public mockup uses fictional, read-only credentials and never collects passwords.
2. Store passwords encrypted in a local vault using Windows-backed Electron safeStorage initially. Keep ciphertext separate from workspace exports. Agents use credential references, not a password-reading endpoint. DPAPI protects against other Windows users, not every process running as the same user.
3. Login fills the configured email/password fields, submits, waits for completion, then verifies the real account and any expected role. Reuse existing sessions when valid; expired sessions can reauthenticate. Persistent storage survives restarts subject to server policy; sessionStorage and all session cookies are not guaranteed to survive.
4. Agents may create/edit user/account metadata and **create or overwrite stored email/password credentials** through a write-only tool. Support protected local input/handles and agent-supplied values; see the contract below for their different exposure properties. Resolve credentials only for the explicitly targeted account and approved login origin.
5. Email/password is the MVP priority. Login routes and field selectors remain app-specific. MFA/CAPTCHA return needs_user; OAuth/passkeys are later extensions unless the real application requires them.

## Write-only credentials for agent-created accounts

This is a confirmed requirement for Local, QA and Production, including agent-created dummy accounts. Separate permissions for writing credentials and using credentials to sign in; neither implies reading or exporting them. Permissions are scoped to project, environment and account entry, not inferred from a role label. Production credentials stay in the Production scope.

### Tool contract

- `credentials_put`: create a credential entry or replace its entire email/password pair. Require userId, environmentId, accountEntryId and mode=create or replace. Replacement requires the current metadata revision to avoid accidental concurrent overwrites. Accept a one-time protected input handle or an agent-supplied pair. Write atomically; failed validation leaves the prior entry intact. Never return old or new values, even on error.
- `credentials_generate`: optionally let the local broker generate and store a password and return only an opaque credential reference. Use an approved app-specific registration recipe to insert it into signup and confirmation fields without sending the password through the agent. The same reference supports subsequent login.
- `credentials_status`: return only opaque IDs, configured state, revision, update time and verification state. Do not return email, password, masked fragments, lengths, hashes, request echoes or reveal links. Treat the entire stored pair as private; the app itself may independently display the signed-in email.
- `auth_register` / `auth_login`: use the reference internally for a configured signup/login recipe and approved origin. Return outcome and account-entry ID, never the secret or session tokens. Agent-created registrations can also use the agent's existing tools and then call credentials_put.
- No `credentials_get`, `reveal`, `export` or arbitrary destination/selector fill tool. The credential reference is an identifier, not sufficient authorization by itself.

Example result: `{ "credentialRef": "cred_opaque_123", "configured": true, "revision": 4, "verification": "unverified" }`. Error results use fixed codes such as revision_conflict, invalid_target or storage_failed. Audit events record who changed which entry and when, never supplied values.

### Create, store, reuse

1. Agent creates a test account using either supplied credentials or broker-generated credentials and an approved registration recipe.
2. Store the pair in the selected User / environment / account entry. If credentials were generated first, retain pending/unverified status until registration succeeds; a failed signup is not a verified account. The tool does not claim a remote account exists merely because vault storage succeeded.
3. Browser signs in using the reference and checks the resulting identity. Other agents can use the saved reference within their authorized scope without receiving the credentials.
4. Agent may overwrite the pair later. A vault overwrite does not change the SaaS password: complete any intended server-side password change separately. Mark changed credentials unverified, increment the revision and clear the old verified-identity status. Cancel old in-flight credential fills, but existing authenticated browser sessions may remain active until explicitly logged out/reset. Test the new values in a fresh session rather than treating an existing login as proof.
5. A temporary copy can reference source credentials, but a credentials_put targeting that copy creates a copy-owned override. It must not overwrite the source entry implicitly.

### What write-only can and cannot guarantee

An agent that creates or supplies a password already knows it. A raw pair in MCP tool arguments may be retained in the external agent's conversation or provider logs; browser-side redaction cannot erase that history. Offer protected local handles and broker-generated-password registration for flows that must avoid putting passwords in model context. This does not require preventing agents from submitting their own generated test credentials.

Write-only must cover indirect read paths, not just remove a getter. The broker performs sensitive signup/login filling and submission as a protected operation, blocking concurrent screenshots, DOM snapshots, clipboard access and inspection of populated secret fields. Exclude the vault UI from agent capture. Suppress credential-bearing console messages, request/response bodies, URL parameters, authorization headers, cookies and storage exports; raw CDP, arbitrary evaluation, process/filesystem access and unrestricted network inspection must not bypass this boundary. Do not expose full debug traces as ordinary agent tools. Normal website screenshots and bounded inspection remain available outside the protected operation; inspect/redact sensitive account content according to the app-specific recipe.

Validate login destinations, redirects and frame origins. Never send stored credentials to an agent-chosen arbitrary URL. A hostile website receiving the credentials can still reveal them; no browser can guarantee secrecy from a compromised application that must receive the login. This boundary also does not stop an external coding agent with independently granted unrestricted OS access from accessing same-user resources. Windows DPAPI is not isolation from all same-user processes. Stronger separation would require a separate credential service identity and restricted OS/browser capabilities.

Implementation acceptance checks: create and overwrite credentials for each environment; verify reference-only responses and fixed-code errors; reject stale revisions; verify no read/export tool exists; attempt extraction through snapshots, images, DOM, console/network, clipboard and debugging paths during login; ensure copy-on-write preserves source credentials; confirm existing authenticated sessions cannot falsely verify replaced credentials. These are future implementation checks, not claims about this HTML mockup.

## Temporary copies and cleanup

Offer two clearly named actions:

- **Open another pane:** same session instance and login, useful for two routes side by side.
- **Create temporary copy:** separate in-memory session, same selected environment/account configuration and credential reference by default, with a visible temporary badge. Start with empty browser storage and log in using the inherited credentials. This is not a cookie/session-token clone. The user may select another saved account entry (e.g. QA Taylor) or provide temporary credentials in the desktop vault editor.

The copy can expose the source user?s configured environment/account choices using references, while each environment/account used by the copy gets a distinct temporary session. No password ciphertext needs to be duplicated. Credential edits are copy-on-write: temporary overrides belong to the copy and cannot change the source. Same credentials still mean the same server account, even in separate browser sessions. Server policies may disallow concurrent sessions; an independent server identity requires a different account entry. Copying does not create a new SaaS user.

**Delete temporary copy** revokes agent leases, stops tasks/downloads, closes every pane using its sessions, clears each temporary session?s storage/cache/auth state, releases views and references, removes copy-owned secrets and local metadata, and deletes app-managed temporary artifacts owned by that copy. A run manifest records ownership so cleanup never guesses file paths. Shared source credentials and original persistent profiles remain intact. Explicitly exported screenshots/files outside the temporary area remain user-owned and are called out in the delete result. Backend records, server sessions and unrelated user files are not deleted as a side effect.

Prefer in-memory partitions so browser state has no persistent profile directory. Treat cleanup as resource release, not a promise of forensic erasure or instant process-memory shrinkage. ClearStorageData/cache APIs alone are not a complete disk-profile lifecycle solution. If future features require disk-backed temporary profiles, use dedicated app-owned directories, release locks before deletion, verify canonical containment, and retry only tracked tombstones after restart. A crash-startup janitor cleans app-managed temporary artifacts and copy-owned secrets; do not persist temporary identities in saved layouts by default.

## Agent interface

Build one command schema and adapter, rather than separate browser behavior for each client. Local CLI talks to the running desktop broker over a Windows named pipe with an appropriate user ACL and a capability handshake. An MCP stdio process wraps the same broker; no exposed remote-debugging port is necessary for the default design. If adding HTTP later, bind to loopback, authenticate, and validate Origin as the MCP transport spec requires.

Proposed commands (not installed today):

```text
roles users create --id alex --label Alex --role driver
roles accounts add --user alex --env qa --id alex-qa --secret-ref vault:alex-qa
roles panes open --user alex --env qa --account alex-qa --path /jobs
roles users copy --user alex --env qa --account alex-qa --temporary
roles capture --pane pane-7 --format png
roles temporary delete --id copy-1
roles mcp serve
```

Proposed MCP tools: users_list/create, accounts_list/add, environments_list/configure, credentials_put/generate/status, temporary_copy/delete, panes_list/open/navigate, auth_register/login, page_snapshot, page_click, page_fill, page_wait, page_assert, capture, console_read, network_read, scenario_run/cancel. Console/network tools return bounded sanitized diagnostics, not raw credential-bearing payloads. Every action resolves a stable paneId and validates its profile, environment, and allowed origin. Return typed outcomes (success, needs_user, timeout, target_closed, identity_mismatch), artifacts, and current URL. Use timeouts/cancellation and serialize mutations per pane; manual takeover revokes the agent's action lease. Snapshot-scoped element references prevent stale target reuse.

Browser operation is the requested agent scope. External agents connect through MCP/CLI to navigate, log in, interact, inspect and capture screenshots. No repository-editing or shell tool is exposed by this browser. Any source work remains independently managed by the external coding tool.

Use Electron's per-webContents debugger/CDP API for inspection and interaction where appropriate, and native webContents APIs for navigation and capture. Validate accessibility/DOM snapshots, event/input semantics, OOPIF targets, popups, and stable target routing in the spike. Avoid exposing unrestricted JavaScript evaluation as the default MCP action. Playwright integration is a candidate, not a proven replacement: its Electron support is experimental and discovery/control of every embedded view must be verified. Opening DevTools can detach Electron's debugger session; phase one explicitly pauses automation for that pane, shows why, and reattaches when DevTools closes. Seamless simultaneous use requires further validation.

## Vision tools for agents

`capture(paneId)` returns a PNG image content block to a vision-capable MCP client, plus user/account/environment, URL, capture ID, timestamp, viewport dimensions and scale. A filesystem path alone is insufficient for a client that needs to see the image. Offer selected-pane, all-open-pane batch, and whole-workspace composite captures; distinguish hidden panes from visible ones and report skipped/failed captures. Batch output should allow individual image retrieval to avoid flooding client context.

Support structured DOM/accessibility snapshots alongside images. For coordinate-based click tools, specify CSS pixels relative to the captured viewport, account for device scale, and reject stale capture IDs after navigation/resize/rebinding. Screenshots never prove an action completed; agents also wait for observable results. A vision-capable external model interprets the image; the browser does not need a bundled AI model. Password fields and vault UI are excluded/masked from capture, with explicit handling for other sensitive app content.

## Developer tools inspired by the request

- Local/QA/Production badge and persistent user/account/optional-role strip on every pane.
- Per-pane inspector, console errors, request failures, reload and cache controls.
- Screenshot of one viewport or all panes with role, route, viewport, timestamp and run ID in a manifest. Electron capturePage captures the visible page by default; full-page capture is separate CDP/scrolling work.
- Redacted evidence export, annotation, and before/after comparison after the core loop works. User review is required before sharing sensitive captured content; automated redaction is not complete protection.
- Layout presets, focus mode, responsive viewport presets and an explicit linked-navigation toggle. Keep clicks and form submits independent by default.
- A test scenario panel with actual assertions and coverage status, so a green visible screen is never mistaken for complete test coverage.

Zen's official split-view documentation verifies side-by-side, directional rearrangement, and horizontal/vertical/grid presets. Arc's help center returned HTTP 403 during research. Arc-like developer capture conveniences here are proposed from the user's inspiration, not a verified inventory of current Arc Windows capabilities.

## Delivery phases and gates

1. **Feasibility spike:** one native window, Owner/Driver/Intaker views on the same origin, independent accounts. Restart, logout/reset only one profile, inspect storage boundaries, test the actual email/password login and any required MFA, target each view from the agent adapter, open DevTools during automation, and capture each viewport. Stop and reconsider host/runtime if authentication or embedded-view automation cannot work. This is future implementation validation, not a claim that the HTML mockup has been tested.
2. **Manual workspace MVP:** seven or more users and visible panes, Local/QA/Production account entries and URL switching, temporary copies with cleanup, persisted profiles, secure login recipes, recursive splits, resize/focus/reorder, layout persistence, per-pane navigation and DevTools, screenshots. Gate: a person completes the intake-to-delivery flow without repeated account switching.
3. **Agent MVP:** typed broker + CLI + MCP, stable pane IDs, snapshots/actions/waits/assertions, leases, cancellation, redacted evidence and identity checks. Gate: a coding agent repeats the same scenario and reports where a failure occurred.
4. **Regression workflows:** role × route × action × environment matrix, reusable scenarios, direct unauthorized API/route tests, Chrome CI runs, evidence diffs, versioned configuration and updater. Gate: permissions are enforced by the server and state transitions remain consistent across roles.

First vertical slice: Intaker creates a uniquely named job; Owner sees and assigns it; Driver sees only their assignment and accepts it; Owner sees the new status. Also assert Driver cannot invoke Owner operations via direct requests. Synchronize on backend-visible states, not fixed sleeps. Reuse a run-scoped entity ID and reset only the run's own test data. Multiple sessions isolate browser state, not the shared backend/database.

No delivery-duration estimate yet: the SaaS auth provider, framework, identity configuration and supported environments are unknown. Scope stays Windows-first, local/staging, 3–4 roles and one end-to-end workflow until the feasibility gates pass.

## Settled decisions and remaining application details

Settled: Users with optional role labels; email/password per environment and account entry; Local, QA and Production URLs; seven-plus users/panes; same-session extra panes and isolated temporary copies; agents operate the website and receive screenshots. Do not re-ask these decisions.

Implementation will need the actual environment base/login URLs and the email/password form structure. The exact split layout can be refined from the user's diagram. These details do not block the mockup.

The earlier ?does every screen looking right mean the app passed?? question was not a requirement decision. It meant that visual inspection and screenshots should be paired with checking outcomes: Driver accepts ? Owner sees Accepted. No extra answer from the user is needed.

## Primary references

- https://www.electronjs.org/docs/latest/api/web-contents-view
- https://www.electronjs.org/docs/latest/api/session
- https://www.electronjs.org/docs/latest/api/web-contents
- https://www.electronjs.org/docs/latest/api/debugger
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://www.electronjs.org/docs/latest/tutorial/security
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support
- https://playwright.dev/docs/browser-contexts
- https://playwright.dev/docs/api/class-electron
- https://docs.zen-browser.app/user-manual/split-view
- https://developer.chrome.com/docs/extensions/reference/api/cookies
- https://developer.chrome.com/blog/remote-debugging-port
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

## Design tooling limitation

Claude Code 2.1.274 reports loggedIn=false, authMethod=none, apiProvider=firstParty. Current official model overview and model configuration docs were consulted; no Claude model was verified or used because existing CLI authentication was unavailable. No credentials, proxy configuration, or billing arrangement were changed. The primary assistant authored the fallback mockup. Mockup behavior was left for the user to evaluate as requested.
