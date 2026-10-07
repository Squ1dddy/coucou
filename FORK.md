# Beau's Coucou fork

This is my fork of [Louis-CFM/coucou](https://github.com/Louis-CFM/coucou), the
app where Mochi lives at the top of your screen and keeps an eye on your Claude
Code sessions. All credit for the original app goes to Louis. This fork adds to
the Windows (Tauri) version in `windows/`; the Mac app is untouched.

## What this fork adds

**Claude Code sessions**
- One carousel entry per Claude session, named by the chat's title. Double-click
  the name to rename it, and the name survives `/clear`.
- Running subagents and background `claude -p` helpers show as mini Mochis next
  to their parent chat, and the chat stays "busy" until they finish.
- The "finished" card shows the first sentence of Claude's final reply. A turn
  that ran 5+ minutes ends with confetti, a hop and a sound.
- Close a session from the island (X, then confirm). Double-click a session's
  Mochi to jump straight to that chat in the Claude desktop app.
- Plain-English activity lines for what Claude is doing, and plan limit bars.

**Mochi**
- A flat, Claude-orange look. Mochi acts out what it's doing: laptop, thought
  cloud, magnifier, page, terminal. It fidgets when idle and wears a nightcap to
  sleep.
- The compact island is narrower and never auto-hides.

**Integrations**
- Spotify: album art, progress, playback controls and volume, with Mochi
  wearing headphones.
- Google Calendar: the next three days, the next event highlighted, and a
  10-minute heads-up.
- Both sign in with OAuth (PKCE on a loopback port), with a setup wizard for
  creating your own developer apps. Tokens stay in Windows Credential Manager.

## How I built it

I built these features with [Claude Code](https://claude.com/claude-code). I
didn't write the code by hand. My part was deciding what to build, working out
how each feature should look and behave, testing every change on my own setup
and sending it back when it was wrong. A few examples of that loop: the
`/clear` fix failed its first real test because the desktop app sends different
events than I expected, and the helper tracking took three rounds
before background runs grouped under the right chat.

## Install (Windows)

Written so you can follow it yourself, or point Claude Code at this repo and say
"install this".

1. Install the tools (PowerShell, once per machine):

   ```powershell
   winget install --id Git.Git -e
   winget install --id OpenJS.NodeJS.LTS -e
   winget install --id Rustlang.Rustup -e
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   Close and reopen PowerShell afterwards so the new tools are on the PATH.

2. Get the code:

   ```powershell
   git clone https://github.com/Squ1dddy/coucou.git "$env:USERPROFILE\Projects\coucou"
   cd "$env:USERPROFILE\Projects\coucou\windows"
   ```

3. Build the installer (first build takes several minutes):

   ```powershell
   npm install
   npm run pack
   ```

   If the build fails once with a "file in use" error, run `npm run pack` again.

4. Install: run `windows\release\Coucou-Windows-setup.exe`. It installs for
   your user only, no admin prompt. Mochi appears at the top of the screen and
   in the notification area.

5. Connect Claude Code: tray Mochi, **Settings… → Claude Code → Install
   hooks…**. It shows the exact change to `%USERPROFILE%\.claude\settings.json`
   and takes a dated backup before writing.

6. Optional: Spotify and Google Calendar. Open Settings and follow the setup
   wizard. Sign-ins are stored per machine, so connect again on each PC.

## Keeping two PCs in sync

On the PC where you made changes:

```powershell
cd "$env:USERPROFILE\Projects\coucou"
git push
```

On the other PC: quit Coucou from its tray menu, then:

```powershell
cd "$env:USERPROFILE\Projects\coucou"
git pull
cd windows
npm install
npm run pack
```

and run `windows\release\Coucou-Windows-setup.exe` again.

To pick up new work from Louis's original repo:

```powershell
git fetch upstream
git merge upstream/main
```
