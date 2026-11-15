# Ramsgate Reborn Launcher

This is the launcher for Ramsgate Reborn, a community project that keeps Dauntless 1.12.0 playable. It is the Windows app players use to sign in, check their game install, install updates and press Play.

Ramsgate Reborn is an unofficial community project. It is not affiliated with or endorsed by Phoenix Labs, Epic Games, Forte Labs or any other Dauntless rights holder.

Only the launcher source is in this repository. The game client, the game server and the backend are not included.

## What it does

- Signs players in (Discord sign-in or an account on the server).
- Checks the Dauntless 1.12.0 install and installs signed runtime updates.
- Launches the game.
- Keeps per-session game logs that the player can choose to upload.

It is built with Tauri 2 (Rust), React, TypeScript and Vite.

## Building

You need:

- Windows x64
- Node.js 20 or newer
- Rust stable with the MSVC toolchain, plus the Visual Studio C++ Build Tools and a Windows SDK
- Microsoft Edge WebView2 Runtime

Then:

    npm ci
    npm run tauri dev

`npm run build` type-checks and builds the web part only. A debug build talks to a backend on `http://127.0.0.1:3000` unless you set these environment variables at compile time:

- `MYSTPAX_API_BASE_URL` is the backend address.
- `MYSTPAX_RUNTIME_ENDPOINT` is the runtime update address.
- `MYSTPAX_RUNTIME_PUBLIC_KEY_B64` is the public key used to check runtime updates.

A release build refuses to compile unless the first two are `https://` addresses.

The empty folder `src-tauri/offline-component` is there on purpose. Tauri bundles it, and the optional offline component is not part of this repository, so it stays empty (only a `.gitkeep`). The offline helper scripts are also not included, so the offline mode will not work in a build from this tree.

To build an installer without the project's update signing key, leave `createUpdaterArtifacts` as it is (false) and run:

    npm run tauri build

The updater public key in `src-tauri/tauri.conf.json` belongs to the official releases. A build you make yourself will not be offered official updates. Private signing keys are never part of this repository.

## Tests

    cargo test --manifest-path src-tauri/Cargo.toml
    npm run test:ui

## Problems and contributions

Please report problems at https://support.afterlifeinteractive.com/ or open an issue here. Pull requests are welcome. Keep them small and say what you tested.

## Licence

GNU Affero General Public License v3.0 only. See `LICENSE`. The earlier authors this work is based on, and the additional terms that apply to part of it, are in `NOTICE.md` and `ADDITIONAL_TERMS.md`.
