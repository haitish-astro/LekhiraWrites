# Security

Lekhira Writes holds people's books, so we take security reports seriously.

## Reporting a problem

Please **don't open a public issue**. Instead, report it privately on GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what someone could do with it.

We'll reply as soon as we can, keep you updated while it's fixed, and credit you if you'd like.

## What's in scope

- The Lekhira Writes server (`server/`) and web app (`public/`).
- The GitHub Pages preview at writes.lekhira.com (`pages/`). It keeps accounts only in the visitor's own browser, so reports about it reading its own browser storage are expected behaviour.
- Desktop sign-in (`/oauth/authorize`, `/api/oauth/*`, `tools/desktop-signin.js`).

How the app protects writers is described under **Security** in the [README](README.md).
