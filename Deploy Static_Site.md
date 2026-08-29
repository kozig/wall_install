# Low-Friction Static Sites on Cloudflare Pages with a Secure, Self-Hosted Contact Form (Google Sheets + 5+ Submission Alerts)

## TL;DR
- **Build it as a Cloudflare Worker with Static Assets, or classic Pages — both work; Cloudflare now steers new projects to Workers.** Cloudflare's official position (blog post "Your frontend, backend, and database — now in one Cloudflare Worker"): *"Now that Workers supports both serving static assets and server-side rendering, you should start with Workers. Cloudflare Pages will continue to be supported, but, going forward, all of our investment, optimizations, and feature work will be dedicated to improving Workers."* Your form posts same-origin to a Function/Worker endpoint that verifies Cloudflare Turnstile, sanitizes input, and forwards to a Google Apps Script Web App that appends a row to a Sheet — no third-party form SaaS needed.
- **Security is layered:** Turnstile server-side siteverify + honeypot + timestamp + WAF/Bot Fight Mode + a shared-secret (ideally HMAC) header the Apps Script endpoint checks, so the never-exposed Apps Script URL can't be abused. CSV/formula injection is neutralized before writing to Sheets.
- **The 5+ notification is done entirely in Apps Script**: each submission increments a Script Properties counter under a LockService lock; at 5 it sends a formatted HTML digest via MailApp and resets. Watch the **100 recipient-emails/day** consumer Gmail cap (**1,500/day** on Workspace). Everything stays inside Google Workspace + Cloudflare + GitHub.

## Key Findings

1. **Choose Workers with Static Assets for new projects; use Pages if you want the absolute lowest-friction git-push flow.** Native static-asset serving for Workers shipped in September 2024 (replacing the older Workers Sites), and Cloudflare's docs now say to start with Workers. Pages is **not** deprecated in the "shutting down" sense — existing projects keep running — but investment has shifted to Workers, and the Workers-only features (Cron Triggers, Rate Limiting binding, Workers Logs/Logpush, Durable Objects, Secrets Store) are exactly the ones this project can benefit from. Pages Functions still give you the identical server endpoint. This guide provides both paths with the same handler code.

2. **A same-origin form endpoint eliminates CORS** and hides your Apps Script URL. The browser only ever talks to `your-domain.com/api/contact`; the Apps Script `/exec` URL and its shared secret live only in server-side environment variables.

3. **Turnstile must be verified server-side** at `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Per Cloudflare docs, each token *"is valid for 300 seconds (5 minutes) after generation,"* is single-use (*"A replayed token will be rejected with the timeout-or-duplicate error code"*), and siteverify returns `{ success, "error-codes", challenge_ts, hostname, action, cdata }`. The green checkmark is not the security boundary — siteverify is.

4. **Apps Script Web Apps 302-redirect POSTs** to `script.googleusercontent.com`; you must follow redirects (Workers `fetch` does automatically; `curl` needs `-L`). Deploy as **Execute as: Me**, **Who has access: Anyone**, and edit the *existing* deployment on updates so the URL never changes.

5. **MailChannels' free Workers email ended August 31, 2024** (per MailChannels' End-of-Life Notice, which directs users to a paid Email API with a signup-required free tier of 100 emails/day) — do not use it as a primary path. Sending notification email from Apps Script (MailApp/GmailApp) is the correct in-stack choice.

## Details

### Architecture at a glance & data flow

```
Visitor browser
  │  (1) loads static HTML/CSS/JS from Cloudflare edge
  │  (2) solves Turnstile (usually invisibly), submits form
  ▼
Cloudflare Worker / Pages Function  (same origin: /api/contact)
  │   - checks honeypot + timestamp + payload size + field validation
  │   - POSTs token to Turnstile siteverify  ───►  challenges.cloudflare.com
  │   - sanitizes input (CSV/formula injection)
  │   - signs request (shared secret / HMAC)
  │   - on failure, writes to KV fallback
  ▼
Google Apps Script Web App (/exec, Execute as Me, Anyone)
  │   - verifies shared secret / HMAC + timestamp
  │   - LockService lock → appendRow(timestamp, id, name, email, msg…)
  │   - increments Script Properties counter
  ▼
Google Sheet  ──(counter hits 5)──►  MailApp HTML digest email to owner
                                      (optional: Google Chat webhook)
```

Data flow is one-directional and every hop is authenticated. The only public surface is the Worker endpoint, which is protected by Turnstile, WAF, and rate limiting.

---

### Repo file tree

```
my-site/
├─ public/                      # static assets (Workers) OR root (Pages)
│  ├─ index.html
│  ├─ contact.html
│  ├─ styles.css
│  └─ js/
│     └─ contact.js
├─ functions/                   # Pages Functions path (Option A)
│  └─ api/
│     └─ contact.js             # onRequestPost handler
├─ src/                         # Workers path (Option B)
│  └─ index.js                  # fetch handler: assets + /api/contact
├─ apps-script/
│  └─ Code.gs                   # doPost + notifier (kept in repo for reference)
├─ wrangler.toml                # Workers/Pages config
├─ .github/
│  └─ workflows/
│     └─ deploy.yml             # GitHub Actions → Wrangler
├─ .gitignore
├─ .dev.vars                    # LOCAL secrets only, git-ignored
└─ package.json
```

---

## PHASE 1 — Cloudflare deployment (≈ 30–45 min)

### 1.1 Decide: Pages vs Workers

| | Cloudflare Pages | Workers + Static Assets |
|---|---|---|
| Git push auto-deploy | ✅ built in | ✅ via Workers Builds or GitHub Actions |
| Server endpoint | Pages Functions (`/functions`) | native `fetch` handler |
| New features / roadmap | maintenance mode | all new investment |
| Best for | absolute lowest-friction static marketing site | anything you may extend |

**Recommendation:** For a simple marketing site the business will rarely touch, **Cloudflare Pages with Git integration is the lowest-friction choice and is fully supported today.** If you want to future-proof or already like Wrangler, use **Workers with Static Assets.** Both use the identical `onRequestPost`/`fetch` form-handler logic below.

### 1.2 Free-tier limits & what triggers cost

- **Pages:** 500 builds/month, 1 concurrent build, 20,000 files/site, 25 MiB max file size, 100 custom domains/project (Free). Builds time out after 20 minutes. Static requests and bandwidth are unlimited.
- **`_redirects`:** up to 2,000 static + 100 dynamic (2,100 total). **`_headers`:** 100 rules, 2,000 chars/line.
- **Workers/Pages Functions:** Free plan = 100,000 requests/day, 10 ms CPU/request, 128 MB memory/isolate, 50 subrequests/invocation. Static asset requests are unmetered; **only dynamic Function invocations count** against the 100k/day cap. A contact form will never approach this.
- **DNS:** zones created after September 2024 have a lower record cap than older zones; unlimited queries.
- **What causes cost:** exceeding 500 builds/month (→ Pro), needing >10 ms CPU or >100k Function requests/day (→ Workers Paid, min $5/mo), or WAF rate-limiting rules beyond the free allowance.

### 1.3 Connect GitHub (Pages Git integration — Option A)

1. Push your repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Select repo & branch (`main` = production).
4. **Build settings:**

| Framework | Build command | Output directory |
|---|---|---|
| Plain HTML/CSS/JS | *(none)* | `/` or `public` |
| Astro | `npm run build` | `dist` |
| Hugo | `hugo` | `public` |
| Eleventy | `npx @11ty/eleventy` | `_site` |
| Next.js (static export) | `next build` (with `output: 'export'`) | `out` |

5. Every branch/PR gets a **preview deployment** at a unique `*.pages.dev` URL. Production branch pushes update the live site. **Rollbacks:** Deployments tab → pick a previous deployment → **Rollback**.

> **2025–2026 gotcha:** Hugo (and other non-JS SSGs) are *not* on the Workers "recommended frameworks" list. They still deploy fine as static output on either Pages or Workers Static Assets, but the Workers framework-adapter tooling is JS-centric. If you use Hugo, either stay on Pages or deploy the built `public/` folder as plain static assets.

### 1.4 Wrangler + GitHub Actions (Workers — Option B, or Pages direct-upload)

`wrangler.toml` (Workers with Static Assets):

```toml
name = "my-site"
main = "src/index.js"
compatibility_date = "2026-08-28"

[assets]
directory = "./public"
binding = "ASSETS"

# [[kv_namespaces]]   # uncomment for the durable fallback (Phase 4)
# binding = "FORM_FALLBACK"
# id = "<your_kv_namespace_id>"
```

`src/index.js` (serves static assets + routes the API):

```js
import { onRequestPost } from "./contact.js"; // or inline the handler

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact" && request.method === "POST") {
      return onRequestPost({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }
    return env.ASSETS.fetch(request);
  },
};
```

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build --if-present
      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          # For Pages direct upload instead of Workers:
          # command: pages deploy ./public --project-name=my-site
```

**API token scopes:** In Cloudflare → **Account API tokens → Create Token → use the "Edit Cloudflare Workers" template** (for Workers) or a custom token with **Account → Cloudflare Pages → Edit** (for Pages). Do **not** use "Read All Resources" — it can't write and yields a confusing `code: 10000` auth error. Scope the token to the single account/zone you deploy to.

**GitHub secrets:** Repo → Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID`. The Account ID is not actually sensitive, but storing it as a secret is convenient.

> **Cost gotcha (2026):** If you migrate a Pages site to GitHub-Actions-driven Workers builds, note that GitHub Actions bills build minutes whereas Pages/Workers Builds run on Cloudflare for free. For frequent multi-project builds, prefer Cloudflare's built-in Workers Builds / Pages CI over Actions to avoid burning Actions minutes.

### 1.5 Custom domain, HTTPS, redirects, headers

1. Pages/Workers project → **Custom domains → Set up a domain** → enter `example.com`. If the domain's DNS is already on Cloudflare, records are added automatically; HTTPS certs are provisioned automatically (universal SSL).
2. **Redirects** — `public/_redirects`:
   ```
   /home        /            301
   /old-blog/*  /blog/:splat 301
   https://www.example.com/*  https://example.com/:splat  301
   ```
3. **Headers** — `public/_headers` (security headers + caching):
   ```
   /*
     X-Frame-Options: DENY
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
     Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'
   /assets/*
     Cache-Control: public, max-age=31536000, immutable
   ```
   Note the CSP must allow `challenges.cloudflare.com` for Turnstile.

---

## PHASE 2 — Google Sheet + Apps Script backend (≈ 30 min)

### 2.1 Create the Sheet & script

1. Create a Google Sheet, e.g. **"Website Leads"**. Put headers in row 1: `Timestamp | Submission ID | Name | Email | Message | Source IP | Notified`.
2. **Extensions → Apps Script**. Paste `Code.gs` (below).
3. Set the shared secret: **Project Settings → Script Properties → Add** `SHARED_SECRET` = a long random string (32+ random chars). Optionally add `CHAT_WEBHOOK` for the Google Chat escalation.

### 2.2 `Code.gs` — doPost, sanitization, locking, and the 5+ notifier

```js
const SHEET_NAME = 'Leads';
const NOTIFY_THRESHOLD = 5;
const OWNER_EMAIL = 'owner@example.com';

// Neutralize CSV/formula injection: prefix a leading = + - @ (and tab/CR) with '
// (OWASP-recommended: a leading apostrophe forces literal-text interpretation)
function sanitizeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).slice(0, 5000);              // payload cap
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize concurrent writes

    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('SHARED_SECRET');

    // Body may arrive as JSON (postData.contents) or form-encoded (e.parameter)
    let body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); }
      catch (err) { body = e.parameter || {}; }
    } else {
      body = e.parameter || {};
    }

    // ---- Shared-secret check (defends the "Anyone" endpoint) ----
    if (!secret || body.secret !== secret) {
      return json({ ok: false, error: 'unauthorized' });
    }

    // ---- Optional HMAC + timestamp replay protection ----
    // if (!verifyHmac(body, secret)) return json({ ok:false, error:'bad-sig' });

    const name    = sanitizeCell(body.name);
    const email   = sanitizeCell(body.email);
    const message = sanitizeCell(body.message);
    const ip      = sanitizeCell(body.ip || '');
    if (!name || !email || !message) {
      return json({ ok: false, error: 'missing-fields' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    const id = Utilities.getUuid();
    sheet.appendRow([new Date(), id, name, email, message, ip, '']);

    // ---- Threshold batching via Script Properties counter ----
    let count = Number(props.getProperty('UNNOTIFIED') || '0') + 1;
    if (count >= NOTIFY_THRESHOLD) {
      sendDigest_(sheet);
      count = 0;
    }
    props.setProperty('UNNOTIFIED', String(count));

    return json({ ok: true, id: id });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Liveness health check
function doGet() { return json({ ok: true }); }

// Build an HTML digest of the most recent NOTIFY_THRESHOLD un-notified rows
function sendDigest_(sheet) {
  const data = sheet.getDataRange().getValues();       // includes header row
  const rows = data.slice(1);
  const pending = rows.filter(r => r[6] !== 'Y');      // col G "Notified"
  if (pending.length < NOTIFY_THRESHOLD) return;

  const batch = pending.slice(-NOTIFY_THRESHOLD);
  let html = '<h2>' + NOTIFY_THRESHOLD + ' new contact submissions</h2>'
           + '<table border="1" cellpadding="6" style="border-collapse:collapse">'
           + '<tr><th>Time</th><th>Name</th><th>Email</th><th>Message</th></tr>';
  batch.forEach(r => {
    html += '<tr><td>' + r[0] + '</td><td>' + esc_(r[2]) + '</td><td>' + esc_(r[3]) +
            '</td><td>' + esc_(r[4]) + '</td></tr>';
  });
  html += '</table><p>Full log: your Google Sheet.</p>';

  if (MailApp.getRemainingDailyQuota() > 0) {
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: NOTIFY_THRESHOLD + ' new website leads',
      htmlBody: html,
    });
  }

  // Optional Google Chat escalation (Workspace-native)
  const chat = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK');
  if (chat) {
    UrlFetchApp.fetch(chat, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ text: NOTIFY_THRESHOLD + ' new website leads received.' }),
      muteHttpExceptions: true,
    });
  }

  // Mark rows notified (idempotent)
  const startRow = 2; // data begins on row 2
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][6] !== 'Y') sheet.getRange(startRow + i, 7).setValue('Y');
  }
}

function esc_(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

> **Why both a Script Properties counter *and* a "Notified" column?** The counter gives fast threshold batching without rescanning; the column makes the digest idempotent (rows already emailed are never re-sent even if a run is retried). Using the column as the source of truth also survives a counter reset.

### 2.3 Deploy as Web App (the settings that matter)

1. **Deploy → New deployment → Select type: Web app.**
2. **Execute as: Me.** **Who has access: Anyone.**
3. Deploy, authorize scopes, copy the `/exec` URL.

**Security implication:** "Anyone" means anyone with the URL can POST. That is *why* the shared-secret check exists and why the URL never appears in client-side code — it lives only in the Worker's server-side env.

> **Versioning gotcha:** When you change the script, do **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**. This keeps the same `/exec` URL. Choosing **New deployment** mints a *new* URL and your Worker will keep hitting the old, stale code.

### 2.4 POST-to-Apps-Script mechanics

Apps Script Web Apps return a **302 redirect** to `script.googleusercontent.com` for POSTs. Cloudflare Workers `fetch()` follows redirects by default, so it "just works." Send `Content-Type: application/json`; read data in `doPost` via `e.postData.contents` (JSON) — `e.parameter` only populates for form-encoded bodies. For `curl` testing you must add `-L`.

---

## PHASE 3 — The secure form handler (≈ 45 min)

### 3.1 Turnstile setup

1. Cloudflare dashboard → **Turnstile → Add widget.** Name it, add your hostname(s). Choose a **mode**: **Managed** (recommended; Cloudflare decides whether to show a challenge), **Non-Interactive** (visible widget, no click), or **Invisible** (fully hidden — note: enabling Invisible requires you to reference Cloudflare's Turnstile Privacy Addendum in your privacy policy).
2. Copy the **Sitekey** (public, goes in HTML) and **Secret key** (server-side only). Free accounts get up to 10 widgets.

### 3.2 The HTML form (`contact.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Contact us</title>
  <link rel="preconnect" href="https://challenges.cloudflare.com" />
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
  <form id="contact-form" action="/api/contact" method="POST">
    <label>Name <input name="name" required maxlength="120" /></label>
    <label>Email <input name="email" type="email" required maxlength="200" /></label>
    <label>Message <textarea name="message" required maxlength="4000"></textarea></label>

    <!-- Honeypot: hidden from humans, bots fill it in -->
    <div style="position:absolute;left:-9999px" aria-hidden="true">
      <label>Leave this blank <input name="website" tabindex="-1" autocomplete="off" /></label>
    </div>

    <!-- Timestamp for "too fast" detection -->
    <input type="hidden" name="ts" id="ts" />

    <!-- Turnstile widget: injects hidden input cf-turnstile-response -->
    <div class="cf-turnstile" data-sitekey="YOUR_SITEKEY" data-theme="auto"></div>

    <button type="submit">Send</button>
    <p id="status" role="status"></p>
  </form>
  <script>document.getElementById('ts').value = Date.now();</script>
  <script src="/js/contact.js"></script>
</body>
</html>
```

Because the form has a real `action="/api/contact"` and `method="POST"`, it works even with JS disabled (progressive enhancement) — though Turnstile itself needs JS, so a no-JS submission will simply fail siteverify and be rejected, which is acceptable for spam control.

### 3.3 Client submit handler (`js/contact.js`)

```js
const form = document.getElementById('contact-form');
const statusEl = document.getElementById('status');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = 'Sending…';
  const fd = new FormData(form);
  const payload = {
    name: fd.get('name'),
    email: fd.get('email'),
    message: fd.get('message'),
    website: fd.get('website'),          // honeypot
    ts: fd.get('ts'),
    'cf-turnstile-response': fd.get('cf-turnstile-response'),
  };
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    statusEl.textContent = data.ok ? 'Thanks — we got your message!' : 'Something went wrong. Please try again.';
    if (data.ok) form.reset();
    if (window.turnstile) window.turnstile.reset();
  } catch (err) {
    statusEl.textContent = 'Network error. Please try again.';
  }
});
```

### 3.4 The Pages Function / Worker endpoint (`functions/api/contact.js`)

```js
export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || '';

  // 1. Payload size guard
  const raw = await request.text();
  if (raw.length > 20000) return json({ ok: false, error: 'too-large' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad-json' }, 400); }

  // 2. Honeypot: if filled, silently accept (don't tip off the bot)
  if (body.website) return json({ ok: true });

  // 3. Timestamp: reject sub-3-second (bot) and stale (>30 min) submissions
  const ts = Number(body.ts || 0);
  const age = Date.now() - ts;
  if (!ts || age < 3000 || age > 1800000) return json({ ok: false, error: 'timing' }, 400);

  // 4. Basic validation
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const message = (body.message || '').trim();
  if (!name || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: 'invalid' }, 400);
  }

  // 5. Optional edge rate limit (Workers Rate Limiting binding)
  if (env.CONTACT_LIMITER) {
    const { success } = await env.CONTACT_LIMITER.limit({ key: ip });
    if (!success) return json({ ok: false, error: 'rate-limited' }, 429);
  }

  // 6. Turnstile server-side verification
  const token = body['cf-turnstile-response'];
  const tsForm = new FormData();
  tsForm.append('secret', env.TURNSTILE_SECRET);
  tsForm.append('response', token || '');
  tsForm.append('remoteip', ip);
  const verify = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: tsForm }
  );
  const outcome = await verify.json();
  if (!outcome.success) {
    return json({ ok: false, error: 'captcha', codes: outcome['error-codes'] }, 403);
  }

  // 7. Forward to Apps Script with shared secret (URL never seen by client)
  const forwardPayload = { name, email, message, ip, secret: env.SHARED_SECRET, ts };
  try {
    const gs = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardPayload),
      // Workers follows the 302 redirect automatically
    });
    const gsData = await gs.json();
    if (!gsData.ok) throw new Error(gsData.error || 'apps-script-failed');
    return json({ ok: true, id: gsData.id });
  } catch (err) {
    // 8. Durable fallback so submissions are never lost (Phase 4)
    if (env.FORM_FALLBACK) {
      await env.FORM_FALLBACK.put(
        `lead:${Date.now()}:${crypto.randomUUID()}`,
        JSON.stringify(forwardPayload),
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
      return json({ ok: true, queued: true });
    }
    return json({ ok: false, error: 'backend-unavailable' }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

The `onRequestPost` signature receives an `EventContext` object `{ request, env, params, data, waitUntil, next }` — the modern Pages Functions handler. Method-specific exports (`onRequestPost`, `onRequestGet`, etc.) mean you don't check `request.method` yourself.

### 3.5 Secrets handling

Store these as **encrypted secrets**, never in client code or the repo:

- **Dashboard (Pages):** Project → Settings → Environment variables & secrets → add `TURNSTILE_SECRET`, `APPS_SCRIPT_URL`, `SHARED_SECRET` as **Secret** (encrypted) for both Production and Preview.
- **Wrangler (Workers):**
  ```
  npx wrangler secret put TURNSTILE_SECRET
  npx wrangler secret put APPS_SCRIPT_URL
  npx wrangler secret put SHARED_SECRET
  ```
- **Local dev:** put them in `.dev.vars` (git-ignored). Never commit real secrets.

**Why the Apps Script URL is a secret:** although it's just a URL, if exposed anyone can POST to your "Anyone"-access endpoint. Keeping it server-side plus the shared-secret check gives defense in depth.

### 3.6 Rate limiting options

- **WAF Rate Limiting Rules:** available with limited free allowance; configure a rule matching `POST /api/contact` (e.g. N requests per IP per minute). Supported period values include 10, 60, 300, 3600, and 86400 seconds. The free plan allows a small number of custom/rate-limiting rules — enough for one form endpoint.
- **Workers Rate Limiting binding:** define in `wrangler.toml`; Cloudflare states it *"should not be used as an accurate accounting system"* (it's a loose per-location filter) and requires Wrangler ≥ 4.36.0. There's no extra charge — you pay only for Workers requests/CPU. Good enough for contact-form abuse. Period must be `10` or `60`:
  ```toml
  [[ratelimits]]
  name = "CONTACT_LIMITER"
  namespace_id = "1001"
  simple = { limit = 5, period = 60 }
  ```
- **KV / Durable Object counter:** most precise. On the Workers Free plan a Durable Object rate-limiter is possible only if the DO class is declared with `new_sqlite_classes` (the legacy KV-backed DO requires Workers Paid).

For a contact form, **a WAF rate-limiting rule + the Workers binding is more than enough**; skip Durable Objects.

---

## PHASE 4 — Hardening & ops (≈ 30 min)

### 4.1 Stacked bot mitigation

1. **Cloudflare Bot Fight Mode** (Free): dashboard → Security → Settings → Bot traffic → turn on. It challenges known bots domain-wide by issuing computationally expensive challenges. Note it can't be customized or bypassed via WAF skip rules on Free; **Super Bot Fight Mode** (configurable per-category, WAF skip exceptions) is Pro/Business/Enterprise.
2. **Turnstile** server-side verification (above).
3. **Honeypot** (`website` field) + **timestamp** ("too fast"/"too old") checks.
4. **WAF rate-limiting rule** on the endpoint.
5. **WAF custom rules** (optional): block requests to `/api/contact` lacking the expected `Content-Type` or a same-origin `Referer`.

### 4.2 Defending the Apps Script endpoint (HMAC upgrade)

The shared secret in the body is the baseline. For replay resistance, upgrade to an **HMAC signature over the payload + timestamp**. Worker side:

```js
async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// const canonical = `${ts}.${name}.${email}.${message}`;
// forwardPayload.sig = await sign(canonical, env.SHARED_SECRET);
```

Apps Script side recomputes the HMAC with `Utilities.computeHmacSha256Signature`, compares to `body.sig`, and rejects if the timestamp is older than a few minutes (blocks replays).

### 4.3 Failure modes & durable fallback

- **If Apps Script is down or over quota,** the Worker's `catch` writes the submission to **Cloudflare KV** (`FORM_FALLBACK`) with a 30-day TTL and returns success to the visitor. A scheduled Worker (Cron Trigger — Workers-only) or a manual sweep can later replay queued leads into the Sheet. Alternative durable store: **D1** (SQLite) if you want queryable history.
- **MailChannels / email-from-Workers:** MailChannels ended its free Cloudflare Workers email service on **August 31, 2024**; its replacement is a paid Email API (free tier ~100 emails/day but requires signup — an out-of-stack SaaS). **Do not rely on MailChannels.** Cloudflare's docs now point to Resend for Workers email — also out-of-stack. **Cloudflare Email Routing** routes *inbound* email to an address; it is not a general outbound-send API for arbitrary notifications. **Therefore the in-stack notification path is Apps Script MailApp/GmailApp**, which is exactly what we use. This is a deliberate design choice that keeps you inside Google Workspace + Cloudflare.

### 4.4 PII, permissions, access control

- The Sheet holds names, emails, and message text — treat it as PII. Share it with only the owner(s); don't make it "anyone with link." The Apps Script runs as *you* (Execute as Me), so the endpoint doesn't require submitters to have Google accounts.
- Consider a short data-retention policy (e.g. archive/delete leads after N months). Add a privacy note on the contact page, and — if using Invisible Turnstile — the required Turnstile Privacy Addendum reference.

### 4.5 Observability & health check

- **Workers Logs / Logpush** (Workers-only; another reason to prefer Workers): view real-time `console.log` and 4xx/5xx from the endpoint. On Pages, Functions logs are thinner.
- **Apps Script Executions panel** (left nav in the editor): every `doPost` run with duration and status (completed / timed out / quota exceeded). Workspace admins can also see aggregate script activity in Admin Console → Reports → Apps → Apps Script.
- **Health check:** the `doGet` above returns `{ ok: true }` so you can ping liveness; also hit `/api/contact` with a test payload periodically.

---

## PHASE 5 — Test end-to-end (≈ 20 min)

**Test the Apps Script directly (note `-L` to follow the 302):**
```bash
curl -L -X POST "https://script.google.com/macros/s/XXXX/exec" \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_SHARED_SECRET","name":"Test","email":"t@example.com","message":"hello","ts":1735600000000}'
# Expect: {"ok":true,"id":"..."}
```

**Test the Worker endpoint (Turnstile will reject a fake token — expected):**
```bash
curl -X POST "https://example.com/api/contact" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"t@example.com","message":"hi","ts":'$(node -e 'console.log(Date.now())')',"cf-turnstile-response":"dummy"}'
# Expect: {"ok":false,"error":"captcha",...}
```
Use Turnstile's **testing sitekeys/secrets** (Cloudflare publishes always-pass and always-fail dummy keys) to exercise success/failure paths without a browser. A resubmitted/expired token returns `success: false` with `error-codes: ["timeout-or-duplicate"]`.

**Full test:** load `contact.html`, submit 5 times, confirm 5 rows appear in the Sheet and one HTML digest email arrives, then confirm the counter resets and the "Notified" column reads `Y`.

---

## Quotas that constrain this design (official Google figures, verified Aug 28, 2026)

From Google's official *Quotas for Google Services* page (per-user, reset 24 h after first request; the page warns *"All quotas are subject to elimination, reduction, or change at any time, without notice"*):

| Quota | Consumer (gmail.com) | Google Workspace |
|---|---|---|
| **Email recipients / day** (MailApp) | **100** | **1,500** (2,000 within-domain) |
| URL Fetch calls / day | 20,000 | 100,000 |
| Triggers total runtime / day | 90 min | 6 hr |
| Script runtime (per execution) | 6 min | 6 min |
| Custom function runtime | 30 sec | 30 sec |
| Simultaneous executions / user | 30 | 30 |
| Time-driven triggers | 20 / user / script | 20 / user / script |
| Properties total storage | 500 KB | 500 KB |
| URL Fetch POST / response size | 50 MB | 50 MB |

**Interpretation:** With one digest per 5 submissions, even a consumer Gmail account (100 recipient-emails/day) tolerates ~500 submissions/day before hitting the mail cap — far beyond a normal marketing site. If you expect high volume or send to multiple owners, use a **Workspace** account (1,500/day). The 6-minute execution cap is identical on both tiers and irrelevant for a single-row append. The code guards mail with `getRemainingDailyQuota()` so it degrades gracefully.

---

## Notification approach: recommendation

Three viable in-stack patterns:

| Approach | Pros | Cons |
|---|---|---|
| **(a) Counter in doPost, email at 5** ✅ recommended | Instant; no polling; set-and-forget | Counter must be lock-guarded (done) |
| (b) Time-driven trigger (hourly/daily) scans for un-notified rows ≥ 5 | Batches nicely; resilient | Delay up to the interval; uses trigger runtime |
| (c) onChange/onFormSubmit installable trigger | Event-driven | onFormSubmit is for Google Forms, not raw appends; onChange is coarser |

**Recommendation: (a) as primary, with (b) as a safety net.** Use the in-`doPost` counter for immediate alerts, and add a **daily time-driven trigger** that emails any un-notified rows even if they never reached 5 (so stragglers aren't stranded). Both share the "Notified" column for idempotency.

Optional escalation: a **Google Chat incoming webhook** (Workspace-native — create in the Chat space → Apps & integrations → Add webhooks, POST `{text:"…"}` via `UrlFetchApp`; keep the key/token secret). Slack works the same way but is out-of-stack; keep it secondary.

---

## Pre-launch checklist

- [ ] Turnstile widget created; sitekey in HTML, secret in Cloudflare secrets
- [ ] `TURNSTILE_SECRET`, `APPS_SCRIPT_URL`, `SHARED_SECRET` set as encrypted secrets (Prod + Preview)
- [ ] Apps Script deployed **Execute as Me / Anyone**; `/exec` URL copied
- [ ] `SHARED_SECRET` matches in Cloudflare and Script Properties
- [ ] CSV/formula-injection sanitization active; payload cap set
- [ ] Honeypot + timestamp checks live; server-side siteverify confirmed
- [ ] WAF rate-limit rule on `/api/contact`; Bot Fight Mode on
- [ ] KV (or D1) fallback binding configured
- [ ] Custom domain + HTTPS + `_headers` CSP allowing `challenges.cloudflare.com`
- [ ] 5-submission digest email received; counter resets; "Notified"=Y
- [ ] Daily safety-net trigger installed
- [ ] Sheet shared only with owner(s); privacy note published
- [ ] Rollback tested (Pages Deployments tab)

## Ongoing maintenance & cost

- **Cost: $0** for a normal marketing site — Cloudflare Free (unlimited static, 100k Function req/day), Apps Script (free), GitHub (free). Costs appear only if you exceed 500 builds/month, 100k dynamic requests/day, or need Workers Paid ($5/mo) for higher CPU/requests.
- **Maintenance is minimal/set-and-forget:** occasionally check the Apps Script Executions log and Sheet growth. Re-deploy the script **in place** (Manage deployments → new version) when you change it.
- **Rotate** `SHARED_SECRET` periodically (update both places at once).
- **Prune** old leads per your retention policy.

## Recommendations (staged)

1. **Start today:** Deploy the static site on **Cloudflare Pages via Git** (lowest friction) + the Pages Function form handler + Apps Script backend + Turnstile + the 5-count notifier. This is fully free and set-and-forget. **Change trigger:** if you later need Cron sweeps, Workers Logs, or Durable Objects, migrate to **Workers with Static Assets** (same handler code).
2. **Before going live:** add the KV fallback and the daily safety-net trigger — these prevent silent data loss, the single worst failure mode.
3. **If spam appears:** tighten the WAF rate-limit, keep Turnstile on **Managed**, and add a WAF rule requiring same-origin `Referer`. **Threshold:** if bot submissions still land in the Sheet, add the HMAC signature check.
4. **If volume grows** past a few hundred leads/day or you add recipients: move the script owner to a **Google Workspace** account (1,500 emails/day) and consider batching digests hourly via trigger (b).
5. **Never** introduce a third-party form SaaS (Formspree/Netlify Forms/Zapier/SendGrid/etc.) — the in-stack path already covers capture, storage, spam control, and notification at zero cost and lower supply-chain risk.

## Caveats

- **Cloudflare Pages vs Workers status:** Multiple 2026 community sources describe Pages as "deprecated"/"maintenance mode," but Cloudflare's official wording is narrower — Pages is *not* being shut down. Per Cloudflare's blog: *"Cloudflare Pages will continue to be supported, but, going forward, all of our investment, optimizations, and feature work will be dedicated to improving Workers."* Treat blog claims of a hard Pages "deprecation date" (some cite April 2025) as unconfirmed characterizations, not an official end-of-life.
- **Quotas change without notice.** The Google figures are quoted from the official page as of Aug 28, 2026, but Google explicitly states they can change anytime. Re-verify before scaling.
- **MailChannels** free Workers email is gone (Aug 31, 2024) and its successor plus Cloudflare's Resend guidance are out-of-stack; this guide intentionally routes notifications through Apps Script instead.
- **Workers Rate Limiting binding** is explicitly *"not an accurate accounting system"* per Cloudflare — fine for spam throttling, not for hard quotas.
- **Turnstile Invisible mode** carries a privacy-policy obligation (reference Cloudflare's Turnstile Privacy Addendum).
- **No-JS submissions** cannot pass Turnstile and will be rejected; this is acceptable for spam control but means the form is not usable with JavaScript fully disabled.
- **Turnstile free tier** is limited to 10 widgets per account — ample for a single site.