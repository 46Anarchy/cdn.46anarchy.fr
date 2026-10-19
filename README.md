# CDN Console

A small, self-hosted console for publishing release artifacts and a merged JSON manifest.

# Generative AI disclosure

this application is 100% vibecoded and is in no way reflective of the 46anarchy team's skill. This is a quick and dirty thing we needed for the big thing to properly work.

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

## Directory uploads

The console can upload an entire directory recursively. Choose the model first, then select a directory. Every file is sent in its own request, avoiding a combined request-size limit such as Cloudflare's. Every file is stored beneath that model's destination using its path relative to the selected directory; the selected directory name itself is not included. For example, selecting `mods` uploads `mods/example.jar` to `<model destination>/example.jar`. Each individual file must still be within the proxy's upload limit.
