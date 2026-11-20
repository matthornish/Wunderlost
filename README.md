# Wunderlost

Self-hosted, Wunderlist-style to-do app. One Docker container, one SQLite file. Named for what Microsoft did to Wunderlist (and is now doing to To Do). Not affiliated with Microsoft or Wunderlist.

**Features:** Inbox + custom lists · smart lists (Assigned to me, Starred, Today, Week) · search · subtasks · notes · due dates · reminders with push notifications · repeating tasks (daily / weekdays / weekly / every 2 weeks / monthly / yearly) · shared lists with live sync between users · assign tasks to list members · drag to reorder tasks and lists, drag a task onto a list to move it · completion "ding" · background themes · installable PWA on phone and desktop · multi-user with an admin user screen.

## Gotchas first

- **HTTPS is required** for "Add to Home Screen" as a real app and for push notifications. Plain `http://tower:3000` works for basic use from a desktop browser, but reminders won't push. Put it behind your reverse proxy (Nginx Proxy Manager, SWAG, Caddy, Traefik) with a real certificate.
- **iPhone/iPad push** only works when the app is opened from the Home Screen icon (iOS 16.4+), and needs a publicly trusted cert. A self-signed cert won't work.
- **`VAPID_SUBJECT` must be a real-looking `mailto:`** (not `@localhost`), or Apple's push service rejects every notification.
- **Set `TZ`.** "Today", overdue, and repeat math use the container's timezone.
- **Appdata permissions:** the container runs as `99:100` (nobody:users). Create the appdata folder with that owner *before* first start, or SQLite can't write.
- **The first account you create becomes admin**, and registration closes after that. Add other people from Settings → Manage users. Set `ALLOW_REGISTRATION=true` if you want open sign-up.
- **Reverse proxy and live sync:** live updates use Server-Sent Events on `/api/events`. Most proxies pass it through fine. If shared-list changes only show up after a refresh, turn off response buffering for that path.

## Install on Unraid

Copy this folder to the server, for example `/mnt/user/appdata/wunderlost-src`. Then run these from the Unraid terminal:

```
mkdir -p /mnt/user/appdata/wunderlost && chown 99:100 /mnt/user/appdata/wunderlost
```
```
cd /mnt/user/appdata/wunderlost-src && docker build -t wunderlost:latest .
```

**Option A: Compose Manager plugin.** Edit `docker-compose.yml` (TZ, VAPID_SUBJECT, port), then `docker compose up -d` from that folder.

**Option B: plain docker run:**
```
docker run -d --name wunderlost --restart unless-stopped --user 99:100 -p 3000:3000 -e TZ=America/New_York -e VAPID_SUBJECT=mailto:you@yourdomain.com -v /mnt/user/appdata/wunderlost:/data wunderlost:latest
```

Open `http://<unraid-ip>:3000`, create your admin account, then point your reverse proxy at it.

## Updating

```
cd /mnt/user/appdata/wunderlost-src && docker build -t wunderlost:latest . && docker rm -f wunderlost
```
Then re-run the `docker run` line (or `docker compose up -d`). Your data lives in `/mnt/user/appdata/wunderlost` and survives rebuilds.

## Backup

Everything is in `/mnt/user/appdata/wunderlost` (`wunderlost.db` plus `-wal`/`-shm` files). Copy the folder while the container is stopped, or include it in your appdata backup. The push-notification keys are stored in the DB, so restoring it keeps existing phone subscriptions working.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `TZ` | system | e.g. `America/New_York` |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | contact address sent to push services |
| `ALLOW_REGISTRATION` | `false` | open sign-up after the first (admin) account |
| `SESSION_DAYS` | `90` | how long a login lasts |
| `PORT` | `3000` | |
| `DATA_DIR` | `/data` | |

## How a few things behave

- **Repeating tasks:** checking one off rolls it to the next due date (and moves the reminder by the same amount) instead of creating a copy. Subtasks reset. If you're late, it jumps to the next future date instead of leaving a pile of overdue copies.
- **Reminders** are checked every 20 seconds. On a shared list an unassigned task pings every member; an assigned task pings only the assignee. Each device has to turn on notifications once (Settings → Notifications).
- **Deleting a list** you own deletes it for everyone. On a list someone shared with you, the same menu item reads "Leave list".

## Dev

```
npm install && npm start
```
Stack: Node 22, Express 5, better-sqlite3, web-push, plain HTML/CSS/JS front end (no build step).
