# WearDHK Design Hub

Searchable visual gallery of designs across three Google Drive folders, recursively indexed and refreshed every five minutes.

## Run
Node.js 20+ required. Run `npm start` and open `http://localhost:3000`.

## Google Drive connection
Enable the Google Drive API in Google Cloud. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the JSON service account credentials and share all three folders with the service-account email as **Viewer**. Alternatively, configure `GOOGLE_DRIVE_ACCESS_TOKEN` (temporary testing only). Never commit credentials.

## Deployment
Use a Node.js server host such as Render or Railway; GitHub Pages cannot run this server. Set `APP_PASSWORD` to protect access on public deployments, and use HTTPS. Changes to Drive files appear on the next scheduled scan (default 5 minutes). Source folders:

- https://drive.google.com/drive/folders/128JL_dyiO2xFXaRKh4zj8al5w2Y6XoNP
- https://drive.google.com/drive/folders/1QImLRpunvmjkhHc8_CqewTw7u6lqvoLb
- https://drive.google.com/drive/folders/1MPdvOZSFs0uUwS3qYOzY9m5-_61DloDW

The server accesses Drive in read-only mode; it never renames, uploads or deletes designs.
