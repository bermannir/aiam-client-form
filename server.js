require('dotenv').config();
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Pending submissions store (in-memory) ────────────────────────────────────
// token → { data, savedAt }
const pending = new Map();

function getBaseUrl(req) {
  return process.env.BASE_URL ||
    `${req.protocol}://${req.get('host')}`;
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

let sheetsInstance = null;

async function getSheetsClient() {
  if (sheetsInstance) return sheetsInstance;
  let authConfig;
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString());
    authConfig = { credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  } else if (process.env.GOOGLE_CREDENTIALS) {
    authConfig = { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  } else {
    authConfig = { keyFilename: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  }
  const auth = new google.auth.GoogleAuth(authConfig);
  const authClient = await auth.getClient();
  sheetsInstance   = google.sheets({ version: 'v4', auth: authClient });
  return sheetsInstance;
}

async function ensureSheetTab(sheets) {
  const tab  = process.env.GOOGLE_SHEETS_QUESTIONNAIRE_TAB || 'שאלונים';
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === tab);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
  }
}

async function ensureHeaderRow(sheets) {
  const tab = process.env.GOOGLE_SHEETS_QUESTIONNAIRE_TAB || 'שאלונים';
  await ensureSheetTab(sheets);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${tab}!A1:I1`,
  });
  const existing = (res.data.values || [])[0];
  if (!existing || existing[0] !== 'תאריך') {
    await sheets.spreadsheets.values.update({
      spreadsheetId:    process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range:            `${tab}!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['תאריך', 'שם מלא', 'טלפון', 'אימייל', 'סוג לקוח', 'תחום עסק ואתגרים', 'מחשב (1-5)', 'AI (1-5)', 'ציפיות מהסדנה']] },
    });
  }
}

async function saveToSheets(data) {
  const sheets = await getSheetsClient();
  const tab    = process.env.GOOGLE_SHEETS_QUESTIONNAIRE_TAB || 'שאלונים';
  await ensureHeaderRow(sheets);
  const row = [
    new Date().toLocaleString('he-IL'),
    data.name,
    data.phone,
    data.email,
    data.clientType === 'business' ? 'לקוח עסקי' : 'לקוח פרטי',
    data.businessDescription || '',
    data.computerSkill || '',
    data.aiSkill || '',
    data.expectations || '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId:    process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range:            `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  console.log(`✅ Sheets: נשמר לקוח ${data.name}`);
}

// ─── Email ────────────────────────────────────────────────────────────────────

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   process.env.EMAIL_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.EMAIL_PORT) || 587,
    secure: parseInt(process.env.EMAIL_PORT) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
  return transporter;
}

async function sendNotification(data, token, baseUrl) {
  const t             = getTransporter();
  const subject       = `📋 שאלון חדש — ${data.name}`;
  const clientTypeLabel = data.clientType === 'business' ? 'לקוח עסקי' : 'לקוח פרטי';
  const saveUrl       = `${baseUrl}/api/approve/${token}`;
  const rejectUrl     = `${baseUrl}/api/reject/${token}`;

  const html = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;direction:rtl;color:#333;max-width:640px;margin:0 auto;padding:20px;background:#f4f6fb">
  <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

    <div style="background:linear-gradient(135deg,#1a73e8,#0d5bba);padding:28px 32px;text-align:center">
      <h2 style="color:#fff;margin:0;font-size:1.35rem">📋 שאלון אפיון חדש התקבל</h2>
      <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:0.9rem">AI-AM Solutions</p>
    </div>

    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="background:#f0f6ff">
          <td style="padding:10px 14px;font-weight:bold;width:150px;border-bottom:1px solid #e8eef7">שם מלא</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7">${data.name}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">טלפון</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7"><a href="tel:${data.phone}" style="color:#1a73e8">${data.phone}</a></td>
        </tr>
        <tr style="background:#f0f6ff">
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">אימייל</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7"><a href="mailto:${data.email}" style="color:#1a73e8">${data.email}</a></td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">סוג לקוח</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7">${clientTypeLabel}</td>
        </tr>
        ${data.businessDescription ? `
        <tr style="background:#f0f6ff">
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">תחום עסק</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7">${data.businessDescription.replace(/\n/g,'<br>')}</td>
        </tr>` : ''}
        <tr style="background:#f0f6ff">
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">מחשב</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7">${data.computerSkill || '—'} / 5</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:bold;border-bottom:1px solid #e8eef7">היכרות AI</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e8eef7">${data.aiSkill || '—'} / 5</td>
        </tr>
        ${data.expectations ? `
        <tr style="background:#f0f6ff">
          <td style="padding:10px 14px;font-weight:bold;vertical-align:top">ציפיות</td>
          <td style="padding:10px 14px">${data.expectations.replace(/\n/g,'<br>')}</td>
        </tr>` : ''}
      </table>

      <!-- Action buttons -->
      <div style="text-align:center;margin:28px 0 8px">
        <p style="color:#555;font-size:0.95rem;margin-bottom:18px">האם לשמור לקוח זה ב-Google Sheets?</p>
        <a href="${saveUrl}" style="display:inline-block;background:#1a73e8;color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1rem;margin-left:12px">
          ✅ שמור ב-Sheets
        </a>
        <a href="${rejectUrl}" style="display:inline-block;background:#fff;color:#888;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1rem;border:2px solid #ddd">
          ❌ לא רלוונטי
        </a>
      </div>
    </div>

    <div style="background:#f8f9fa;padding:14px 32px;text-align:center;border-top:1px solid #eee">
      <p style="color:#aaa;font-size:0.78rem;margin:0">נשלח אוטומטית · AI-AM Solutions · ניר ברמן</p>
    </div>
  </div>
</body>
</html>`;

  await t.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      process.env.NOTIFICATION_EMAIL,
    subject,
    html,
  });
  console.log(`📧 מייל נשלח עבור ${data.name} (token: ${token})`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Submit form
app.post('/api/submit', async (req, res) => {
  const { name, phone, email, clientType, businessDescription, computerSkill, aiSkill, expectations } = req.body;

  if (!name || !phone || !email || !clientType) {
    return res.status(400).json({ error: 'שדות חובה חסרים' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
  }

  try {
    const data  = { name, phone, email, clientType, businessDescription, computerSkill, aiSkill, expectations };
    const token = crypto.randomUUID();
    pending.set(token, { data, createdAt: new Date() });

    const baseUrl = getBaseUrl(req);
    const emailEnabled = process.env.EMAIL_USER && process.env.EMAIL_PASSWORD;
    if (emailEnabled) {
      await sendNotification(data, token, baseUrl).catch(e => console.error('Email error:', e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'שגיאה בשמירת הטופס. נסה שוב.' });
  }
});

// Approve → save to Sheets
app.get('/api/approve/:token', async (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry) {
    return res.send(page('⚠️ הקישור פג תוקף', 'הלקוח כבר טופל או שהקישור לא תקין.', '#f5a623'));
  }

  try {
    await saveToSheets(entry.data);
    pending.delete(req.params.token);
    const sheetsUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_SPREADSHEET_ID}`;
    res.send(page('✅ נשמר בהצלחה!',
      `<b>${entry.data.name}</b> נוסף ל-Google Sheets.<br><br>
       <a href="${sheetsUrl}" style="color:#1a73e8;font-weight:bold">פתח את הגיליון ←</a>`, '#1a73e8'));
  } catch (err) {
    console.error('Approve error:', err.message);
    res.send(page('❌ שגיאה בשמירה', `פרטי שגיאה: ${err.message}`, '#e53935'));
  }
});

// Reject → remove from pending
app.get('/api/reject/:token', (req, res) => {
  const entry = pending.get(req.params.token);
  const name  = entry ? entry.data.name : 'הלקוח';
  pending.delete(req.params.token);
  res.send(page('👋 בוצע', `${name} סומן כלא רלוונטי ולא נשמר.`, '#888'));
});

// Simple response page helper
function page(title, body, color) {
  return `<!DOCTYPE html><html dir="rtl" lang="he">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6fb">
<div style="background:#fff;border-radius:14px;padding:40px 48px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:420px">
  <div style="font-size:2.5rem;margin-bottom:16px">${title.split(' ')[0]}</div>
  <h2 style="color:${color};margin:0 0 12px">${title.split(' ').slice(1).join(' ')}</h2>
  <p style="color:#666;line-height:1.6">${body}</p>
</div></body></html>`;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ שאלון AI-AM פועל בכתובת: http://localhost:${PORT}`);
});
