# Troubleshooting

Back to the [README](../README.md). If nothing here helps, ask on the [support site](https://support.afterlifeinteractive.com/).

## The launcher cannot connect

Some internet providers fail to resolve the server address. Set your DNS to 1.1.1.1 and 8.8.8.8 and try
again. If it still fails, ask for help on the support site.

Other messages you may see:

- "Your session expired. Sign in again." Sign in with Discord again.
- "Too many attempts. Wait a moment and try again." Wait a minute and retry.
- "This sign-in link was not started from this launcher. Click Sign in with Discord again." Start the
  sign-in again from the launcher, in one go.
- "Couldn't open Discord in your browser." Try again.
- "Please update the launcher". Download the latest launcher from the website.

## Login to the game times out

Some other launchers write settings into the game's user config that make the game talk to a local proxy
(an address ending in `:61000`). The game then sends every login there instead of to the server and times
out. When you press Play, the launcher removes only those lines from the config under
`%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient`, keeps a one-time backup of each file it changes and
writes what it did into the session log. It never blocks Play. If login still times out, check the DNS tip
above and send the log (see below).

## The game does not start

Make sure Dauntless is not already open and that your antivirus has not removed any game files, then press
Play again. If the Game files tab says Issues found, press Download runtime DLLs there.

## Install folder problems

- **"This game folder is not the Ramsgate Reborn game".** The server only accepts the Ramsgate Reborn game.
  Copies from Steam, Epic, the old official launcher or Dauntless Revived are refused. Use the download
  button the launcher offers. Nothing in the old folder is touched.
- **The launcher cannot find the game.** Choose the folder it is in now with Locate again, or download it
  again. The right folder is the one that contains `Archon`.
- **"This is the game the launcher downloaded, so its files may be damaged."** Open the Game files tab,
  uninstall, then download the game again.
- **The download did not finish.** Check your connection and free disk space, then press Download game
  again. It picks up where it left off. You need about twice the download size plus 2 GB free while it
  installs.
- **Uninstall.** Game files tab, Uninstall removes the game the launcher installed. You can also delete the
  launcher logs there.

## Play is greyed out after a Dauntless Revived transfer

While your transfer is still being prepared, the launcher keeps Play off, because playing first can cancel it.
Wait until the launcher says it is ready. If it never arrives, use the transfer section on the Game files tab
to ask again.

## Logs and crash dumps

Every time you press Play the launcher keeps a log. Find it with Settings, then Logs, then Open folder or Copy
path. The folder is `%LOCALAPPDATA%\RamsgateReborn\Logs\Sessions`.

- **Upload last session.** Only tester accounts can send logs from the launcher. Everyone else can open the
  folder and attach the files when asking for help. Read them first and remove anything you do not want to
  share.
- **Crash dumps.** When Dauntless crashes it can save a snapshot of its memory. It can hold personal details,
  so it is only sent if you allow it. Settings lets you choose Ask me after a crash, Always send or Never send.
  Sent dumps are deleted after 3 days.

## Reporting it

Launcher bugs: [GitHub issues](https://github.com/Afterlife-Interactive/ramsgate-reborn/issues/new/choose),
with your launcher version (About tab), game version and region. Never post passwords, tokens or login codes.
