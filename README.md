# Monopoly Deal Tally

A two-player Monopoly Deal win tracker with levels and XP. One shared game history, a PIN login for each player, and it keeps working with no signal.

## How it fits together

- `server/` is a small Node server with no dependencies. It stores games and PINs in SQLite on a Railway volume and serves the app from `server/public/`, so everything lives at one address.
- Each player picks their name and chooses a PIN the first time they open the app on a phone. After that the phone stays signed in (a year-long, rolling cookie).
- Games are saved on the phone first and sent to the server when there is a connection, so the app works offline. The two phones pick up each other's games within a few seconds.
- XP and levels are worked out from the shared game list, not stored. Changing the formula changes everyone's levels retroactively.

## Screens

A tab bar at the bottom switches between four pages: Overview (scoreboard and series), The Lead (line graph of the lead over time), Levels (progress rings, the road to Tycoon, a level-up celebration) and Game log.

## XP and levels

- 10 XP each for playing a game, win or lose.
- 5 XP extra for the winner.
- Win streak bonus on each win: 2 in a row +5, 3 in a row +10, 4 or more +15.
- Levels: Pawn 0, Top Hat 100, Boot 250, Thimble 450, Wheelbarrow 700, Landlord 1,000, Developer 1,400, Magnate 1,900, Mogul 2,500, Tycoon 3,200.

The formula lives at the top of the logic block in `server/public/index.html` (`XP_PLAY`, `XP_WIN`, `streakBonus`, `LEVELS`).

## Railway setup

- Service root directory: `/server`. Start command: `npm start`. Health check: `/health`.
- Volume mounted at `/data` (the server uses `RAILWAY_VOLUME_MOUNT_PATH` automatically, or `DATA_DIR`).
- Variables: `PIN_PEPPER` (a long random string; PINs are hashed with it, so keep it if you move the data).
- Forgot a PIN: set `RESET_PIN` to the player's name (or `all`), redeploy, choose a new PIN in the app, then delete the variable.
- `seed.json` loads the first 59 games once, when the database is first created. Changing it later does nothing.
- `server/import.json` (`{"games": [{id, w, at}]}`) adds missing games once per distinct file, on the next start. Existing games are never touched or removed.

## Run it locally

```
cd server
node server.js        # needs Node 22.13 or newer; http://localhost:3000
```

## The old version

The files at the top of this repo (`index.html`, `sw.js`, `fonts/`, ...) are the earlier on-device version served by GitHub Pages. It keeps its own separate data and is no longer updated.
