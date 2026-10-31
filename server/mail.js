// Lekhira Writes: sending email (address checks, password resets, sign-in alerts).
//   EMAIL_PROVIDER=outbox  (default while developing) writes each email to data/outbox/ and
//                          shows them at /dev/outbox, so the whole flow can be tested offline
//   EMAIL_PROVIDER=resend  sends through Resend's API (RESEND_API_KEY, EMAIL_FROM)
//   EMAIL_PROVIDER=memory  keeps them in memory (tests)
// Emails are plain text: nothing a writer typed is ever put into HTML.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createMailer({ provider = 'outbox', from = 'Lekhira <no-reply@lekhira.com>', outboxDir, apiKey } = {}) {
  const sent = [];

  async function deliver(msg) {
    if (provider === 'memory') { sent.push(msg); return; }
    if (provider === 'outbox') {
      fs.mkdirSync(outboxDir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${msg.kind}.txt`;
      fs.writeFileSync(path.join(outboxDir, name), `To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
      if (process.env.QUIET !== '1') console.log(`  ✉  ${msg.subject} → ${msg.to} (see /dev/outbox)`);
      return;
    }
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}`);
      return;
    }
    throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
  }

  // Never holds up the request that triggered it, and never fails it: a lost email is logged.
  function send(msg) {
    deliver({ ...msg, at: Date.now() }).catch((err) => console.error(`[mail] ${msg.kind} to ${msg.to} failed:`, err.message));
  }

  function outbox(limit = 25) {
    if (provider !== 'outbox' || !fs.existsSync(outboxDir)) return [];
    return fs.readdirSync(outboxDir).filter((f) => f.endsWith('.txt')).sort().reverse().slice(0, limit)
      .map((f) => ({ name: f, text: fs.readFileSync(path.join(outboxDir, f), 'utf8') }));
  }

  return { send, sent, outbox, provider };
}

// ---------- the emails ----------
const sign = '\n\n— Lekhira\nEvery story deserves to be written.';

const templates = {
  verify: ({ name, link }) => ({
    subject: 'Confirm your email for Lekhira',
    text: `Hi ${name},\n\nPlease confirm this is your email address, so we can reach you about your account and your books:\n\n${link}\n\nThe link works for 48 hours. If you didn't create a Lekhira account, you can ignore this email.${sign}`,
  }),
  reset: ({ name, link }) => ({
    subject: 'Reset your Lekhira password',
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset the password for your Lekhira account. To choose a new one, open:\n\n${link}\n\nThe link works for 30 minutes and only once. If you didn't ask for this, ignore this email; your password stays the same.${sign}`,
  }),
  passwordChanged: ({ name, forgotLink }) => ({
    subject: 'Your Lekhira password was changed',
    text: `Hi ${name},\n\nThe password for your Lekhira account was just changed, and every other device was signed out.\n\nIf this wasn't you, reset your password now:\n${forgotLink}${sign}`,
  }),
  newSignIn: ({ name, what, when, where, forgotLink }) => ({
    subject: 'New sign-in to your Lekhira account',
    text: `Hi ${name},\n\nYour Lekhira account was just signed in to from a new place:\n\n  ${what}\n  ${when}\n  ${where}\n\nIf this was you, there's nothing to do. If it wasn't, reset your password now — that signs out every device:\n${forgotLink}${sign}`,
  }),
};

module.exports = { createMailer, templates };
