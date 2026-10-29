# Lekhira Writes

The free web writing editor from Lekhira: accounts, cloud saving and the essential tools for writing a book. Lekhira Studio (the desktop app in the folder above) is the premium flagship. Writes points to it for typeset pages, the Craft coach, Story Atlas and publishing.

## Run it locally

Needs Node 22.13 or newer (it uses Node's built-in SQLite). There are no packages to install.

- **Easiest:** double-click `Start Lekhira Writes.cmd` in this folder. The browser opens once the server is ready. Close the window to stop it.
- **From the repo root** (`Puran Studio`):

```bash
npm run writes
```

- **From this folder**, with auto-restart while you edit server code:

```bash
npm run dev
```

Open http://localhost:4310. If it says port 4310 is already in use, Lekhira Writes is probably already running, so just open that address. The database is created at `data/lekhira-writes.db`; delete the `data` folder to start fresh.

## GitHub Pages preview
GitHub Pages can only serve files; it can't run the server or the database. So every push to `main` publishes a **browser-only preview**: the same pages and editor, with the server replaced by `pages/preview-api.js`, which keeps accounts and books in that browser's storage. A "Preview" note says so on every page. Use it to show and try the app, not for real accounts.

- **Live at:** https://haitish-astro.github.io/LekhiraWrites/
- **One-time setup:** on GitHub, open the repo's Settings → Pages → Build and deployment → Source, and choose **GitHub Actions**. Then re-run the "Publish preview to GitHub Pages" workflow (Actions tab), or push again.
- **Build and check it locally:**

```bash
npm run pages
```

```bash
node pages/serve.js
```

Then open http://localhost:4320/LekhiraWrites/. The workflow runs `npm test` before publishing, so a failing test stops the deploy.

## Same feel as Lekhira Studio
The app (`/app`) uses Studio's colour tokens, fonts, layout and wording:
- the title bar, library, sidebar, toolbar, page and status bar;
- the writing room: Charcoal, Ink, Sepia, Paper and Warm pages, installed fonts, sizes in pt, line spacing, Indent or Spaced paragraphs, Ragged or Justified;
- the styles Body text, Heading, Subheading, Subtitle and Quote (Ctrl 0–4), and Studio's shortcut map.

Browsers keep Ctrl N and Ctrl PgUp / PgDn for themselves, so Writes uses Ctrl Alt N and Alt PgUp / PgDn for those two.

The code follows Studio's conventions too: `public/js/util.js` mirrors `src/util.js` (`$`, `$$`, `ICONS`, `paintIcons`, `modal`, `toast`, `showMenu`, the font list), and `app.js` keeps Studio's constants and global key handler. One deliberate difference: Writes builds anything that contains a writer's text with `el()` and text nodes, never `innerHTML`. The public pages (home, sign-in) keep the pitch deck's brand look.

```bash
npm test
```

`npm test` starts a throwaway server and checks the API and its security rules (24 checks).

## What's in the free version
- Library of books with typographic covers, a trash and restore.
- Chapters: add, rename, drag to reorder, status (Idea / Drafting / Revising / Done).
- Editor: Body, Heading, Subheading, Quote, scene breaks, bold / italic / underline, smart punctuation, typewriter scrolling.
- Writing room: Charcoal, Ink, Sepia and Paper pages, four typefaces, size and line width. Focus mode.
- Autosave about a second after typing stops. If the network drops, text is kept on the device and offered back later.
- Two tabs or devices editing one chapter can't overwrite each other: the writer chooses which version to keep, and the other goes into history.
- Version history for each chapter (the last 30), with preview and restore.
- Daily goal, streak, a four-week chart and a word goal for each book.
- Export to Markdown (which Studio imports with chapters intact), plain text, print / save as PDF, and a full account export in JSON.
- Account: change name and password, see your sessions, sign out other devices, delete your account.

## Security
- **Passwords:** scrypt with a per-user salt; at least 10 characters, and common passwords are refused. A failed sign-in takes the same time whether or not the email exists, and gives the same message.
- **Sessions:** 256-bit random tokens. Only their SHA-256 hash is stored. The cookie is `HttpOnly` and `SameSite=Strict`, and in production it is `Secure` with the `__Host-` prefix. Sessions expire after 30 days without use, and changing the password ends every other session.
- **Request forgery:** every change must come from our own origin and carry the `X-Lekhira` header, and the body must be JSON.
- **Rate limits:** sign-in by network and by account, sign-up, password checks, saves, exports and the API overall.
- **Who can see what:** every query is scoped to the signed-in writer. Other people's ids return the same 404 as ids that don't exist.
- **No stored markup:** chapters are saved as structured blocks of plain text (`server/doc.js`), never as HTML. The page rebuilds them with text nodes, and paste and drop insert plain text only.
- **Headers:** a strict Content Security Policy (no inline scripts or styles, no frames, `connect-src 'self'`), plus `nosniff`, `DENY` framing, COOP/CORP, a Permissions-Policy, and HSTS in production. The `Host` header is checked to block DNS rebinding.
- **Limits:** caps on request size and timeouts, the number of books and chapters, and chapter length. Static files come only from known folders and file types.
- **No third-party code** on the server, and none in the browser apart from Google Fonts.

## Configuration
| Variable | Default | |
|---|---|---|
| `PORT` | `4310` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` behind a proxy |
| `PUBLIC_ORIGIN` | `http://localhost:PORT` | Must be `https://` in production |
| `NODE_ENV` | | `production` turns on Secure cookies and HSTS |
| `DATA_DIR` | `./data` | |
| `TRUST_PROXY` | | `1` behind a reverse proxy that sets `X-Forwarded-For` |

## Before it goes public
1. **HTTPS hosting** behind a reverse proxy (Caddy or nginx), with `NODE_ENV=production`, plus daily encrypted backups of `data/`.
2. **Email:** verify addresses, add password reset, and tell writers about new sign-ins. Sign-up currently says when an email is already registered; once verification exists it should send an email instead.
3. **Shared rate limits** (for example Redis) if it runs on more than one server.
4. **Self-host the fonts**, so no request goes to Google.
5. **Legal:** have a lawyer review `/legal`, which is marked as a draft.
6. **Sync with Studio:** the block format (with stable block ids and a schema version) is designed so Studio's account sync can share it.
