# GitHub Actions deployment setup

This project deploys as `mrh-study-hub` on host port `1708` (container port `3000`).
It does not stop or modify the existing `n8n` or Portfolio containers.

## Required repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**

Add:

- `MONGODB_URI` — MongoDB connection string
- `MONGODB_DB_NAME` — database name used by this app
- `ADMIN_USERNAME` — production admin username
- `ADMIN_PASSWORD` — strong production admin password
- `ADMIN_SESSION_SECRET` — long random secret
- `STUDENT_SESSION_SECRET` — long random secret

Generate independent random values on a trusted machine with:

```bash
openssl rand -hex 32
```

Do not commit `.env` files or put secret values directly in the workflow.

## Optional Google Drive secrets

If the app's Google Drive upload feature is used, also add:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_FOLDER_ID`

## Deployment

Push the files to the repository's `main` branch. GitHub Actions builds the Next.js standalone image and runs it on port `1708`.

Test on the server:

```bash
docker ps
curl -I http://localhost:1708
docker logs --tail 50 mrh-study-hub
```

The health endpoint used by the workflow is `/api/admin` (GET).
