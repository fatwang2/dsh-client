# DSH Client

DSH Client is a native client for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web GUI. The packaged application is named **DeepSeek Harness**. Its shell supervises a loopback `dsh web` host process, owns application lifetime, and stages the exact pinned harness runtime into the packaged app — no separate Node.js install or terminal window required.

This is an independent community project and is not affiliated with or endorsed by DeepSeek.

## Architecture

```
src/main.ts               Electron shell: window, app menu, security hardening, boot wiring
src/host-supervisor.ts    dsh web child process: spawn, readiness URL parsing, graceful shutdown
src/window-lifecycle.ts   close-to-hide and quit sequencing, independent from Electron
scripts/stage-runtime.mjs materializes the pinned dsh dependency closure into runtime-host/
scripts/verify-packaged-runtime.cjs  afterPack guard: reject packages missing Host artifacts
scripts/release-mac.sh    local signed, notarized, GitHub Release entrypoint
scripts/release-mac.mjs   release preflight, packaging verification, and upload
runtime/package.json      exact @deepseek-ai/dsh version pin (no compatibility promise upstream)
```

How the shell and the host fit together:

1. On boot the supervisor spawns `dsh web --host 127.0.0.1 --port 0`. The OS assigns a free loopback port, so there is never a 3080 collision.
2. The harness prints its canonical readiness line (`dsh web: http://127.0.0.1:<port>`). The supervisor parses it incrementally, validates it strictly (loopback HTTP, root path, explicit port), and hands the origin to the window.
3. The window loads only that origin. Navigation is locked to it; other HTTP(S) links open in the system browser; every permission request is denied; the renderer runs sandboxed with no Node integration.
4. Closing the window hides it while the Host stays alive; clicking the Dock icon restores it. Explicit quit disposes the Host first (SIGTERM, then SIGKILL after the harness' 5s drain) and only then releases Electron's quit sequence.
5. Packaged builds run the staged CLI through Electron's own Node runtime (`ELECTRON_RUN_AS_NODE=1`), so no second Node binary ships.

### macOS traffic-light inset

The shipped harness frontend is unaware of the frameless `hiddenInset` shell, so the shell injects a stylesheet that reserves a 40px strip at the top of the sidebar column for the close/minimize/zoom buttons and marks the full-width top strip as the native window drag region (`[class*="sidebarCol"]` attribute selector, stable across css-module hash changes). Interactive controls are explicitly excluded from the drag region so they keep receiving pointer events. The injection is queued before `loadURL` and re-applied on `dom-ready`; it is never awaited, because `insertCSS` before the renderer commits a document can otherwise stall boot.

`scripts/verify-inset.mjs` checks the applied geometry over CDP (launch with `--remote-debugging-port=<port>`): the drag region must span the full window width at 40px high and the logo row must start below the traffic-light strip.

## Development

```sh
npm install
npm run stage        # materialize the pinned dsh runtime closure into runtime-host/
npm run dev          # build + launch; quit with the application menu or Cmd+Q
```

`DSH_MAC_NODE_EXECUTABLE` overrides the dev Node binary. The dev host shares your regular `~/.dsh` (credentials, settings, sessions).

## Test & typecheck

```sh
npm test
npm run typecheck
```

## Packaging

```sh
npm run package      # unpacked app for the current platform (dist/)
npm run dist         # unsigned macOS DMG + update ZIP for local validation
npm run dist:signed  # signed + notarized DMG/ZIP + update metadata
```

The staging step installs the exact pinned `@deepseek-ai/dsh` production tree with npm's hoisted layout (no pnpm symlink store), strips bin symlinks, and fails the build if the CLI entry or the Web frontend dist is missing. An `afterPack` hook re-verifies the staged artifacts inside the bundle before signing.

After a signed build, verify the installed artifact:

```sh
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/DeepSeek Harness.app"
spctl --assess --type execute --verbose=4 "dist/mac-arm64/DeepSeek Harness.app"
xcrun stapler validate "dist/mac-arm64/DeepSeek Harness.app"
```

## Releases and automatic updates

Signed releases use `electron-updater` with the public
[`fatwang2/dsh-client`](https://github.com/fatwang2/dsh-client) GitHub Releases
feed. `electron-builder` embeds that repository into the application and
generates the ZIP, blockmap, and `latest-mac.yml` consumed by Squirrel.Mac.

Releases are built on the maintainer's Mac, following the same local model as
Pulse. Copy `.env.release.example` to the ignored `.env.release`, configure the
Developer ID identity and App Store Connect API key, then run:

```sh
SKIP_UPLOAD=1 npm run dist:signed  # sign, notarize, and verify without publishing
npm run dist:signed                # publish v<package version> to GitHub Releases
```

The release command refuses to publish from a dirty worktree or a branch other
than `main`. It signs and notarizes first, verifies the app and update metadata,
then uses the locally authenticated GitHub CLI to create or update the Release.
Version-specific notes live in `.github/release-notes/<version>.md`.

A signed app checks quietly after startup, downloads in the background, and
offers to restart only after the update is ready. Choosing to restart first
shuts down the bundled Host through the normal graceful path.

## Environment

| Variable | Effect |
|---|---|
| `DSH_MAC_OWN_HOME=1` | Confine harness state to the app's data dir (`~/Library/Application Support/dsh-mac/dsh-home`) instead of the shared `~/.dsh`. |
| `DSH_MAC_NODE_EXECUTABLE` | Dev-only: Node-compatible binary used to run the staged CLI. |
| `DSH_MAC=1` | Marker exported to the Host process environment. |
| `DSH_RELEASE_ENV` | Optional path to the local release environment file; defaults to `.env.release`. |
| `DSH_RELEASE_TAG` | Optional Release tag override; defaults to `v<package version>`. |
| `SKIP_UPLOAD=1` | Build, sign, notarize, and verify locally without changing GitHub Releases. |

All other environment variables pass through to the Host (`DEEPSEEK_API_KEY`, proxies, etc.).

## Updating the harness

The harness is a fast-moving release candidate with explicitly no compatibility promise. Update by bumping the exact pin in `runtime/package.json`, re-running `npm run stage`, and re-verifying startup before shipping.

## Roadmap

- DSH_HOME policy switch in the application menu
- Renderer IPC carrier (the transport shape the harness GUI architecture reserves for desktop hosts)

## License

MIT. The packaged app embeds the MIT-licensed `@deepseek-ai/dsh` runtime; see its repository's `THIRD_PARTY_NOTICES.md` for transitive dependency licenses before distribution.
