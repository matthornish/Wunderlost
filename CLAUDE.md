# Wunderlost — repo conventions

Self-hosted, Wunderlist-style to-do app. Node + Express server (`server.js`, `db.js`, `recur.js`) with SQLite via `better-sqlite3`, serving a vanilla JS client (`public/index.html`, `public/app.js`, `public/style.css`) that installs as an app (`public/manifest.webmanifest`, service worker in `public/sw.js`). Live sync uses Server-Sent Events (`/api/events`); reminders use Web Push (`web-push`). The server listens on port 3000 (`PORT` env var overrides); data lives in `DATA_DIR` (`/data` in the container).

## How changes get made

- Never commit or push directly to `main`. Every change goes on a short-lived branch and into `main` through a pull request. The owner reviews and merges (squash merge only).
- Branch names: short and descriptive, e.g. `fix/push-resync`, `feat/list-colors`, `chore/deps-update`.
- One logical change per PR. Keep PRs small enough to review on a phone.

## Commit messages (Conventional Commits — required)

Versions and the changelog are generated from commit messages (PR titles, since PRs are squash-merged), so the prefix matters:

- `fix:` bug fix → patch release (1.0.0 → 1.0.1)
- `feat:` new user-facing feature → minor release (1.0.0 → 1.1.0)
- `feat!:` or a `BREAKING CHANGE:` footer → major release (1.0.0 → 2.0.0). Use only when existing deployments would break (e.g. a required config change or a DB change that can't migrate itself).
- No release: `chore:` (tooling, deps housekeeping), `docs:`, `refactor:`, `style:`, `test:`, `ci:`

Format: `type: short imperative summary` (lowercase, no period). Add a body when the why isn't obvious.

## Versioning and releases

- Handled by release-please (`.github/workflows/release-please.yml`). It keeps a "Release PR" open; merging it bumps the version, updates `CHANGELOG.md`, tags `vX.Y.Z`, and publishes a GitHub Release.
- Do NOT hand-edit the `version` in `package.json`, `.release-please-manifest.json`, or `CHANGELOG.md`.
- Do NOT create tags or releases manually.

## Deployment

- When release-please creates a release, `.github/workflows/docker-publish.yml` builds the image and pushes it to `ghcr.io/matthornish/wunderlost` with tags `latest`, `X.Y.Z`, `X.Y`, and `X`. It can also be run by hand from the Actions tab for an existing tag.
- Production runs on an Unraid server from that image, managed in the Unraid Docker tab (container runs as `99:100`, data in `/mnt/user/appdata/wunderlost`). Updates are applied there with Apply Update. Nothing is built on the server.
- The Dockerfile is the source of truth for the runtime image. Changes to it ship with the next release.

## Code guidelines

- No test suite exists yet. Describe in the PR how a change was verified.
- Every `/api` route that touches a list, task or subtask must go through `requireMember` / `requireTask` / `requireSub` so users can only reach lists they belong to. Never trust client-sent IDs.
- Preserve the existing hardening: mutating API calls must be `application/json` (CSRF guard), login rate limiting, bcrypt password hashes, HttpOnly + SameSite session cookies, input length limits via `str()`.
- Schema changes go in `db.js` and must be additive and safe to run against an existing database (`CREATE ... IF NOT EXISTS`, guarded `ALTER TABLE`). Users' data must survive an image update.
- After any write to lists, tasks, subtasks or members, call `notifyList` / `notifyUsers` so other devices refresh.
- Keep `package-lock.json` in sync with `package.json` (`npm install`, commit both).
- The service worker cache version is injected by `server.js` at startup (`__CACHE_VERSION__` placeholder in `public/sw.js`), so every redeploy makes clients fetch fresh assets. Don't hardcode it. New files that should work offline go in `STATIC_ASSETS` in `public/sw.js`.
