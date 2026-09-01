// Apps Script Web App — the storage + notification backend for the
// wallinstall.ca quote form. Kept here for reference/version control;
// the deployed copy lives in the Apps Script project attached to the
// "wall_install_form_submissions" Google Sheet (Extensions → Apps Script).
//
// Setup (see Deploy Static_Site.md, Phase 2):
//   1. Paste this whole file into the Apps Script editor, replacing
//      whatever's there, and fill in OWNER_EMAIL below.
//   2. Project Settings → Script Properties → add SHARED_SECRET, a long
//      random string. It must match the SHARED_SECRET set as a Cloudflare
//      Pages secret for functions/api/contact.js.
//   3. Deploy → New deployment → Web app → Execute as: Me,
//      Who has access: Anyone. Copy the /exec URL into the Pages secret
//      APPS_SCRIPT_URL.
//   4. On any later edit: Deploy → Manage deployments → edit (pencil) →
//      Version: New version → Deploy. This keeps the same /exec URL —
//      "New deployment" instead would mint a new URL and orphan the one
//      already configured in Cloudflare.
//
// Expected Sheet header row (row 1), matching the columns appendRow
// writes below:
//   Timestamp | Submission ID | First Name | Last Name | Email | Phone |
//   Postal Code | Service Type | Work Request | Out of Area | IP | Notified

const SHEET_NAME = 'wall_install_form_submissions';
const NOTIFY_THRESHOLD = 5;
const OWNER_EMAIL = 'info@wallinstall.ca';

// Neutralize CSV/formula injection: prefix a leading = + - @ (and tab/CR)
// with an apostrophe, forcing Sheets to treat the value as literal text.
function sanitizeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).slice(0, 5000); // payload cap
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

    let body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); }
      catch (err) { body = e.parameter || {}; }
    } else {
      body = e.parameter || {};
    }

    // Defends the "Anyone" endpoint — only the Pages Function knows this.
    if (!secret || body.secret !== secret) {
      return json({ ok: false, error: 'unauthorized' });
    }

    const firstName  = sanitizeCell(body.first_name);
    const lastName   = sanitizeCell(body.last_name);
    const email      = sanitizeCell(body.email);
    const phone      = sanitizeCell(body.phone);
    const postal     = sanitizeCell(body.postal_code);
    const serviceType = sanitizeCell(body.service_type);
    const workRequest = sanitizeCell(body.work_request);
    const outOfArea  = sanitizeCell(body.out_of_area);
    const ip         = sanitizeCell(body.ip || '');

    if (!firstName || !lastName || !workRequest) {
      return json({ ok: false, error: 'missing-fields' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    const id = Utilities.getUuid();
    sheet.appendRow([
      new Date(), id, firstName, lastName, email, phone,
      postal, serviceType, workRequest, outOfArea, ip, '',
    ]);

    // Threshold batching via a Script Properties counter, backstopped by
    // the "Notified" column so a retried run never double-sends.
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

// Liveness check.
function doGet() { return json({ ok: true }); }

// Column indices (0-based) in the row appendRow writes above.
const COL_OUT_OF_AREA = 9;
const COL_NOTIFIED = 11;

function sendDigest_(sheet) {
  const data = sheet.getDataRange().getValues(); // includes header row
  const rows = data.slice(1);
  const pending = rows.filter(r => r[COL_NOTIFIED] !== 'Y');
  if (pending.length < NOTIFY_THRESHOLD) return;

  const batch = pending.slice(-NOTIFY_THRESHOLD);
  let html = '<h2>' + NOTIFY_THRESHOLD + ' new quote requests</h2>'
           + '<table border="1" cellpadding="6" style="border-collapse:collapse">'
           + '<tr><th>Time</th><th>Name</th><th>Email</th><th>Phone</th>'
           + '<th>Postal</th><th>Service</th><th>Request</th></tr>';
  batch.forEach(r => {
    const flag = r[COL_OUT_OF_AREA] === 'yes' ? ' ⚠️ OUT OF AREA' : '';
    html += '<tr><td>' + r[0] + '</td><td>' + esc_(r[2] + ' ' + r[3]) + flag +
            '</td><td>' + esc_(r[4]) + '</td><td>' + esc_(r[5]) +
            '</td><td>' + esc_(r[6]) + '</td><td>' + esc_(r[7]) +
            '</td><td>' + esc_(r[8]) + '</td></tr>';
  });
  html += '</table><p>Full log: your Google Sheet.</p>';

  if (MailApp.getRemainingDailyQuota() > 0) {
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: NOTIFY_THRESHOLD + ' new website leads',
      htmlBody: html,
    });
  }

  const startRow = 2; // data begins on row 2
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][COL_NOTIFIED] !== 'Y') {
      sheet.getRange(startRow + i, COL_NOTIFIED + 1).setValue('Y');
    }
  }
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
