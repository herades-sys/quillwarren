# Delve for Windows (the desktop app)

Delve also runs as a Windows desktop app: one window with the editor, the maps on the user's own computer, no login, no server to set up. It is the same code as the web app at delve.example.com. The server runs in **desktop mode**, which is switched on only by the desktop app's own entry point. The web server (`main.ts`, `npm run build`, the release on the dev container) is unchanged: `fixtures/web-baseline.json` pins its routes, pages and answers as they were before the desktop work, and `apps/server/test/web-baseline.test.ts` checks them.

The app is **one person's map editor**. The multiplayer and player-facing parts of the web app (Delve Table, the players' screen, Discord login, accounts and admin) are left out; see "What the Windows app leaves out".

Status (phase 1, 2026-10-07): the app, desktop mode, the local-model chat and the runtime manager are built and tested on the dev container. The built app itself is tested by the user on Windows (see `D:\Claude\delve-windows\TESTING.md` on the main PC). The built-in model runtime has no binary yet. Multiplayer and the players' screen were taken out of the app on 2026-10-31. The same day the app got two ways to use the person's own AI account: the Claude Desktop extension (see "Claude Desktop") and chat backends on their own Anthropic or OpenAI API key (see "Chat backends"); both are tested on the dev container against fakes, not yet with Claude Desktop or the real APIs.

## Architecture

```
Delve.exe (Electron 44, apps/desktop)                       %APPDATA%\Delve\
  main process: src/main.ts                                    data\   maps (delve.db), pictures, props,
   - one instance, the menu, the window's place                       chat-settings.json, chat-keys.json, runtime.json
   - a random secret per launch                                logs\   main.log, server.log, llama-server.log
   - starts the server, stops it on quit                       window-state.json, desktop.json (the last port)
   - seals API keys with safeStorage for the server            claude-desktop.json (while Claude Desktop is connected)
   - Connect to Claude Desktop… opens resources\Delve.mcpb
        │ spawn + IPC ({type:"ready",port} / {type:"shutdown"})
        ▼                                                    %LOCALAPPDATA%\Delve\models\   GGUF files
resources\node\node.exe (Node 24.21.0, nodejs.org)
  resources\server\desktop-main.mjs (apps/server/src/desktop/main.ts, bundled)
   - Fastify on 127.0.0.1:<port>, desktop gate in front of every request
   - the editor side of the web app: library, editor, 3D, handout, trace, PNG export (resvg);
     no Delve Table, players' screen, Discord or accounts (buildApp's multiplayer: false)
   - chat: none, a local model (chat/local-chat.ts), or Claude / OpenAI on the
     person's own API key (chat/api-chat.ts), never the Claude bridge
   - /mcp for Claude Desktop's bridge only, with its own key, while connected
   - /models: model files, Ollama import, the built-in runtime (desktop/runtime.ts)
        │ spawn (the model page, or the chat on first use)
        ▼
resources\llama\llama-server.exe (llama.cpp b11476, MIT; build.sh step 4b)
```

- **`apps/desktop`** is outside the root npm workspaces, with its own `package.json` and `package-lock.json`. The root `npm ci` / `npm install` (the server release on the dev container) never sees Electron. Its dependencies are all dev dependencies: the main process is bundled by esbuild into `dist/main.cjs`, so nothing from `node_modules` ships in `app.asar`.
- **The window** loads `http://127.0.0.1:<port>/` (the library). It runs with `contextIsolation`, `sandbox` and no Node integration, and has no preload script. Links to other sites open in the default browser; nothing navigates the window away from Delve. Delve's own pages that open a new window (the snip's handout) get a window with the same rules. Permissions are denied except writing to the clipboard; pages can't ask for full screen (only the players' screen did), and F11 still makes the window full screen.
- **The port**: the server takes the port it had last time (`desktop.json`) and falls back to any free one. A stable port keeps the window's origin the same, and with it what the editor keeps in the browser storage (theme, chat history, panel states).
- **Shutdown**: on quit the app sends `{type: "shutdown"}`. The server stops llama-server, closes the database and exits. After 6 s the app kills it. If the app dies, the IPC channel closes and the server stops on its own. A llama-server left over from a killed launch is ended at the next start (pid file, checked against the process name).
- **Crashes**: if the server stops unexpectedly, the app restarts it (twice in two minutes), then offers "Try again", "Copy logs" and "Quit".
- **Electron fuses** (set in `Delve.exe`): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect` from outside, the app only from `app.asar`, cookies encrypted. Asar integrity validation stays off until it has been tried on Windows.

### Why a separate Node

The server runs on its own `node.exe` (Node 24.21.0 from nodejs.org, checked against `SHASUMS256.txt`), not inside Electron:

- **The tested runtime.** The server and its 1300 tests run on Node 24.21.0 on the dev container. `node.exe` is exactly that build. Electron builds Node with its own options: BoringSSL instead of OpenSSL, and features switched off or flagged differently (earlier Electron versions shipped without `node:sqlite`). Electron 44.6.0 does embed Node v24.21.0, and its binary contains `node:sqlite`'s JavaScript, but whether its build enables the SQLite binding and type stripping was not verified: the Windows binary can't be run on the dev container. The server uses `node:sqlite` for every map. With its own runtime it doesn't depend on Electron's build choices, and an Electron upgrade can't break storage.
- **Isolation.** A crash in the server (resvg has panicked on some pictures before) ends only the server. The window stays, and the app restarts the server.
- **Security.** Running the server inside Electron would need the `runAsNode` fuse. That fuse lets any program start `Delve.exe` as a plain Node interpreter, so it stays off.
- **The cost**: `node.exe` is about 94 MB unpacked and about 22 MB in the installer.

## What the Windows app leaves out

The app is for a public release as one person's map editor. The web app's multiplayer and player-facing parts need other people's devices, accounts or Discord, so the app leaves them out (the user, 2026-10-31). On the server it is one switch, `buildApp`'s `multiplayer: false`, set only by `desktop/main.ts`; the build and the Electron menu do the rest. The web app is unchanged (`fixtures/web-baseline.json`).

| Left out | How |
|---|---|
| **Delve Table**: `/play`, `/play/new`, `/play/:id`, `/play/:id/3d`, `/play/:id/leave`, `/play/join/*`, and `/api/v1/games/*` (games, invites, seats, pages and their `background.png`, the table's live channel, the notebook, 3D scenes) | Not registered: 404. `table.db` and `table-assets` are never created in the data folder; ones left by an older build stay as they are, unread. No "Delve Table" item in the File menu. Its browser bundles (`table.js`, `table-dice.js`, `table3d.js`) aren't shipped, so PixiJS and cannon-es are gone from the app and its third-party notices. |
| **The players' screen**: `/maps/:id/screen`, `GET /api/v1/maps/:id/screen`, the live channel's `?screen=1` | Not registered: 404. `?screen=1` gets an error message and close code 4404. The editor doesn't render its "Players' screen" buttons (the top bar, and the ⋯ menu narrow windows and phones use). `screen.js` isn't shipped. Pages can't ask the window for full screen any more (only the players' screen did). |
| **Discord login**: `/auth/discord`, `/auth/discord/callback`, `/auth/logout` | Not registered: 404. Nothing links to it. |
| **Accounts, admin, logging in and out** | `/login`, `/logout`, `/admin*` and `/account*` send the window back to the library (the gate, as before). The start page has no Play, Admin, Account or Log out link and no "create your admin account" banner. |
| **Delve Table in the editor's hints** | The hints for GM notes, hidden heights, hidden props and "Where you can go" don't mention Delve Table or the players' screen. |

"Request a feature" stays where it was (the start page, the editor's ⋯ menu and shortcuts dialog) and still opens the app's own "Ideas and problems" page: no place to send requests yet, and a pointer to Help → Copy logs.

**What stays**, because it is one person's editing, not multiplayer: the editor and its live channel (`LiveHub` carries the editor's saves, and whatever MCP, the chat, focus and storey changes send to the open editor), autosave, rendering and every export including the players' version (`view=players`, Roll20's player layer), the GM / Players view toggle (it previews that export), fog of war and the GM-only flags (they shape the players' exports and the handout), the parchment handout, the 3D view of a map (`/maps/:id/3d`; the 3D table view belongs to Delve Table and is gone with it), the local chat and the model page.

**Still in the files, unused**: Delve Table's server code (`apps/server/src/table`, `packages/table`, about 210 KB of the 4.6 MB `desktop-main.mjs`) is compiled in, because `app.ts` imports it for the web server; desktop mode never calls it. `viewer.js` is the web's own file, so it still carries the web wording of the editor's hints. The shared stylesheet keeps the table's CSS, and the style guide at `/ui` (linked from the start page's footer) uses table examples as sample text.

## Building

On the dev container (Linux), with no wine:

```sh
cd ~/delve && npm ci                                   # the web app, as always
cd apps/desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci  # Electron, electron-builder (no Linux Electron binary needed)
sh apps/desktop/scripts/build.sh                       # out/Delve-Setup-<v>.exe, out/Delve-<v>-win-x64.zip, out/win-unpacked
```

`scripts/build.sh` does this:

1. `npm run build`: the web release, unchanged.
2. Copies `release/{web,assets,fonts}` and resvg's JavaScript into `build/resources/server`, leaving out the browser bundles of Delve Table (`table.js`, `table-dice.js`, `table3d.js`) and the players' screen (`screen.js`). Bundles `apps/server/src/desktop/main.ts` into `desktop-main.mjs` and copies `chat/lean-prompt.md` next to it, because `local-setup.ts` reads it beside the bundle.
3. `@resvg/resvg-js-win32-x64-msvc` (the same version as `@resvg/resvg-js`) via `npm pack`, checked against npm's integrity hash.
4. `node-v<version>-win-x64.zip` from nodejs.org (the CT's own Node version, or `DELVE_NODE_VERSION`), checked against `SHASUMS256.txt`. Only `node.exe` and `LICENSE` are kept.
5. The icon from Delve's own `brand/mark.svg` (`scripts/icon.mjs`: rendered with resvg into a PNG-compressed `.ico`). `THIRD-PARTY-NOTICES.txt` comes from esbuild's metafiles of what ships (the desktop server, the five browser bundles the app keeps, the Electron main process), so it lists every bundled package with its licence text (`scripts/notices.mjs`).
   5b. The Claude Desktop extension `Delve.mcpb` (`apps/server/src/cli/build-mcpb.ts`; see "Claude Desktop"), shipped as `resources\Delve.mcpb`.
6. Bundles the Electron main process and typechecks `apps/desktop`.
7. electron-builder: the `zip` target and the unpacked app first, then the NSIS installer from the unpacked app.

Downloads are cached in `~/.cache/delve-desktop`, `~/.cache/electron` (Electron's Windows zip) and `~/.cache/electron-builder` (NSIS, its plugins, 7-Zip).

**Cross-building without wine: what changes.**

- **The exe's resources.** `signAndEditExecutable: false`, because rcedit needs wine. `Delve.exe` keeps Electron's icon and its version info ("Electron", Electron's version) in Explorer's Properties and Task Manager. The window and taskbar icon is still Delve's (set at runtime from `resources/icon.png`). The installer's shortcuts and the "Installed apps" entry point at `resources/icon.ico`. electron-builder still writes the asar integrity resource and the fuses: both are plain byte edits that need no wine.
- **The uninstaller.** electron-builder's NSIS template makes its uninstaller by running a generated program at build time (`NsisTarget.computeScriptAndSignUninstaller` runs it through wine on Linux), so the standard template does not build here without wine. `build/installer-nowine.nsi` (passed as `nsis.script`) writes the uninstaller at install time instead (NSIS `WriteUninstaller`), and makensis alone builds it.
  - It installs per user with no admin rights, into `%LOCALAPPDATA%\Programs\Delve` or a folder the user chooses. A non-empty folder gets a `Delve` folder inside it, so uninstalling never removes anything else.
  - It creates Start menu and desktop shortcuts and an "Installed apps" entry.
  - It asks to close Delve when it is running.
  - The uninstaller asks whether to delete the maps (`%APPDATA%\Delve`) and the models (`%LOCALAPPDATA%\Delve`). The default is No, and a silent uninstall never deletes them.
- **What is lost**: signing, the exe's icon and version info, electron-updater's in-place update flags (`--updated`; updates are off anyway), and the multi-language installer UI (the strings exist, the pages are English).

**For the public release**, build on Windows (a GitHub Actions `windows-latest` runner, or any Windows PC) with `npx electron-builder --win nsis zip --x64` and no overrides. That uses electron-builder's own template, where `build/installer.nsh` adds the same "delete my maps?" question. It also writes the icon and version info and signs the installer, the uninstaller and `Delve.exe`.

**Code signing** is configured and off: `win.signtoolOptions` (sha256, RFC 3161 timestamp) is in `electron-builder.yml`. To sign, build on Windows with either:

- `CSC_LINK` (the `.pfx`) and `CSC_KEY_PASSWORD`, or
- `win.azureSignOptions` for Azure Trusted Signing.

Without a certificate, Windows SmartScreen warns on first start ("Windows protected your PC" → More info → Run anyway).

## Desktop mode's security model

1. The server listens on **127.0.0.1 only**, on a port from this launch or the last. Other computers can't reach it.
2. Every request needs **the launch secret**: 32 random bytes, new each launch, passed to the server in its environment (and removed from it at once, so llama-server never inherits it). The window's session adds it as the header `X-Delve-Desktop` to requests for the server's exact origin (HTTP and WebSocket), and also holds it as an HttpOnly, SameSite=Strict cookie. Page scripts can read neither. Other programs and web pages don't have it and get 401.
3. **Host must be `127.0.0.1:<port>` or `localhost:<port>`**, so a web page that points its own domain at 127.0.0.1 (DNS rebinding) is refused even with a guessed port. A request that names an Origin must come from the server's own origin. **No CORS headers**: other origins can't read answers. Pages can't be framed (`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`).
4. Behind the gate there is **one local user** (`singleUser`: the editor without a login) and **no API token**, so the API token's routes are closed. `/mcp` answers only Claude Desktop's bridge with the Claude Desktop key, and only while the user has connected it (see "Claude Desktop"); the window itself gets 404 there. The web server's login, admin and account pages send the window back to the library. Delve Table, the players' screen and Discord login are never registered (`multiplayer: false`), so their routes are 404s. `DELVE_INSECURE_OPEN_EDIT` is not used.
5. What it doesn't defend against: software running as the same Windows user can read the user's files (the maps, the Claude Desktop connection file) and process memory anyway. That is outside any app's control.

Code: `apps/server/src/desktop/gate.ts` (the gate), `config.ts` (the environment: the secret is required, the data folder must be absolute, nothing falls back to the web defaults) and `main.ts` (the entry). Tests: `apps/server/test/desktop.test.ts`, which covers the secret, the Host and Origin checks, WebSocket upgrades over a real socket, no CORS, the single user, where the data goes, what the app leaves out (404s, no table files, no links), and the entry point started as the app starts it, including IPC, port fallback and a clean shutdown.

**Delve Table for players on the LAN: not in the app.** The Windows app leaves Delve Table out (see "What the Windows app leaves out"), so this is not planned for it. The notes stay in case that changes. Players would join from their own devices, so the table would need a second listener that is opt-in, off by default, switched on per session from the app ("Host a game on this network"). It would:

- listen on the LAN address;
- answer only `/play/*`, `/api/v1/games/*` and the static assets, with the invite and player-cookie flow the web server already uses;
- refuse the editor, the map API and the model manager;
- check Host against the LAN address it listens on;
- show the join link and a QR code in the app.

Windows asks for firewall permission the first time `node.exe` listens on the LAN; the app should say so before it happens.

## Chat backends

Server configuration, not a per-user choice:

| Server | Backends offered | Default | Settings in the editor |
|---|---|---|---|
| Web (`main.ts`, the dev container) | `claude` (the Claude Code bridge) when `DELVE_CHAT_URL` is set, else none | `claude` | none: the panel looks and works as before |
| Desktop (`desktop/main.ts`) | `none`, `local`, `anthropic`, `openai` | `none` (a clean first run sends nothing anywhere) | a ⚙ button in the panel |

`buildApp`'s `chatBackends` option is set only by the desktop entry. The web server never builds one, so its chat endpoints, its panel and its release bundle carry only small inert code: `+4.8 KB` in `main.mjs` and `+5.5 KB` in `viewer.js`, with the same 895 files. The selector and the model manager show only when the server offers two or more backends. Claude through a claude.ai login is never offered in the desktop app: Anthropic doesn't allow third-party products to use claude.ai logins. People who want Claude on their Claude plan use Claude Desktop with the Delve extension instead (see "Claude Desktop"); people who want to pay per use put in their own API key.

**Local model** (`apps/server/src/chat/local-chat.ts`):

- **Settings.** An OpenAI-compatible base URL and a model name: Ollama's `http://127.0.0.1:11434/v1`, llama-server's `:8080/v1` or LM Studio's `:1234/v1`. They live in `<data>/chat-settings.json`. "Check the server" lists the server's models.
- **Which API.** An Ollama server is spoken to with its own `/api/chat`, so the context size can be set (16384, as in the bench's lean runs; Ollama's `/v1` runs at 4096 and cuts the prompt). Anything else uses `/v1/chat/completions`.
- **The run.** It is the local-model harness used by `npm run llm-bench`: `runAgent` with `buildSetup('lean')` and its `LEAN_STEPS` (the next-ids line and the final check). Delve's MCP tools run in the same process: `buildMcpServer` over the SDK's `InMemoryTransport`, with no HTTP and no token. Limits per message: 30 model replies, 80 tool calls, 15 minutes. Stop aborts the model request.
- **Translation.** The harness's events are written as Claude Code's stream-json (init, assistant text and `tool_use`, `tool_result`, result) and fed through the bridge's own `StreamTranslator`. The panel gets the same events as with Claude: text, tool calls with results, the plan / activity card (after 4 calls), errors, `done`.
- **Follow-ups.** A session keeps the last few requests and answers, and the next message starts with a short recap. The map itself is always in the context block.
- **The panel's name** is "Assistant", not "Claude", everywhere when the backend isn't the bridge.
- **Known gaps**:
  - the lean tool set has no `create_prop`, `export` or `render`, so "New prop…" and "Give me the PNG" don't work with a local model;
  - small models are slow on a CPU;
  - follow-ups get a recap, not the whole conversation.

**Your own API key: "Claude (your Anthropic API key)" and "OpenAI (your API key)"** (`apps/server/src/chat/api-chat.ts`, offered when `desktop/main.ts` passes `api` to `localChatBackends`):

- **Who pays.** The person's own Anthropic or OpenAI account, per use. The pane says so in one sentence: "The map and the chat go to Anthropic, and what you use is billed to your Anthropic account."
- **No SDK.** Neither the Anthropic nor the OpenAI SDK is in `node_modules`, and none was added: both clients are plain `fetch` (`chat/anthropic.ts`, `chat/openai.ts`, SSE parsing in `chat/sse.ts`).
- **The settings** (the ⚙ pane): a password field, **Check the key** (the provider's models endpoint: `GET /v1/models`), the model, **Remove key**, and a "Get a key" link to the provider's key page. Before the key is checked, Claude offers `claude-opus-5-5` (default), `claude-sonnet-5-5` and `claude-haiku-5-5`; after, the models the key may use (Claude 4.5 and later, those three first). OpenAI's list is `/v1/models` cut to chat models that take tools (no audio, realtime, image, embedding, search, codex, o1-mini/preview…), newest first; a model must be chosen before OpenAI can be switched on. The last list is kept in `chat-settings.json`.
- **The key** (`chat/api-keys.ts`) lives in `<data>/chat-keys.json`, **sealed with Electron's `safeStorage`** (Windows DPAPI: only this Windows user can open it). safeStorage is an Electron API and the server runs on its own `node.exe`, so the server asks the app over their IPC channel (`desktop/vault.ts` ↔ `apps/desktop/src/vault.ts`: `{type: "vault", op: "status" | "seal" | "open"}`). If encryption isn't available, the key is kept as it is in that file (mode 0600; `%APPDATA%` is the user's own) and the pane says "in a file only you can read". The page never gets a key back: only "…" and the last four characters. Keys are checked for their shape (`sk-ant-…`, `sk-…`; Admin keys refused) without being echoed. Requests go only to `https://api.anthropic.com` and `https://api.openai.com` (a different base is a constructor option for the tests, never a setting or an environment variable), with redirects refused. Nothing logs a key; Copy logs and `server.log` blank `sk-…` keys anyway.
- **The run** (`chat/api-agent.ts`): these are strong models, so no lean harness and no helping steps. The normal system prompt (`CHAT_SYSTEM_PROMPT`; OpenAI's copy doesn't say "You are Claude"), the context block, and **every MCP tool** with mcp.ts's names, descriptions and schemas (`chat/api-tools.ts`: `$schema` dropped, draft-07 tuples turned into arrays with minItems = maxItems, OpenAI also loses `propertyNames` and `format`), plus the task list (TaskCreate / TaskUpdate, answered in-process, which becomes the plan card). Every call of a reply runs in order; a call whose arguments aren't JSON gets an `INVALID_JSON` error instead of running; render's PNG goes back to the model as a picture (OpenAI: as a user message after the tool results, or a note for models without vision). Limits per message: 40 model replies, 150 tool calls, 15 minutes, 8 failed calls in a row. Stop aborts the request at once.
- **Anthropic specifics**: API version `2026-10-21` (no sampling parameters), streaming with `eager_input_streaming` on every tool, adaptive thinking and effort `medium` where the model takes them (thinking blocks passed back unchanged within a reply; earlier replies go back as plain text), **prompt caching** with breakpoints on the last tool, on the system prompt and on the newest message, and server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on Opus 5 / 5.5, Sonnet 5.5 and Fable, dropped for the rest of the run if the account refuses the beta. A refusal runs nothing from that reply.
- **Errors in words**: a refused key (401), no credit (Anthropic's 402 / "credit balance", OpenAI's `insufficient_quota`), a rate limit (429, retried twice with `retry-after` first), overload (529) and server errors (retried), a model the key can't use, no network.
- **What the panel shows** is the same as for the other backends (the replies go through the bridge's `StreamTranslator`, text streaming in), plus the **tokens per reply** in the reply's header ("12.3k tokens in (9k cached) · 840 out"), from the `done` event's `tokens` (sent only by these backends).
- **Follow-ups** carry the earlier requests and answers of the conversation as plain text (up to 20).
- **Tests**: `apps/server/test/api-chat.test.ts`, against fake Anthropic and OpenAI servers on 127.0.0.1 (fetch is wrapped so anything else throws).

## Claude Desktop

**Help → Connect to Claude Desktop…** (also in the chat settings: the "Or chat in Claude Desktop" box POSTs `/api/v1/desktop/claude-desktop/connect`, and the server asks the app over IPC, `{type: "claude-desktop-connect"}`, for the same dialog) lets a person with Claude Desktop chat with Claude there, on their own Claude plan, while Claude builds and changes the maps in the running Delve app through Delve's existing MCP tools (the same `mcp.ts` tools, live in the Delve window through `LiveHub`).

```
Claude Desktop ──stdio (MCP)──▶ Delve extension: server/index.js ──HTTP POST /mcp, Bearer <key>──▶ Delve's server (127.0.0.1:<port>)
                                reads %APPDATA%\Delve\claude-desktop.json (port, key)          the desktop gate: the key on /mcp only
```

- **The dialog** says what happens (an extension in Claude Desktop, maps edited live, each change one undo step), that Claude runs on the person's own Claude plan, and that it works only while Delve is open. **Connect and install** then turns access on, writes the connection file, and opens `resources\Delve.mcpb` with `shell.openPath`, so Claude Desktop shows its own install confirmation. If nothing opens it (no Claude Desktop), a second dialog points to https://claude.ai/download and describes the manual route: Claude Desktop → Settings → Desktop app → Extensions (older versions: Settings → Extensions) → Advanced settings → Extension Developer → "Install Extension…", with "Show the extension file".
- **Disconnect Claude Desktop** (enabled only while connected) revokes the key: the connection file is deleted and the server turns access off at once; the next connect makes a new key. The extension stays in Claude Desktop until removed there. The state shows in the menu ("Connect to Claude Desktop again…") and in Help → About ("Claude Desktop: connected").
- **The key** is per install: 32 random bytes (43 base64url characters) from the first connect, never the window's launch secret. It lives only in the connection file `%APPDATA%\Delve\claude-desktop.json` (`{app, version: 1, port, key, updated}`, written atomically, mode 0600), which doubles as "connected" (`apps/desktop/src/claude-desktop.ts`). The app passes it to the server as `DELVE_CLAUDE_DESKTOP_KEY` at start (removed from the server's environment at once, so llama-server never inherits it) and as an IPC message `{type: "claude-desktop", key | null}` on connect and disconnect.
- **The port**: the server takes the last launch's port or any free one (see "Architecture"), so the app rewrites the file's `port` once the server listens (also after a crash restart) and sets it to `null` when Delve quits, so the bridge never knocks on a port someone else may have taken since.
- **The gate** (`desktop/gate.ts`) lets the key in **only for `/mcp`** (exact path), only with POST, GET or DELETE (what the Streamable HTTP transport uses), only with the Host check passed and **no Origin** (browsers always send one there), compared in constant time, with no CORS headers; a key anywhere else meets the window-secret check and gets 401, as does a wrong key or any key while disconnected (with a JSON-RPC message saying which). Granted requests are marked for `registerMcp` through `buildApp`'s `mcpGrant`, which only the desktop entry sets; the web server's `/mcp` still takes only the API token and chat tokens (`fixtures/web-baseline.json` unchanged). Desktop mode also adds a paragraph to the MCP instructions (`mcpNote`): links in tool results open only inside the app, so Claude shouldn't hand them out and should use focus.
- **The bridge** (`apps/desktop/claude-extension/server/index.js`): CommonJS with Node built-ins only, run by Claude Desktop's built-in Node. Newline-delimited JSON-RPC on stdio, each message POSTed to `http://127.0.0.1:<port>/mcp` with `Accept: application/json, text/event-stream` and, after initialize, `MCP-Protocol-Version`; JSON answers and event streams (split characters decoded whole) are passed back; `ping` is answered locally; a `notifications/cancelled` aborts the request it names. It reads the connection file for every message. When Delve is closed (`port: null`, or nobody listening) or not connected (no file, a refused key), it answers by itself: `initialize` and `tools/list` from `server/tools.json` (Delve's tools and instructions, built into the bundle), and every tool call returns the plain message, e.g. "Delve isn't running. Open Delve, then try again." or "Delve isn't connected to Claude Desktop. Open Delve and choose Help → Connect to Claude Desktop…, then try again." It never starts Delve and never crashes on these; once Delve answers again it sends `notifications/tools/list_changed`. Its stderr (Claude Desktop's log) never has the key.
- **The bundle** `Delve.mcpb` (`apps/server/src/desktop/claude-extension.ts`, built by `node apps/server/src/cli/build-mcpb.ts <out> --version <v>` in step 5b of `scripts/build.sh`, shipped through `extraResources`): a zip (`zip.ts` `zipFiles`, deflate; no packaging tool and nothing installed) of `manifest.json` (MCPB manifest version 0.3: name `delve`, display name "Delve", author "Delve" with no email for now, `server.type: node`, `entry_point: server/index.js`, `mcp_config: node ${__dirname}/server/index.js`, `compatibility: {platforms: [win32], runtimes: {node: >=18.0.0}}`, `icon`/`icons` 512 px, and the tool list with each tool's first sentence), `server/index.js`, `server/tools.json` and `icon.png` (Delve's mark). The tool list is read from mcp.ts's own server at build time, so it can't drift; the test checks it against a live server too. **Placeholders**: the author ("Delve", no email or URL) and the missing homepage, support and privacy links wait for the project's public home.
- **What it costs the web release**: nothing new ships there; `gate.ts`, the bridge, the bundle code and the Electron side are desktop-only. `app.ts` and `mcp.ts` gained two options that only the desktop entry sets.
- **Tests**: `apps/server/test/claude-desktop.test.ts` (the gate's refusals, the bridge spawned as Claude Desktop spawns it against a desktop-mode server on a free port: initialize, tools/list, add_room changing the map, render's PNG, a wrong key, access off, a missing file, Delve closed or crashed, starting with Delve closed, an event-stream answer through a fake server; the manifest and the zip) and `apps/desktop/test/desktop-app.test.ts` (the connection file, the menu, the vault, log blanking, and the whole chain with the real server entry: the key over IPC, the bridge reaching `/mcp`, Disconnect closing it).
- **Not verified here**: that Claude Desktop accepts the bundle and shows its install dialog when the file is opened (checked only against the MCPB spec and its 0.3 schema), and the Windows `shell.openPath` association. The user tests that on the backup PC.

## The built-in model runtime

Bundled since 2026-10-31: llama.cpp `b11476` (Vulkan build) in `resources\llama`. `apps/server/src/desktop/runtime.ts` (`LlamaRuntime`):

- **Start.** It starts `llama-server` with the chosen GGUF on a free 127.0.0.1 port:
  `--model --alias --host 127.0.0.1 --port --api-key-file --ctx-size --n-gpu-layers --jinja --no-webui`.
  - The API key is new each start and sits in a key file, never on the command line. After the start it checks that the API refuses requests without the key.
  - It waits for `/health` to answer 200 (503 while loading; up to 3 minutes).
- **GPU.** With `gpu: auto` it offloads all layers (`999`). If that start fails, it starts again with `0` (the CPU) and says so. With `gpu: cpu` it never uses the GPU.
- **Crashes.** A crash gets a restart, up to 3 in 10 minutes with a growing pause; after that the runtime shows "stopped after an error".
- **Logs.** Its output goes to `logs\llama-server.log` (moved to `.1` at 5 MB).
- **For the chat** it is a `BuiltinModel` (`asBuiltin`): the chat's `local.source: "builtin"` starts it on first use with the model chosen on the model page.

`apps/server/src/desktop/models.ts` and `models-page.ts` make up the model manager at **/models** (Help → Models for the chat…):

- the model files in `%LOCALAPPDATA%\Delve\models`, with size, "shared with Ollama" for hard links, and disk used and free;
- choosing the model and the GPU mode (`<data>/runtime.json`);
- start and stop;
- "Use it for the chat";
- Ollama's models with Import;
- the downloads, shown as "Coming later".

Its REST API is `/api/v1/runtime` (GET), `/settings` (PUT), `/import` (POST), `/models/:file` (DELETE), and `/start` and `/stop` (POST).

**Import from Ollama** (`desktop/ollama.ts`):

- **Finding the models.** It reads `OLLAMA_MODELS`, or `%USERPROFILE%\.ollama\models`. A manifest at `manifests/<registry>/<namespace>/<model>/<tag>` is OCI-style JSON. Its layer with media type `application/vnd.ollama.image.model` is the GGUF, at `blobs/sha256-<hex>`; older stores use `sha256:<hex>`.
- **Checking them.** A model is usable when the blob exists, its size matches the manifest, and it starts with `GGUF`. Models split into several weight files are refused. A vision model's projector is left behind.
- **Importing.** Import hard-links the blob as `<name>.gguf`, which takes no extra space and needs no admin rights on the same drive. On another drive it copies the blob through `.part`.
- **Tests**: `apps/server/test/ollama-import.test.ts`, on a fake store.

**Download with resume** (`desktop/download.ts`, for later, unused):

- It downloads into `<file>.part`, resumes with `Range: bytes=<size>-`, starts over when the server ignores the range, and checks the size and the sha256 when known before renaming the file into place.
- `DOWNLOADS` points at Qwen's official GGUF repositories:
  - `Qwen/Qwen3-8B-GGUF` · `Qwen3-8B-Q4_K_M.gguf`, about 5.0 GB;
  - `Qwen/Qwen3-4B-GGUF` · `Qwen3-4B-Q4_K_M.gguf`, about 2.5 GB;
  - both Apache-2.0.
- Before switching it on, check the file names and pin each sha256.

**The bundled runtime** (the user approved the download on 2026-10-31): build.sh step 4b fetches `llama-b11476-bin-win-vulkan-x64.zip` from https://github.com/ggml-org/llama.cpp/releases into `~/.cache/delve-desktop` (33,380,424 bytes, sha256 `5c71e7b749697da4a8d46e9ee55486845cbba27c9dfbecb4007f31ba6610d523`, pinned in the script) plus the tag's `LICENSE` (pinned too: the zip has none), and copies into `build/resources/llama` (→ `resources\llama` via `extraResources`) only what llama-server loads: `llama-server.exe`, `llama-server-impl.dll`, `llama.dll`, `llama-common.dll`, `mtmd.dll`, every `ggml*.dll` (the CPU variants and the Vulkan backend are loaded at run time), `libomp.dll`, with `LICENSE-llama.cpp`, `LICENSE-LLVM-OpenMP` and `VERSION`. The app passes `DELVE_LLAMA_SERVER` when `llama-server.exe` is there, and the model page's Start and "Use it for the chat" come alive.

- **Why Vulkan**: it runs on NVIDIA, AMD and Intel GPUs and on the CPU. The CPU-only zip is about 19.4 MB; the CUDA builds are 150–265 MB plus a 390 MB runtime.
- **Checked against the binary** (strings in its DLLs): every flag above is in b11476, `--api-key-file` and `--no-webui` included. Not checked here (no Windows): that `/health` answers 503 while loading.
- **Needs on the PC**: the Microsoft Visual C++ 2015–2022 runtime (`MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, imported by llama-server and ggml-vulkan), which most PCs already have; `vulkan-1.dll` comes with the GPU driver (without it ggml uses the CPU). Bundling the VC++ DLLs next to llama-server is open (a release checklist item).
- **Licences**: llama.cpp and ggml (MIT) and the LLVM OpenMP runtime (Apache-2.0 WITH LLVM-exception) are listed in the notices with their texts.
- **To change the build**: change `LLAMA_BUILD` and both sha256 values in build.sh, then check the flags against the new binary.

## Updates

electron-updater is prepared and off (`src/updater.ts`, `UPDATE_URL = ''`, `publish: null`). Nothing is contacted. The repository (herades-sys/delve-app) can serve them from its GitHub releases once it is public; a token must never ship in the app. To switch it on:

1. Choose a public HTTPS host: a public GitHub repository's releases, or any static host.
2. Set `publish` in `electron-builder.yml` and `UPDATE_URL` to it.
3. Sign the installer. electron-updater checks the downloaded installer's signature against the running app's publisher.
4. Build on Windows with electron-builder's own NSIS template, whose `--updated` flow electron-updater relies on.

## Logs

`%APPDATA%\Delve\logs`:

- `main.log`: the app;
- `server.log`: the server's JSON log lines;
- `llama-server.log`: the model runtime.

Each is moved to `.1` at 5 MB. **Help → Copy logs** puts the versions and the last 300 lines of each on the clipboard. The launch secret, the Claude Desktop keys of the session, Anthropic and OpenAI keys (`sk-…`) and anything that looks like a key or token is replaced by `[secret]`; the server's output is blanked the same way before it is written to `server.log`. Help → Open the logs folder opens the folder.

## Public-release checklist

| Item | Status |
|---|---|
| Licence for Delve | **Done (2026-10-31).** Apache-2.0, "Copyright 2026 herades-sys": `LICENSE` and `NOTICE` at the root, `"license": "Apache-2.0"` in every package.json, the MCPB manifest's `license`, and the text at the end of the notices. The user decided Delve goes open source; making the repository public comes after a pre-publication audit (secrets, personal data, third-party art in the history). |
| Visual C++ runtime | **Open.** llama-server and ggml-vulkan need `MSVCP140.dll`, `VCRUNTIME140.dll` and `VCRUNTIME140_1.dll` (most PCs have them). For a clean PC, ship them next to llama-server (Microsoft allows app-local copies of the redistributable DLLs) or have the installer run `vc_redist.x64.exe`; either needs the user's OK for the download. |
| Code-signing certificate | **Chosen, not bought (2026-10-31).** As open source: the Certum Open Source code-signing certificate on a smart card (about €69 the first year with card and reader; the publisher is the user's own name; the project must stay public and non-commercial). It signs headless from Linux with jsign (`--storetype CRYPTOCERTUM`, the reader passed through to the dev container), through a custom `win.sign` hook in electron-builder (set `publisherName` to the certificate's subject for electron-updater). Not possible: Azure Artifact Signing (individuals only in the US/Canada); EV no longer helps SmartScreen. The `.mcpb` stays unsigned: `mcpb sign` needs a PEM key file, which a smart card can't give (modelcontextprotocol/mcpb PR #222 would allow external signers). |
| Name and trademark check for "Delve" | **Open.** "Delve" is a common word and used by other software products. Check the EUIPO, WIPO and USPTO registers in class 9 (software) and class 41 (games), and app stores, before the first public release. The `appId` `app.delve.desktop` should be final before then: changing it later breaks shortcuts and updates. |
| Privacy | **Done for phase 1.** No telemetry, no crash reports, no update checks. The chat sends nothing unless the user sets up a local model server (on their own machine or network) or puts in their own Anthropic or OpenAI API key (then the map and the chat go to that provider, as the pane says). Claude Desktop reaches Delve only after Connect to Claude Desktop…. Spellchecking uses Windows' own. Say so on the release page. |
| Claude Desktop extension | **Open.** Test the install on Windows; set the manifest's author, homepage, support and privacy links once the project has a public home (author is "Delve" with no email for now). |
| Third-party notices | **Generated** at every build (`THIRD-PARTY-NOTICES.txt` in resources, Help → Third-party notices): Electron and Chromium (`LICENSE.electron.txt`, `LICENSES.chromium.html`), Node.js, resvg (MPL-2.0), three.js, clipper2-ts (BSL-1.0), fastify and the other bundled packages, IM FELL English and Marcellus SC (OFL-1.1); 86 packages since Delve Table's bundles stay out (PixiJS and its dependencies and cannon-es were 9 of the 95 before). llama.cpp and ggml (MIT) and the LLVM OpenMP runtime (Apache-2.0 WITH LLVM-exception) since 2026-10-31. **Later**: Qwen (Apache-2.0, credited when a model is downloaded from inside the app). |
| Update host | **Open.** A public HTTPS host (see Updates). |
| Installer built on Windows | **Open.** For signing, the exe's icon and version info, and electron-updater's update flow. |
| Asar integrity fuse | **Open.** Switch `enableEmbeddedAsarIntegrityValidation` on after one test on Windows. |
| Delve's own art only | **Done.** The icon comes from `brand/mark.svg`; no third-party art in the app. |
| SmartScreen reputation | **Comes with signing and downloads over time.** Expect warnings for the first releases. |
