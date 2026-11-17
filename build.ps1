# Builds the player launcher exactly as released. All values below are public: the play host, the runtime update
# verification (public) key and the deep-link scheme. Unsigned build: the release installer is signed separately by the
# maintainer, so a build from source will not hash the same as the released file.
$env:MYSTPAX_API_BASE_URL = "https://play.afterlifeinteractive.com"
$env:MYSTPAX_RUNTIME_ENDPOINT = "https://play.afterlifeinteractive.com/launcher/v1/runtime"
$env:MYSTPAX_RUNTIME_PUBLIC_KEY_B64 = "BKTOfIr4PMEQk/95iDrmnhRrMnbIhcBjro06gtX0D5Y="
$env:VITE_API_BASE_URL = "https://play.afterlifeinteractive.com"
$env:MYSTPAX_DEEPLINK_SCHEME = "zfxramsgatewine"
$env:VITE_DISCORD_ONLY = "true"
Set-Location $PSScriptRoot
npm ci
npm run tauri -- build --config src-tauri\tauri.release.conf.json --bundles nsis