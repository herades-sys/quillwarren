# Delve for Windows (the desktop app)

Delve also runs as a Windows desktop app: one window with the editor, the maps on the user's own computer, no login, no server to set up. It is the same code as the web app at delve.example.com. The server runs in **desktop mode**, which is switched on only by the desktop app's own entry point. The web server (`main.ts`, `npm run build`, the release on the dev container) is unchanged: `fixtures/web-baseline.json` pins its routes, pages and answers as they were before the desktop work, and `apps/server/test/web-baseline.test.ts` checks them.

Status (phase 1, 2026-10-07): the app, desktop mode, the local-model chat and the runtime manager are built and tested on the dev container. The built app itself is tested by the user on Windows (see `D:\Claude\delve-windows\TESTING.md` on the main PC). The built-in model runtime has no binary yet.

## Architecture

```
Delve.exe (Electron 44, apps/desktop)                       %APPDATA%\Delve\
  main process: src/main.ts                                    data\   maps (delve.db), pictures, props,
   - one instance, the menu, the window's place                       Delve Table, chat-settings.json, runtime.json
   - a random secret per launch                                logs\   main.log, server.log, llama-server.log
   - starts the server, stops it on quit                       window-state.json, desktop.json (the last port)
        │ spawn + IPC ({type:"ready",port} / {type:"shutdown"})
        ▼                                                    %LOCALAPPDATA%\Delve\models\   GGUF files
resources\node\node.exe (Node 24.21.0, nodejs.org)
  resources\server\desktop-main.mjs (apps/server/src/desktop/main.ts, bundled)
   - Fastify on 127.0.0.1:<port>, desktop gate in front of every request
   - the whole web app: library, editor, 3D, handout, trace, Delve Table, PNG export (resvg)
   - chat: none or a local model (chat/local-chat.ts), never the Claude bridge
   - /models: model files, Ollama import, the built-in runtime (desktop/runtime.ts)
        │ later: spawn
        ▼
resources\llama\llama-server.exe (llama.cpp, MIT) — not bundled yet
```

- **`apps/desktop`** is outside the root npm workspaces, with its own `package.json` and `package-lock.json`. The root `npm ci` / `npm install` (the server release on the dev container) never sees Electron. Its dependencies are all dev dependencies: the main process is bundled by esbuild into `dist/main.cjs`, so nothing from `node_modules` ships in `app.asar`.
- **The window** loads `http://127.0.0.1:<port>/` (the library). It runs with `contextIsolation`, `sandbox` and no Node integration, and has no preload script. Links to other sites open in the default browser; nothing navigates the window away from Delve. Delve's own pages that open a new window (the players' screen) get a window with the same rules. Permissions are denied except full screen and writing to the clipboard.
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

## Building

On the dev container (Linux), with no wine:

```sh
cd ~/delve && npm ci                                   # the web app, as always
cd apps/desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci  # Electron, electron-builder (no Linux Electron binary needed)
sh apps/desktop/scripts/build.sh                       # out/Delve-Setup-<v>.exe, out/Delve-<v>-win-x64.zip, out/win-unpacked
```

`scripts/build.sh` does this:

1. `npm run build`: the web release, unchanged.
2. Copies `release/{web,assets,fonts}` and resvg's JavaScript into `build/resources/server`. Bundles `apps/server/src/desktop/main.ts` into `desktop-main.mjs` and copies `chat/lean-prompt.md` next to it, because `local-setup.ts` reads it beside the bundle.
3. `@resvg/resvg-js-win32-x64-msvc` (the same version as `@resvg/resvg-js`) via `npm pack`, checked against npm's integrity hash.
4. `node-v<version>-win-x64.zip` from nodejs.org (the CT's own Node version, or `DELVE_NODE_VERSION`), checked against `SHASUMS256.txt`. Only `node.exe` and `LICENSE` are kept.
5. The icon from Delve's own `brand/mark.svg` (`scripts/icon.mjs`: rendered with resvg into a PNG-compressed `.ico`). `THIRD-PARTY-NOTICES.txt` comes from esbuild's metafiles, so it lists every bundled package with its licence text (`scripts/notices.mjs`).
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
4. Behind the gate there is **one local user** (`singleUser`: the editor without a login) and **no API token**, so the API token's routes and `/mcp` are closed. The web server's login, admin, account and Discord pages send the window back to the library. `DELVE_INSECURE_OPEN_EDIT` is not used.
5. What it doesn't defend against: software running as the same Windows user can read the user's files (the maps) and process memory anyway. That is outside any app's control.

Code: `apps/server/src/desktop/gate.ts` (the gate), `config.ts` (the environment: the secret is required, the data folder must be absolute, nothing falls back to the web defaults) and `main.ts` (the entry). Tests: `apps/server/test/desktop.test.ts`, which covers the secret, the Host and Origin checks, WebSocket upgrades over a real socket, no CORS, the single user, where the data goes, and the entry point started as the app starts it, including IPC, port fallback and a clean shutdown.

**Delve Table for players on the LAN (later).** Players join from their own devices, so the table needs a second listener that is opt-in, off by default, switched on per session from the app ("Host a game on this network"). It would:

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
| Desktop (`desktop/main.ts`) | `none`, `local` | `none` (a clean first run sends nothing anywhere) | a ⚙ button in the panel |

`buildApp`'s `chatBackends` option is set only by the desktop entry. The web server never builds one, so its chat endpoints, its panel and its release bundle carry only small inert code: `+4.8 KB` in `main.mjs` and `+5.5 KB` in `viewer.js`, with the same 895 files. The selector and the model manager show only when the server offers two or more backends. Claude through a claude.ai login is never offered in the desktop app: Anthropic doesn't allow third-party products to use claude.ai logins. A Claude API-key backend can come later as a third backend.

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

## The built-in model runtime

Code only, with no binary yet. `apps/server/src/desktop/runtime.ts` (`LlamaRuntime`):

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

**To finish the runtime** (needs the user's approval for the download): put llama.cpp's Windows build in `apps/desktop/build/resources/llama/` and uncomment the `llama` entry under `extraResources` in `electron-builder.yml`. The app then passes `DELVE_LLAMA_SERVER`, and the model page's Start and "Use it for the chat" come alive.

- **Recommended file**: `llama-b<build>-bin-win-vulkan-x64.zip` from https://github.com/ggml-org/llama.cpp/releases. The Vulkan build runs on NVIDIA, AMD and Intel GPUs and on the CPU. On 2026-10-07 that was `b11476`: 33,380,424 bytes, sha256 `5c71e7b749697da4a8d46e9ee55486845cbba27c9dfbecb4007f31ba6610d523`.
- **Smaller**: the CPU-only zip, about 19.4 MB.
- **Not suitable**: the CUDA builds are 150–265 MB plus a 390 MB runtime.
- **Then check against the real binary**: the flags above (in particular `--api-key-file` and `--no-webui`), and that `/health` answers 503 while loading.
- **Licences**: add llama.cpp's MIT licence and ggml's to the notices.

## Updates

electron-updater is prepared and off (`src/updater.ts`, `UPDATE_URL = ''`, `publish: null`). Nothing is contacted. The GitHub repository is private, so its releases can't serve updates without a token, and a token must never ship in the app. To switch it on:

1. Choose a public HTTPS host: a public GitHub repository's releases, or any static host.
2. Set `publish` in `electron-builder.yml` and `UPDATE_URL` to it.
3. Sign the installer. electron-updater checks the downloaded installer's signature against the running app's publisher.
4. Build on Windows with electron-builder's own NSIS template, whose `--updated` flow electron-updater relies on.

## Logs

`%APPDATA%\Delve\logs`:

- `main.log`: the app;
- `server.log`: the server's JSON log lines;
- `llama-server.log`: the model runtime.

Each is moved to `.1` at 5 MB. **Help → Copy logs** puts the versions and the last 300 lines of each on the clipboard. The launch secret and anything that looks like a key or token is replaced by `[secret]`. Help → Open the logs folder opens the folder.

## Public-release checklist

| Item | Status |
|---|---|
| Licence for Delve | **Open.** The user chooses (e.g. MIT, or AGPL-3.0 for the server). `apps/desktop/package.json` says `UNLICENSED` and the notices say "all rights reserved" until then. |
| Code-signing certificate | **Open.** An OV certificate (~€200–400/year, a hardware token or cloud HSM since 2023) or Azure Trusted Signing (about $10/month, needs a company or a verified individual in supported countries). Configured and off (`win.signtoolOptions`). Build on Windows to sign. |
| Name and trademark check for "Delve" | **Open.** "Delve" is a common word and used by other software products. Check the EUIPO, WIPO and USPTO registers in class 9 (software) and class 41 (games), and app stores, before the first public release. The `appId` `app.delve.desktop` should be final before then: changing it later breaks shortcuts and updates. |
| Privacy | **Done for phase 1.** No telemetry, no crash reports, no update checks. The chat sends nothing unless the user sets up a local model server (on their own machine or network). Spellchecking uses Windows' own. Say so on the release page. |
| Third-party notices | **Generated** at every build (`THIRD-PARTY-NOTICES.txt` in resources, Help → Third-party notices): Electron and Chromium (`LICENSE.electron.txt`, `LICENSES.chromium.html`), Node.js, resvg (MPL-2.0), three.js, PixiJS, cannon-es, clipper2-ts (BSL-1.0), fastify and the other bundled packages, IM FELL English and Marcellus SC (OFL-1.1). **Later**: llama.cpp and ggml (MIT), Qwen (Apache-2.0, credited when a model is downloaded from inside the app). |
| Update host | **Open.** A public HTTPS host (see Updates). |
| Installer built on Windows | **Open.** For signing, the exe's icon and version info, and electron-updater's update flow. |
| Asar integrity fuse | **Open.** Switch `enableEmbeddedAsarIntegrityValidation` on after one test on Windows. |
| Delve's own art only | **Done.** The icon comes from `brand/mark.svg`; no third-party art in the app. |
| SmartScreen reputation | **Comes with signing and downloads over time.** Expect warnings for the first releases. |
