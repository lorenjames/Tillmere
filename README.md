# Middletons POS

Electron-based point of sale for Middleton's Antiques & Uniques.

## Project Layout

- HTML views at repo root: `index.html`, `vendors.html`, `cashiers.html`, `receipts.html`, `reports.html`, `settings.html`
- Renderer scripts under `js/`: `renderer.js`, `vendors.js`, `cashiers.js`, `receipts.js`, `reports.js`, `settings.js`
- Main process: `main.js`
- Static assets: `assets/` (images), `css/` (Bootstrap)
- Build output: `dist/` (created by electron-builder)

Planned tidy-up (optional):
- Optionally move views into a `views/` folder and update `mainWindow.loadFile('index.html')` if paths change

## Setup

- Install dependencies: `npm install`
- Start in dev: `npm start`
- Build Windows installer: `npm run build:win`
  - Output: `dist/` (installer exe and unpacked build)

## Data Locations

- Primary user data directory: `%APPDATA%/middletons-pos/`
  - `vendors.json`
  - `cashiers.json`
  - `settings.json`
  - `receipts.sqlite3` (embedded SQLite store for receipts; `receipts.json` is retained only for legacy fallbacks)

The receipts database uses `better-sqlite3`, so install it locally with `npm install better-sqlite3` before running the app.

## Pushing to GitHub

Replace the remote URL with SSH if you prefer. Run these from the project root (where `package.json` lives):

```bash
# initialize (if not already a repo)
git init

# make an initial commit (if first time)
git add .
git commit -m "Initial import of Middletons POS"

# set default branch
git branch -M main

# set remote (HTTPS)
git remote add origin https://github.com/lorenjames/Middletons.git
# or, if already set but pointing elsewhere:
# git remote set-url origin https://github.com/lorenjames/Middletons.git

# push
git push -u origin main
```

If you use SSH, swap the remote line for:

```bash
git remote add origin git@github.com:lorenjames/Middletons.git
```

## Packaging Notes

- electron-builder is configured in `package.json` (NSIS target).
- App icon uses `assets/MiddletonsQuiltLogo.png` for windows and splash. For a fully branded installer icon, convert to `.ico` and update `build.win.icon` in `package.json`.

## License

Internal project (no license specified).
