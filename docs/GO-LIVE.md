# Going live: the real Lekhira account server

Today writes.lekhira.com is the **preview**: it keeps accounts only in each visitor's browser. Going live puts the real server online, so accounts and books are saved in the cloud:

| Piece | Service | Job |
|---|---|---|
| DNS | **Cloudflare** | Where lekhira.com's addresses point (moved from Squarespace) |
| Server (this repo's code) | **Render** | Runs `server/` at api.lekhira.com, and later writes.lekhira.com |
| Database | **Supabase** (West US, Oregon) | Accounts, books, chapters, history (Postgres) |
| Email | **Resend** | Confirmation, password reset and sign-in alert emails |

Squarespace stays where you *bought* the domain (you renew it there); Cloudflare just answers for its addresses.

**Golden rule:** passwords, keys and connection strings go only into Render's dashboard, never into GitHub, chat or email. Turn on two-step sign-in for every one of these accounts.

---

## 1. Cloudflare: move the DNS (do this first)

1. Cloudflare → **Add a domain** → `lekhira.com` → **Free** plan.
2. Cloudflare copies the records it finds at Squarespace. Check the list has the **`writes` CNAME → `haitish-astro.github.io`** and the GitHub verification **TXT** record. Add anything missing (compare with Squarespace → Domains → lekhira.com → DNS).
3. Set the `writes` record to **DNS only** (grey cloud). GitHub Pages needs to reach visitors directly to keep its HTTPS certificate.
4. Cloudflare shows **two nameservers** (like `ada.ns.cloudflare.com`). In **Squarespace → Domains → lekhira.com → DNS → Domain nameservers → Use custom nameservers**, replace Squarespace's with those two.
5. Wait for Cloudflare's email saying lekhira.com is **Active** (minutes to a few hours). writes.lekhira.com keeps working throughout.
6. Recommended: **SSL/TLS → Overview → Full (strict)**, and **SSL/TLS → Edge Certificates → Always Use HTTPS: on**.

From here on, every "DNS record" below is added in **Cloudflare → lekhira.com → DNS → Records**.

## 2. Supabase: the database

1. Your project is in **West US (Oregon)**, and [render.yaml](../render.yaml) already puts the server in Render's Oregon region next to it.
2. Click **Connect** (top of the project). Under **Session pooler**, copy the connection string. It looks like
   `postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password you chose when you made the project. (Forgotten it? Database Settings → Reset database password.) This whole line is the `DATABASE_URL` secret.
3. **Database Settings → SSL Configuration → Download certificate.** Open the file in Notepad; its whole text (from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`) is the `DATABASE_CA` secret. It lets the server check it's really talking to Supabase.
4. Nothing else: the server creates its tables on first start and locks them against Supabase's public Data API (row-level security). Supabase's own login (Auth) isn't used; ours is.

> The free plan pauses a project after about a week with no activity, and has no daily backups. Before real writers arrive, upgrade to **Pro**.

## 3. Resend: email

1. **Domains → Add domain →** `lekhira.com`.
2. Resend lists a few DNS records (an MX and TXT records for sending, plus DKIM). Resend can add them to Cloudflare for you (**Auto configure**), or add each one by hand exactly as shown, all **DNS only**. Then click **Verify** in Resend.
3. Add a DMARC record too: type **TXT**, name `_dmarc`, content `v=DMARC1; p=none; rua=mailto:YOUR-EMAIL`. This helps emails land in inboxes instead of spam.
4. **API Keys → Create:** permission **Sending access**, domain **lekhira.com**. Copy it once: it's the `RESEND_API_KEY` secret.

Not ready yet? You can still deploy: set `EMAIL_PROVIDER` to `outbox` in Render for now. Emails won't be delivered (so no confirmations or resets) until you switch it back to `resend` with a key.

## 4. Render: the server

1. Render → **New → Blueprint** → choose the **LekhiraWrites** repository → it reads `render.yaml`.
2. It asks for the three secrets: paste `DATABASE_URL`, `DATABASE_CA` and `RESEND_API_KEY`. Click **Apply**.
3. Wait for the deploy. The **Logs** tab should end with `Lekhira Writes is running at https://writes.lekhira.com`.
4. Open `https://lekhira-api.onrender.com/healthz` (Render shows the exact address). It should say **ok**: the server is up and reaching Supabase.

Render deploys again by itself when `main` changes on GitHub and GitHub's tests pass.

## 5. api.lekhira.com: try it out first

1. Render → the service → **Settings → Custom Domains → Add** `api.lekhira.com`.
2. Cloudflare DNS: add **CNAME**, name `api`, target the `…onrender.com` address Render shows, **DNS only** (grey cloud). Back in Render, click **Verify**; it sets up HTTPS.
3. While trying it, set `PUBLIC_ORIGIN` to `https://api.lekhira.com` in Render (Environment), so email links come back here and not to the preview.
4. Open https://api.lekhira.com: sign up, confirm your email, write a chapter, sign out, sign in again on your phone. Your books are now in Supabase (Table Editor → books).

## 6. writes.lekhira.com: switch from the preview to the real app

Do this when step 5 works. Afterwards writes.lekhira.com stops being the browser-only preview.

1. GitHub → LekhiraWrites → **Settings → Pages**: remove the custom domain (or turn Pages off).
2. Render → Custom Domains → **Add** `writes.lekhira.com`.
3. Cloudflare DNS: change the `writes` CNAME target from `haitish-astro.github.io` to the `…onrender.com` address (still grey cloud), then **Verify** in Render.
4. Set `PUBLIC_ORIGIN` back to `https://writes.lekhira.com` in Render.

## 7. Optional: Cloudflare's protection in front

Once both addresses work with grey clouds, you can switch `api` and `writes` to **Proxied** (orange cloud) for Cloudflare's attack protection and caching. When you do, set `TRUST_PROXY` to `2` in Render (Cloudflare's proxy plus Render's), so rate limits still see each visitor's real address. Keep SSL/TLS on **Full (strict)**.

## Later

- **Main site** lekhira.com on Cloudflare Pages, with a private repository.
- **Cloudflare R2** for files (book covers, images, backups) when Writes gets those features. Books themselves are text and live in Supabase.
- **Email Routing** (free): hello@lekhira.com forwarded to your inbox.
- **Paid plans when writers depend on it:** Render Starter (always awake) and Supabase Pro (daily backups).
