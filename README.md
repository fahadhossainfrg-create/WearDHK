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

## Verified design title edits

Changing the catalogue display title requires a six-digit email OTP. Configure the following environment variables on the Render web service:

- `TITLE_APPROVAL_EMAIL`: the administrator inbox that receives codes.
- `OTP_FROM_EMAIL`: a verified sender address accepted by Resend.
- `RESEND_API_KEY`: server-side Resend API key, never exposed to frontend code.
- `OTP_SECRET`: a long random secret used to hash verification codes.

Codes expire after ten minutes. Requests are limited per IP address and per design; only confirmed titles are applied. If these variables are missing, title changes are disabled (fail closed). The underlying Google Drive filename is not changed. Current verified titles are saved in `verified-titles.json` on the Render instance, **which is not durable across instance replacements unless backed by persistent storage**. Configure persistence before relying on edits long term.
