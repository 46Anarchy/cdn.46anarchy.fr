# CDN Console

A small, self-hosted console for publishing release artifacts and a merged JSON manifest.

## Run it

```sh
cp .env.example .env
# Set a strong ADMIN_PASSWORD in .env
npm ci
npm run build
npm start
```

The application requires Node.js 20 or newer. Docker is the simplest production option:

```sh
docker compose up --build -d
```

The web console is available at `http://localhost:8080`. The public manifest is at `/manifest.json`; uploaded assets are available below `/files/`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Password for the console. |
| `PORT` | no | HTTP port; defaults to `8080`. |
| `STORAGE_ROOT` | no | Persistent files and catalog location; defaults to `./files`. |
| `MANIFEST_BASE_URL` | no | Public URL to use in manifest file links. |
| `REMOTE_MANIFEST_URL` | no | Upstream manifest; defaults to the Paladium CDN manifest. |
| `MAX_UPLOAD_BYTES` | no | Upload limit; defaults to 1 GiB. |
| `AUTH_SESSION_DAYS` | no | Remembered-login duration; defaults to 30 days and renews while in use. |
| `SESSION_SECRET` | no | Extra secret for login cookies; changing it signs every user out. |

The local catalog is atomically written to `catalog.json` inside `STORAGE_ROOT`. Keep that directory mounted as a persistent volume.
