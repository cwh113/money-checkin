# Money check-in
Static, single-page household money dashboard. All data stays in the browser (localStorage). No build step.
Syncs from YNAB with a personal access token stored only on the device. Do not commit exports, tokens, or backups.

Pay stub reading uses pdf.js (Apache-2.0), bundled locally in pdf.min.js and pdf.worker.min.js.

Optional device sync (Update tab, Sync between devices): settings and the YNAB snapshot are encrypted in the browser (PBKDF2-SHA256, 310,000 iterations, AES-256-GCM) with a passphrase and stored as one file in a secret GitHub Gist. Only ciphertext leaves the device. The GitHub token (Gists read/write only) and passphrase are kept in localStorage on each device, like the YNAB token, and are never synced.

Updates: installed copies (such as an iPhone home-screen icon) check for a newer version when opened and reload themselves. Bump `APP_VERSION` in index.html with every change so they notice.
