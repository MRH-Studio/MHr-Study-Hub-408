# GitHub Actions deployment setup

This project deploys as `mrh-study-hub` on host port `1708` (container port `3000`).
It does not stop or modify the existing `n8n` or Portfolio containers.

## Required repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**

Add:

- `MONGODB_URI` — MongoDB connection string (MongoDB continues to store application records and file metadata)
- `MONGODB_DB_NAME` — database name used by this app
- `ADMIN_USERNAME` — production admin username
- `ADMIN_PASSWORD` — strong production admin password
- `ADMIN_SESSION_SECRET` — long random secret
- `STUDENT_SESSION_SECRET` — long random secret

To email student credentials when an admission is approved, add these SMTP secrets:

- `SMTP_HOST` — mail provider SMTP host (for Gmail, `smtp.gmail.com`)
- `SMTP_PORT` — SMTP port (`465` for SSL or `587` for STARTTLS)
- `SMTP_USER` — mailbox username/address
- `SMTP_PASSWORD` — mailbox password or provider app password

The sender address is stored in MongoDB and can be changed in **Admin → Registration & Payment Settings → Student Credential Sender Email**. It defaults to `mrh408520@gmail.com`; the optional `SMTP_FROM` secret is only used to initialize the database setting on a fresh setup. For Gmail, set `SMTP_USER` to the same mailbox and use a Google App Password as `SMTP_PASSWORD` (enable 2-Step Verification first; do not use your regular account password). The SMTP settings are needed before approving admissions. If mail is not configured or delivery fails, approval is not completed. The generated password is emailed to the student, and only its salted hash is stored in MongoDB.

Generate independent random values on a trusted machine with:

```bash
openssl rand -hex 32
```

Do not commit `.env` files or put secret values directly in the workflow.

## Persistent server file storage

Uploaded file contents are stored only in `/home/mrh123/data/Project-1/`. GitHub Actions verifies that the existing folders are present, prepares their permissions for the container's `1001:1001` user, and bind-mounts the host directory at the same path inside the container. It does not create or alter the directory structure.

```text
/home/mrh123/data/Project-1/
├── courses/
│   ├── Basic of Computer/
│   ├── Basic of C Programming/
│   ├── Basic of Microsoft Excel/
│   ├── Basic of Microsoft PowerPoint/
│   ├── Basic of Microsoft Word/
│   ├── Basic of Power BI/
│   ├── Basic of Python/
│   └── Basic of SQL/
├── Payments/
└── Recipt/
```

- MongoDB course records are mapped to their existing named course directories; unknown courses are rejected rather than creating a new course directory. Course videos are grouped below the mapped directory by module.
- Admission payment-proof images are saved under `Payments/` and are only served to an authenticated admin.
- The current payment QR is saved under `Payments/payment-qr/`; replacing it removes the previous local QR file after the new one is saved.
- Receipt files belong under the existing `Recipt/` directory.
- MongoDB stores records and the relative storage paths/URLs; uploaded file bytes remain on this server.
- Back up `/home/mrh123/data/Project-1/` separately from MongoDB. Do not delete or relocate it during a deployment.
- Video uploads are streamed directly to disk. When using Nginx in front of the app, configure a suitable request size and disable request buffering for the app location, for example:

```nginx
client_max_body_size 2g;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

## Existing files

Previously stored external file links are not automatically copied to the server. Re-upload those files through the Admin Panel where supported. Existing external copies are not modified.

## Deployment

Push the files to the repository's `main` branch. GitHub Actions builds the Next.js standalone image and runs it on port `1708`.

Test on the server:

```bash
docker ps
curl -I http://localhost:1708
docker logs --tail 50 mrh-study-hub
```

Verify the mounted host directory with:

```bash
sudo find /home/mrh123/data/Project-1 -maxdepth 4 -type d -print
```

The health endpoint used by the workflow is `/api/admin` (GET).
