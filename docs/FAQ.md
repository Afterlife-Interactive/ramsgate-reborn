# FAQ

Back to the [README](../README.md). Troubleshooting is on its own page: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## About the project

**What is Ramsgate Reborn?**
A community server for Dauntless 1.12.0, the free co-op monster hunting game whose official servers shut down
on 30 May 2025, with its own launcher. This repository is the launcher.

**Is it official?**
No. It is an independent fan project. It is not affiliated with Phoenix Labs, Epic Games or Forte Labs.

**Who runs it?**
ZFXSTATIC at Afterlife Interactive LLC. It started from Undaunted by gwog (Gregory Morford) and contributors
and Mystic Paradox by Pranav Karande, see [NOTICE.md](../NOTICE.md).

**Is the code open?**
The launcher source is in this repository under AGPL-3.0. The game server and the game files are not.

**Where does funding go?**
Patreon supports Ramsgate Reborn and Dauntless Revived only. Details are on the
[website](https://afterlifeinteractive.com/mission.html).

## Getting started

**What do I need?**
Windows 10 or 11 (64-bit), a Discord account and about 34 GB of free disk space while the game installs. The
launcher is about 50 MB and the game about 16 GB.

**Do I need to own Dauntless already?**
No. The launcher can download the game. If you already have the Ramsgate Reborn game folder, you can point the
launcher at it (the folder that contains `Archon`).

**How do I sign in?**
With Discord. There is no separate password. New accounts do not need approval.

**Does it work on Linux or macOS?**
We only publish a Windows 10/11 64-bit launcher.

**Why does Windows warn me about the installer?**
The installer is not code-signed yet. SmartScreen may show a warning. Click More info, then Run anyway.

**How do I check my download?**
Compare the SHA-256 of the file with the hash in the release notes. In PowerShell:

```powershell
Get-FileHash .\RamsgateReborn-main-0.2.50-setup.exe -Algorithm SHA256
```

Use the name of the file you downloaded. The two hashes must match exactly.

**Does the launcher need admin rights?**
No. It installs for your user.

**Where do I start the game?**
From the launcher, with Play.

## Playing

**Where are the servers?**
The main server is in London, UK. Hunt servers run from London, New York, Canada, Singapore and Oceania.
Latency rises the further you are from the nearest hunt server.

**Can I see whether the servers are up?**
Yes. The Play tab shows whether the servers are reachable and how many players are online.

**What is offline mode?**
A separate local copy on your PC with its own save. It never connects to the online servers. The only thing
that can come from your online account is a read-only copy of your save, which you load yourself. Nothing
done offline can be moved to your online account.

**What are the hour badges?**
The Account tab counts your online hours and shows badges at 1, 10, 25, 50, 100, 250, 500, 750 and 1000 hours.

**Can I change the language?**
Settings has a game language setting. Leave it on the game default if you are not sure.

**How do I start over?**
Account tab, Reset my save data. You close the game, read the warning and type `RESET`. It can be done once
every 24 hours. A backup of the old save is kept for 30 days and only staff can restore it, only if you ask.

## Dauntless Revived

**I played Dauntless Revived. Do I start over?**
No. Keep Dauntless Revived installed and sign in. The launcher reads your Revived account key and transfers
your inventory, loadout, wallet, appearance, weapon levels and Escalation progress.

**When can I transfer?**
Only before you start playing for real on Ramsgate Reborn: finishing a hunt, earning XP or currency, or getting
items. Do not play until the launcher says the transfer is ready. Waiting is safe. If you play first, your
transfer can be cancelled.

**Something did not arrive.**
The Game files tab has a Dauntless Revived transfer section where you can ask for it again. Close the game
first.

## Help

**How do I report a bug?**
Launcher bugs: [GitHub issues](https://github.com/Afterlife-Interactive/ramsgate-reborn/issues/new/choose).
Please include your launcher version, game version and region. Account and game help:
[support site](https://support.afterlifeinteractive.com/). Never post passwords, tokens or login codes.

**I found a security problem.**
Report it privately through the support site, see [SECURITY.md](../SECURITY.md).
