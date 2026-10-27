# Monopoly Deal Tally

A two-player Monopoly Deal win tracker that works offline. It is a plain static web app (no build step) served by GitHub Pages.

**Open it:** https://fynhav.github.io/monoploy-deal/

## Put it on your iPhone

1. Open the link above in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open it once with a connection. After that it works with no signal at all.

## Where your games are kept

- Games and names are saved **on the device**, in the browser's storage. Nothing is sent anywhere.
- Each device keeps its own record. They do not sync with each other.
- Use **Back up** (bottom of the page) now and then. It saves a small `.json` file. **Restore** reads one back and adds only games the device does not already have, so restoring twice never duplicates anything.
- Installing it to the Home Screen helps iOS keep the data. Clearing Safari's website data would remove it, so keep a backup.

## First run

`seed.json` holds the games from the earlier shared version of the page. The first time the app opens on a device that has no data, it loads them once. After you have opened the app on your devices you can delete `seed.json`; the app works fine without it. (The repo is public, so anyone can read that file.)

## Updating

Edit the files and push. Devices pick up the new version the next time they open the app with a connection (the first launch may still show the old copy, the next shows the new one). To force every device to drop its old copy, change `VERSION` at the top of `sw.js`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: page, styles and logic |
| `sw.js` | Offline cache (service worker) |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon |
| `fonts/` | Bricolage Grotesque and Instrument Sans, bundled so the app needs no network. Both are under the SIL Open Font License (see the licence files) |
| `seed.json` | Optional first-run import of existing games |
