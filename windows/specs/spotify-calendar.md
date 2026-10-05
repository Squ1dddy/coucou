# Spec: Claude-orange Mochi, Spotify + Google Calendar connectors

Branch `beau/spotify-calendar` (off `beau/display-swap`). Windows/Linux Tauri app only; the Mac app is untouched.

## Goal
Personal tweaks for Beau's Windows Coucou:
1. Mochi wears Claude orange.
2. GitHub and Resend connectors go.
3. Spotify and Google Calendar connectors come in, signed in with OAuth.
4. Connector bots look like their brand: brand colour plus one small prop.

## Decisions (locked with Beau, 2026-10-05)
- Mochi body: Claude orange gradient (clay `#D97757` family) instead of the grey/white `BASE_TOP`/`BASE_BOTTOM`. The "VS Code" pill (`integration_claude`) goes the same orange.
- Remove `integration_github` and `integration_resend` completely: pollers, cards, settings rows, Credential Manager key names, URL maps, defaults. Stored keys already in Credential Manager are left alone (never delete real data).
- New pill IDs (stable from now on): `integration_spotify`, `integration_gcal`.
- Discord and Gmail: out of scope (no legal Discord API; Gmail needs a Google security review).
- Sign-in: OAuth 2 Authorization Code + PKCE with a loopback redirect (`http://127.0.0.1:<port>/callback`) opened in the default browser. Beau has Spotify Premium, so playback control is in.
- Props show on mini bots and on big Mochi while it shows that connector.

## Behaviour

### Mochi colour
- Big Mochi's default body is an orange gradient (lighter top, deeper bottom, both from the `#D97757` family). Eyes and the rest of the face stay readable.
- When big Mochi shows a connector, it still takes that connector's colour (existing behaviour).
- `integration_claude` pill colour becomes Claude orange.

### Brand bots
| Pill | Body colour | Prop |
|---|---|---|
| Spotify | `#1DB954` | Black headphones over the head |
| Google Calendar | `#4285F4` | Small white calendar page with a red top strip, held/beside the body |

- Props are drawn in code on the existing `BotEngine` canvas (no images), scale with body size, and follow the body's squash/stretch.
- The engine gets an optional accessory field set from the task (e.g. `task.accessory`); tasks without one draw exactly as today.

### Spotify (`integration_spotify`)
- Card: album art (if cheap) or a music icon, song title, artist, progress bar, and prev / play-pause / next buttons. Clicking the title opens the track in Spotify.
- Bot: bobs ("working"-style state) while music plays; idle/sleepy when paused or nothing is playing.
- Polling: `GET /v1/me/player/currently-playing` about every 5 s while the island is visible, about every 30 s when hidden, none when Coucou is paused or Spotify is not connected. 204 (nothing playing) is a normal state, not an error.
- Controls: `PUT /v1/me/player/play|pause`, `POST /v1/me/player/next|previous`. A control refreshes the card right away. No device = friendly "Open Spotify on a device" message.
- Scopes: `user-read-currently-playing user-read-playback-state user-modify-playback-state`.

### Google Calendar (`integration_gcal`)
- Card: today's remaining events (time, title, location if any), soonest first. Clicking an event opens its `htmlLink` in the browser. All-day events show at the top, labelled "All day".
- Heads-up: 10 minutes before an event starts, the bot gets attention once per event (same path as existing integration events: badge, sound, compact reveal, clear after 60 s).
- Polling: `GET /calendar/v3/calendars/primary/events` (timeMin = now, timeMax = end of local day, `singleEvents=true`, `orderBy=startTime`) every 5 min; the 10-minute heads-up runs off a local timer, not a fast poll.
- Scope: `https://www.googleapis.com/auth/calendar.readonly`.

### Sign-in (shared OAuth core, Rust)
- Settings shows the connector's fields (Spotify: Client ID; Google: Client ID + Client secret, since Google desktop clients issue one) and a **Connect** button; once connected, **Disconnect**.
- Connect: Rust starts a one-shot loopback listener on 127.0.0.1 with a random free port, builds the auth URL with PKCE (S256) and a random `state`, opens it via the existing `platform::open_url`. The callback checks `state`, exchanges the code, shows a small "You can close this tab" page, and closes the listener. Times out after 5 min.
- Tokens: refresh token and access token (+ expiry) live in Credential Manager via `secrets.rs`, never on disk, in logs or in the frontend. The access token is refreshed automatically before expiry; a revoked/invalid refresh token flips the card to "Reconnect".
- Disconnect removes only this connector's tokens.
- Redirect URIs: Spotify gets a fixed port, `http://127.0.0.1:43117/callback`, registered exactly (verify against current Spotify docs via context7/web before building; don't rely on dynamic-port matching). Google desktop clients accept any loopback port, so Google uses a random free port.

### Developer app setup (Beau does this once)
A wizard script walks Beau through:
- Spotify dashboard: create app, add redirect URI, copy Client ID.
- Google Cloud console: create project, enable Calendar API, OAuth consent screen (External), add the calendar.readonly scope, create a Desktop client, copy ID + secret, then **Publish app to "In production"** (unverified is fine; click through "Google hasn't verified this app" once). Without publishing, Google kills the sign-in every 7 days.

## Out of scope
Discord, Gmail, playlists/search/queue, writing calendar events, multiple calendars, Mac or iPhone changes.

## Rules that apply (repo CLAUDE.md)
- Never rename existing pill IDs (we only remove two and add two).
- Don't restyle shipped views beyond what's listed here (Beau asked for the colour changes).
- Secrets only in Credential Manager. No telemetry; network calls only to Spotify/Google once Beau connects them.
- 0 % CPU when hidden: slow polling when hidden, nothing when paused; canvases resize on DPR change (existing gotcha).

## Tickets
1. **Mochi + VS Code pill to Claude orange.** `engine.ts` BASE colours, `state.ts` claude pill colour (+ any duplicate in settings/greeting). Small, inline.
2. **Remove GitHub and Resend.** Rust pollers + dispatch, `views/integrations.ts` cards + URLs, `island/integrations.ts` key map, `island.ts` URLs, `settings/main.ts` rows + key list, `state.ts` agents/toggleable/defaults. `cargo check` + `tsc` clean.
3. **Brand accessories in the engine.** `accessory` on `AgentTask` → `BotEngine`; draw headphones and calendar page; mini + big Mochi; register Spotify/Calendar pill entries (colours, toggleable, settings rows) showing "Not connected" cards.
4. **OAuth core + Spotify.** New `oauth.rs` (PKCE, loopback listener, token store/refresh, unit-tested pure parts), Spotify poller with visible/hidden cadence, control commands, card with controls, Connect/Disconnect in Settings.
5. **Google Calendar.** Calendar poller on the OAuth core, card, 10-min heads-up timer, unit tests for "remaining events today" and heads-up timing.
6. **Setup wizard.** Script walking Beau through both developer apps (uses `wizard` skill).

Verify per ticket: `cargo check`, `cargo test` (Rust), `npx tsc --noEmit`, then look at it in the running dev app.
