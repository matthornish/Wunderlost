# Security

Wunderlost is a hobby project, built mostly with an AI coding assistant and provided as-is with no warranty (see [LICENSE](LICENSE) sections 15–16). There is no bug bounty and no guaranteed response time, but security reports are welcome and will be taken seriously.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead:

**[Report a vulnerability](https://github.com/matthornish/Wunderlost/security/advisories/new)** (Security tab → Report a vulnerability)

Include what you found, how to reproduce it, and which version (Settings shows it at the bottom). Fixes ship as a new release and image tag; the release notes will credit you unless you'd rather not be named.

## Supported versions

Only the latest release gets fixes. Keep your image on `latest` (or the newest version tag) and update when a release comes out.

## Hardening checklist for self-hosters

- Serve it only over HTTPS, behind a reverse proxy with a real certificate.
- Leave `ALLOW_REGISTRATION` off unless you really want strangers creating accounts.
- Create the admin account immediately after first start — until then, whoever opens the page first becomes admin.
- Keep the data folder out of web-served paths and back it up; it contains the database and push keys.
- Don't store secrets or sensitive personal data in to-dos or notes.
