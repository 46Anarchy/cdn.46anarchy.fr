# Admin CDN

Remarque : ce README est vibecoded et susceptible d'être modifié.

Application simple Svelte + Express pour gérer les téléversements de fichiers et publier un manifeste combiné.

## Fonctionnalités
- Téléverser des fichiers et gérer les métadonnées
- Créer des modèles (`name`, `version`, `description`, `dest`, `os`)
- Servir les fichiers sous `/files/...`
- Fournir `/manifest.json` en fusionnant le manifeste distant avec les modèles et fichiers locaux
- Connexion administrateur via mot de passe dans `.env`
- Support mode clair/sombre avec préférence du navigateur et bascule

## Configuration
1. Copier `.env.example` en `.env`
2. Définir `ADMIN_PASSWORD`
3. Exécuter `npm install`
4. Exécuter `npm run build`
5. Démarrer l'application avec `npm start`

## Docker
- `docker-compose up --build`
- Les données sont stockées dans `./files` et montées sur `/app/files` dans le conteneur
- Le conteneur utilise `restart: unless-stopped`

## API
- `POST /api/login` `{ password }`
- `POST /api/logout`
- `GET /api/models`
- `POST /api/models`
- `GET /api/files`
- `POST /api/files` (upload multipart)
- `GET /manifest.json`

## Remarques
- Le manifeste CDN distant est mis en cache sur le disque dans le volume de stockage et est rafraîchi toutes les 10 minutes.
- Si `.env` ne définit pas `ADMIN_PASSWORD`, le serveur se termine immédiatement.
- Les accès API non authentifiés renvoient des erreurs JSON.
