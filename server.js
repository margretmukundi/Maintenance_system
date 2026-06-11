// =============================================================
// OFFICE MAINTENANCE REQUEST SYSTEM — Node.js + Express Backend
// Version: 5.0 — includes all bug fixes + new features
// =============================================================
//
// SETUP:
//   1. Place this file in:  C:\xampp\htdocs\office_maintenance\
//   2. Place index.html in: C:\xampp\htdocs\office_maintenance\public\
//   3. Import database.sql into maintenance_db via phpMyAdmin
//   4. Copy .env.example to .env and fill in your values
//   5. Open terminal in the folder and run:
//        npm install
//        node server.js
//   6. Open: http://localhost:3000
//
// NEW IN v5.0:
//   - Bug fix: password_reset_tokens table name corrected
//   - Bug fix: admin password reset now works
//   - Bug fix: session secret now loaded from .env (required)
//   - Security: rate limiting on login/reset endpoints
//   - Security: helmet.js HTTP headers
//   - Security: stronger reset tokens (8 chars)
//   - Feature: password strength validation helper
//   - Feature: change_password action (users + admins)
//   - Feature: email verification on registration
//   - Feature: Server-Sent Events for real-time updates
//   - Feature: photo upload for repair requests (multer)
//   - Feature: multi-item repair requests
//   - Feature: admin sees full requester notes/comments
//   - Feature: settings endpoints (profile update)
// =============================================================

try { require('dotenv').config(); } catch(e) {}

// Fail fast if SESSION_SECRET is missing in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in .env for production.');
  process.exit(1);
}

const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const mysql        = require('mysql2/promise');
const nodemailer   = require('nodemailer');
const session      = require('express-session');
const MySQLStore   = require('express-mysql-session')(session);
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const multer       = require('multer');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// =============================================================
// ⚙️  DATABASE CONFIG
// =============================================================
const DB = {
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  database: process.env.DB_NAME || 'maintenance_db',
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
};

// =============================================================
// ✉️  EMAIL CONFIG
// =============================================================
const MAIL = {
  HOST:       process.env.MAIL_HOST      || 'smtp.gmail.com',
  PORT:       parseInt(process.env.MAIL_PORT || '587'),
  USER:       process.env.MAIL_USER      || '',
  PASS:       process.env.MAIL_PASS      || '',
  FROM_NAME:  process.env.MAIL_FROM_NAME || 'Maintenance System',
  ADMIN_ADDR: process.env.ADMIN_EMAIL    || '',
};
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// =============================================================
// DATABASE POOL
// =============================================================
const pool = mysql.createPool({
  ...DB,
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

// =============================================================
// MAILER
// =============================================================
const transporter = MAIL.USER ? nodemailer.createTransport({
  host:   MAIL.HOST,
  port:   MAIL.PORT,
  secure: false,
  auth:   { user: MAIL.USER, pass: MAIL.PASS },
}) : null;

//hourly cleanup of tokens
setInterval(async () => {
  pool.execute('DELETE FROM admin_tokens WHERE expires_at <= NOW()').catch(() => {});
  pool.execute('DELETE FROM email_verification_tokens WHERE expires_at <= NOW()').catch(() => {});
  pool.execute('DELETE FROM password_reset_tokens WHERE expires_at < NOW()').catch(() => {});
}, 3600000); // 1 hour

async function sendMail({ to, subject, html, requestId = null }) {
  let status = 'sent', errorMsg = null;
  try {
    if (transporter) {
      await transporter.sendMail({
        from: `"${MAIL.FROM_NAME}" <${MAIL.USER}>`,
        to, subject, html,
      });
    }
  } catch (e) {
    status   = 'failed';
    errorMsg = e.message;
    console.warn('[EMAIL FAILED]', e.message);
  }
  pool.execute(
    'INSERT INTO email_log (request_id, recipient, subject, body, status, error_msg) VALUES (?,?,?,?,?,?)',
    [requestId, to, subject, html, status, errorMsg]
  ).catch(() => {});
  return status === 'sent';
}

// =============================================================
// EMAIL HTML TEMPLATES
// =============================================================
function emailWrap(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:Arial,sans-serif;background:#f7f5f0;margin:0;padding:20px}
  .w{max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)}
  .h{background:#1a2f4a;color:#fff;padding:24px 28px}
  .h h1{margin:0;font-size:1.1rem;font-weight:600}
  .h p{margin:4px 0 0;font-size:.78rem;color:#a0b4c8}
  .b{padding:24px 28px;color:#1a1814;font-size:.9rem;line-height:1.7}
  .lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#6b6560;font-weight:600;margin-top:12px;margin-bottom:2px}
  .val{font-size:.9rem;font-weight:500;color:#1a2f4a}
  .track{display:flex;margin:16px 0}
  .step{flex:1;text-align:center;font-size:.62rem;font-weight:700;text-transform:uppercase;padding:6px 2px;color:#a0a09a;border-bottom:3px solid #e2ddd6}
  .done{color:#2d7a4f;border-bottom-color:#2d7a4f}
  .act{color:#2d5a8e;border-bottom-color:#2d5a8e}
  .rej{color:#b03030;border-bottom-color:#b03030}
  .note{background:#e8f0f9;border-left:3px solid #2d5a8e;padding:10px 14px;border-radius:4px;font-size:.85rem;color:#1a2f4a;margin-top:12px}
  .ft{background:#f0f0ed;padding:14px 28px;font-size:.72rem;color:#a0a09a;border-top:1px solid #e2ddd6}
</style></head><body><div class="w">
<div class="h"><h1>${title}</h1><p>Office Maintenance Request System</p></div>
<div class="b">${body}</div>
<div class="ft">Automated message — do not reply · © ${new Date().getFullYear()} Facilities Management</div>
</div></body></html>`;
}

function trackHtml(status) {
  const steps = ['pending', 'approved', 'in_progress', 'completed'];
  const idx   = steps.indexOf(status);
  return `<div class="track">${steps.map((s, i) => {
    let cls = '';
    if (status === 'rejected') cls = 'rej';
    else if (i < idx) cls = 'done';
    else if (i === idx) cls = 'act';
    return `<div class="step ${cls}">${s.replace('_', ' ')}</div>`;
  }).join('')}</div>`;
}

// =============================================================
// MULTER — file uploads (repair photos)
// =============================================================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const multerStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage: multerStorage,
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
  },
});

// =============================================================
// RATE LIMITER — login + reset endpoints
// =============================================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

// =============================================================
// MIDDLEWARE
// =============================================================
app.use(helmet({ contentSecurityPolicy: false })); // CSP false: inline scripts in index.html
app.use(cors({ origin: process.env.APP_URL || `http://localhost:3000`, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session store backed by MySQL
const sessionStore = new MySQLStore({
  host:      DB.host,
  port:      DB.port,
  user:      DB.user,
  password:  DB.password,
  database:  DB.database,
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
  createDatabaseTable: true,
});

app.use(session({
  key:               'maint_sid',
  secret:            process.env.SESSION_SECRET || 'dev-only-secret-CHANGE-in-production',
  store:             sessionStore,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   true, // true in prod (HTTPS)
    httpOnly: true,
    maxAge:   86400000,
    sameSite: 'none',
  },
}));

// Serve uploaded files and static assets
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiter to sensitive actions
app.use('/api', (req, res, next) => {
  const sensitiveActions = ['login', 'admin_login', 'forgot_password', 'reset_password'];
  const action = req.query.action || req.body?.action || '';
  if (sensitiveActions.includes(action)) return authLimiter(req, res, next);
  next();
});

// =============================================================
// HELPERS
// =============================================================
const ok  = (res, data = {})       => res.json({ success: true,  ...data });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const db  = ()                     => pool.getConnection();
function esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function genToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }

// ---------------------------------------------------------------
// PASSWORD STRENGTH VALIDATOR
// Rules: 8+ chars, uppercase, lowercase, digit, special char
// Returns null if valid, error string if invalid
// ---------------------------------------------------------------
function validatePassword(p) {
  if (!p || p.length < 8)        return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(p))          return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(p))          return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(p))          return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(p))   return 'Password must contain at least one special character (e.g. @#$!).';
  return null;
}

// Middleware: require logged-in staff session
function requireSession(req, res, next) {
  if (!req.session?.userId) return err(res, 'Not logged in. Please sign in.', 401);
  next();
}

// Middleware: require valid admin token (X-Admin-Token header or ?token= query)
async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return err(res, 'Admin token required.', 401);
  const conn = await db();
  try {
    const [rows] = await conn.execute(
      `SELECT at.user_id, u.name, u.email, u.role
       FROM admin_tokens at JOIN users u ON u.id = at.user_id
       WHERE at.token = ? AND at.expires_at > NOW()`,
      [token]
    );
    if (!rows.length) return err(res, 'Session expired. Please log in again.', 401);
    if (rows[0].role !== 'admin') return err(res, 'Access denied.', 403);
    req.admin = rows[0];
    next();
  } catch (e) {
    return err(res, 'Auth error: ' + e.message, 500);
  } finally { conn.release(); }
}

// =============================================================
// SERVER-SENT EVENTS — real-time push to connected clients
// =============================================================
const adminSSEClients  = new Map(); // adminId → res[]
const userSSEClients   = new Map(); // userId  → res[]
const sseTickets = new Map();

function pushToAdmins(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  adminSSEClients.forEach(resList => resList.forEach(r => { try { r.write(msg); } catch(e){} }));
}

function pushToUser(userId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const clients = userSSEClients.get(userId) || [];
  clients.forEach(r => { try { r.write(msg); } catch(e){} });
}

//POST /api/sse-ticket - exchange admin token for a one-time SSE ticket
app.post('/api/sse-ticket', async (req, res) =>{
  const token = req.headers['x-admin-token'];
  if (!token) return err(res, 'Admin token required.', 401);
  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT user_id From admin_tokens WHERE token = ? AND expires_at > Now()', [token]
    );
    if (!rows.length) return err(res, 'Invalid or expired token.', 401);
    const ticket = genToken(16);// 32-char one-time ticket
    sseTickets.set(ticket, {userId: rows[0].user_id, expires:Date.now() + 30000});
    setTimeout(() => sseTickets.delete(ticket), 30000); //auto-expire after 30s
    return ok(res, {ticket});
  }finally{conn.release();}
});

// GET /api/events — admin SSE stream
app.get('/api/events', async (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) return res.status(401).end();

  // validate and consume the one-time ticket
  const entry = sseTickets.get(ticket);
  if (!entry || Date.now() > entry.expires) return res.status(401).end();
  sseTickets.delete(ticket); // consume immediately — one use only

  const adminId = entry.userId;
  res.set({
  'Content-Type':  'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection':    'keep-alive',
  'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!adminSSEClients.has(adminId)) adminSSEClients.set(adminId, []);
  adminSSEClients.get(adminId).push(res);

    // Keep-alive ping every 25s
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e){} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      const list = adminSSEClients.get(adminId) || [];
      adminSSEClients.set(adminId, list.filter(r => r !== res));
    });
});

// GET /api/user-events — user SSE stream (session-auth)
app.get('/api/user-events', (req, res) => {
  if (!req.session?.userId) return res.status(401).end();
  const userId = req.session.userId;

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!userSSEClients.has(userId)) userSSEClients.set(userId, []);
  userSSEClients.get(userId).push(res);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e){} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    const list = userSSEClients.get(userId) || [];
    userSSEClients.set(userId, list.filter(r => r !== res));
  });
});

// POST /api/upload — photo upload (session-auth)
app.post('/api/upload', requireSession, upload.single('photo'), (req, res) => {
  if (!req.file) return err(res, 'No valid image uploaded.');
  ok(res, { path: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

// =============================================================
// MAIN ROUTE: POST /api?action=...
// =============================================================
async function route(req, res) {
  const action = req.query.action || req.body?.action || '';
  try {
    switch (action) {
      case 'test_connection':       return await handleTestConnection(req, res);
      case 'login':                 return await handleLogin(req, res);
      case 'logout':                return await handleLogout(req, res);
      case 'register':              return await handleRegister(req, res);
      case 'verify_email':          return await handleVerifyEmail(req, res);
      case 'resend_verification':   return await handleResendVerification(req, res);
      case 'forgot_password':       return await handleForgotPassword(req, res);
      case 'reset_password':        return await handleResetPassword(req, res);
      case 'change_password':       return await handleChangePassword(req, res);
      case 'update_profile':        return await handleUpdateProfile(req, res);
      case 'admin_login':           return await handleAdminLogin(req, res);
      case 'admin_change_password': return await handleAdminChangePassword(req, res);
      case 'new_request':           return await handleNewRequest(req, res);
      case 'my_requests':           return await handleMyRequests(req, res);
      case 'dashboard':             return await handleDashboard(req, res);
      case 'all_requests':          return await handleAllRequests(req, res);
      case 'update_status':         return await handleUpdateStatus(req, res);
      case 'delete_request':        return await handleDeleteRequest(req, res);
      case 'export_csv':            return await handleExportCSV(req, res);
      default:
        return err(res, `Unknown action: "${action}"`, 404);
    }
  } catch (e) {
    console.error(`[ERROR] action=${action}:`);
    console.error(e);
    return err(res, 'Server error: ' + e.message, 500);
  }
}

app.all('/api', route);

// =============================================================
// ACTION: test_connection
// =============================================================
async function handleTestConnection(req, res) {
  const conn = await db();
  try {
    await conn.execute('SELECT 1');
    const [tables] = await conn.execute('SHOW TABLES');
    return ok(res, { message: 'Database connected.', tables: tables.length });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: register
// Auto-sends email verification code after registration.
// Account is created immediately but email_verified = 0
// until the user submits the code.
// =============================================================
async function handleRegister(req, res) {
  const { name, department, floor_office, designation, email, password } = req.body;

  if (!name || !department || !floor_office || !designation || !email || !password)
    return err(res, 'All fields are required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return err(res, 'Invalid email address.');

  const pwErr = validatePassword(password);
  if (pwErr) return err(res, pwErr);

  const conn = await db();
  try {
    const [exists] = await conn.execute(
      'SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]
    );
    if (exists.length) return err(res, 'An account with this email already exists.');

    const hash = await bcrypt.hash(password, 12);
    const [result] = await conn.execute(
      'INSERT INTO users (name, department, floor_office, designation, email, password_hash, role, email_verified) VALUES (?,?,?,?,?,?,?,?)',
      [name.trim(), department, floor_office.trim(), designation.trim(),
       email.toLowerCase().trim(), hash, 'user', 0]
    );
    const userId = result.insertId;

    // Generate 6-digit verification code
    const code    = String(crypto.randomInt(100000, 1000000));

    await conn.execute(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?,?, DATE_ADD(NOW(), INTERVAL 30 MINUTE)) ON DUPLICATE KEY UPDATE token=VALUES(token), expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE)`,
      [userId, code]
    );

    sendMail({
      to: email,
      subject: 'Verify your email — Office Maintenance System',
      html: emailWrap('Verify Your Email', `
        <p>Hi <strong>${name.trim()}</strong>,</p>
        <p>Your account has been created. Enter the code below to activate it.</p>
        <div style="text-align:center;margin:24px 0">
          <div style="font-size:2rem;font-weight:700;letter-spacing:.2em;color:#1a2f4a;background:#f0f5fb;padding:1rem;border-radius:8px">${code}</div>
        </div>
        <p style="color:#6b6560;font-size:.85rem">This code expires in 30 minutes. If you didn't sign up, ignore this email.</p>
      `),
    });

    return ok(res, {
      message:    'Account created. Check your email for a verification code.',
      user_id:    userId,
      needs_verification: true,
    });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: verify_email
// =============================================================
async function handleVerifyEmail(req, res) {
  const { user_id, code } = req.body;
  if (!user_id || !code) return err(res, 'user_id and code are required.');

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT id FROM email_verification_tokens WHERE user_id = ? AND token = ? AND expires_at > NOW()',
      [user_id, code.trim()]
    );
    if (!rows.length) return err(res, 'Invalid or expired verification code.');

    await conn.execute('UPDATE users SET email_verified = 1 WHERE id = ?', [user_id]);
    await conn.execute('DELETE FROM email_verification_tokens WHERE user_id = ?', [user_id]);

    // Auto-login after verification
    const [userRows] = await conn.execute(
      'SELECT id, name, department, floor_office, designation, email, role FROM users WHERE id = ?', [user_id]
    );
    const user = userRows[0];
    req.session.userId = user.id;
    await new Promise((resolve, reject) => {
    req.session.save(err => {
    if (err) reject(err);
    else resolve();
      });
    });

    return ok(res, { message: 'Email verified. Welcome!', user });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: resend_verification
// =============================================================
async function handleResendVerification(req, res) {
  const { user_id } = req.body;
  if (!user_id) return err(res, 'user_id is required.');

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT id, name, email FROM users WHERE id = ? AND email_verified = 0', [user_id]
    );
    if (!rows.length) return err(res, 'Account not found or already verified.');

    const code    = String(crypto.randomInt(100000, 1000000));
    

    await conn.execute(
      'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?,?, DATE_ADD(NOW(), INTERVAL 30 MINUTE)) ON DUPLICATE KEY UPDATE token=VALUES(token), expires_at=DATE_ADD(NOW(), INTERVAL 30 MINUTE)',
      [user_id, code]
    );

    sendMail({
      to: rows[0].email,
      subject: 'New Verification Code — Office Maintenance System',
      html: emailWrap('New Verification Code', `
        <p>Hi <strong>${rows[0].name}</strong>, here is your new code:</p>
        <div style="text-align:center;margin:24px 0">
          <div style="font-size:2rem;font-weight:700;letter-spacing:.2em;color:#1a2f4a;background:#f0f5fb;padding:1rem;border-radius:8px">${code}</div>
        </div>
        <p style="color:#6b6560;font-size:.85rem">Expires in 30 minutes.</p>
      `),
    });

    return ok(res, { message: 'New verification code sent.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: login
// =============================================================
async function handleLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'Email and password are required.');

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT id, name, department, floor_office, designation, email, password_hash, role, is_active, email_verified FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return err(res, 'No account found with this email address.', 401);
    const user = rows[0];
    if (!user.is_active) return err(res, 'Your account has been deactivated.', 403);
    if (user.role === 'admin') return err(res, 'Please use the Admin Panel to log in as an administrator.', 403);

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return err(res, 'Incorrect password. Please try again.', 401);

    if (!user.email_verified) {
      return res.json({
        success: false,
        needs_verification: true,
        user_id: user.id,
        message: 'Please verify your email before logging in.',
      });
    }

    req.session.userId = user.id;
    await new Promise((resolve, reject) => {
    req.session.save(err => {
    if (err) reject(err);
      else resolve();
      });
    });
    delete user.password_hash;
    delete user.email_verified;
    return ok(res, { user });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: logout
// =============================================================
async function handleLogout(req, res) {
  req.session.destroy(() => ok(res, { message: 'Logged out.' }));
}

// =============================================================
// ACTION: forgot_password
// BUG FIX: removed `AND role = 'user'` so admins can also reset
// BUG FIX: queries password_reset_tokens (not password_resets)
// =============================================================
async function handleForgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return err(res, 'Email is required.');

  const conn = await db();
  try {
    // No role filter — works for both users and admins
    const [rows] = await conn.execute(
      'SELECT id, name FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase().trim()]
    );

    if (rows.length) {
      // 16-char hex token (was 6 — more secure)
      const token = genToken(8).toUpperCase(); // 16 hex chars
       
      // FIXED: correct table name is 
    await conn.execute(
      `INSERT INTO password_reset_tokens
      (user_id, token, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))
      ON DUPLICATE KEY UPDATE
      token = VALUES(token),
      expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE)`,
      [rows[0].id, token]
    );

      sendMail({
        to: email,
        subject: 'Password Reset Code — Office Maintenance System',
        html: emailWrap('Password Reset', `
          <p>Hi <strong>${rows[0].name}</strong>,</p>
          <p>Use the code below to reset your password. It expires in 30 minutes.</p>
          <div style="text-align:center;margin:24px 0">
            <div style="font-size:2rem;font-weight:700;letter-spacing:.2em;color:#1a2f4a;background:#f0f5fb;padding:1rem;border-radius:8px">${token}</div>
          </div>
          <p>If you did not request this, ignore this email.</p>
        `),
      });
    }

    return ok(res, { message: 'If that email exists, a reset code has been sent.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: reset_password
// BUG FIX: queries password_reset_tokens (not password_resets)
// IMPROVEMENT: uses validatePassword() helper
// =============================================================
async function handleResetPassword(req, res) {
  const { email, token, password, confirm_password } = req.body;
  if (!email || !token || !password || !confirm_password)
    return err(res, 'All fields are required.');
  if (password !== confirm_password)
    return err(res, 'Passwords do not match.');

  const pwErr = validatePassword(password);
  if (pwErr) return err(res, pwErr);

  const conn = await db();
  try {
    // FIXED: correct table name is password_reset_tokens
    const [rows] = await conn.execute(
      `SELECT prt.id, prt.user_id FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE u.email = ? AND prt.token = ? AND prt.expires_at > NOW()`,
      [email.toLowerCase().trim(), token.trim().toUpperCase()]
    );
    if (!rows.length) return err(res, 'Invalid or expired reset code.', 400);

    const hash = await bcrypt.hash(password, 12);
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, rows[0].user_id]);
    // FIXED: correct table name
    await conn.execute('DELETE FROM password_reset_tokens WHERE id = ?', [rows[0].id]);

    return ok(res, { message: 'Password reset successfully. Please sign in.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: change_password  (logged-in user via session)
// =============================================================
async function handleChangePassword(req, res) {
  if (!req.session?.userId) return err(res, 'Not logged in.', 401);

  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password)
    return err(res, 'All fields are required.');
  if (new_password !== confirm_password)
    return err(res, 'New passwords do not match.');

  const pwErr = validatePassword(new_password);
  if (pwErr) return err(res, pwErr);

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [req.session.userId]
    );
    if (!rows.length) return err(res, 'Account not found.', 404);

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return err(res, 'Current password is incorrect.', 401);

    const hash = await bcrypt.hash(new_password, 12);
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.userId]);

    return ok(res, { message: 'Password changed successfully.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: admin_change_password  (admin — via token)
// =============================================================
async function handleAdminChangePassword(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) return err(res, 'Admin token required.', 401);

  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password)
    return err(res, 'All fields are required.');
  if (new_password !== confirm_password)
    return err(res, 'New passwords do not match.');

  const pwErr = validatePassword(new_password);
  if (pwErr) return err(res, pwErr);

  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired admin token.', 401);

    const [rows] = await conn.execute(
      'SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [tRows[0].user_id]
    );
    if (!rows.length) return err(res, 'Account not found.', 404);

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return err(res, 'Current password is incorrect.', 401);

    const hash = await bcrypt.hash(new_password, 12);
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, tRows[0].user_id]);

    return ok(res, { message: 'Password changed successfully.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: update_profile  (logged-in user)
// =============================================================
async function handleUpdateProfile(req, res) {
  if (!req.session?.userId) return err(res, 'Not logged in.', 401);
  const { name, floor_office, designation } = req.body;

  if (!name || !floor_office || !designation)
    return err(res, 'Name, floor/office, and designation are required.');

  const conn = await db();
  try {
    await conn.execute(
      'UPDATE users SET name = ?, floor_office = ?, designation = ? WHERE id = ?',
      [name.trim(), floor_office.trim(), designation.trim(), req.session.userId]
    );
    const [rows] = await conn.execute(
      'SELECT id, name, department, floor_office, designation, email, role FROM users WHERE id = ?',
      [req.session.userId]
    );
    return ok(res, { user: rows[0], message: 'Profile updated.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: admin_login
// =============================================================
async function handleAdminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'Email and password are required.');

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      'SELECT id, name, department, floor_office, designation, email, password_hash, role, is_active FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return err(res, 'No admin account found with this email.', 401);
    const user = rows[0];
    if (user.role !== 'admin') return err(res, 'This account does not have admin access.', 403);
    if (!user.is_active) return err(res, 'This account is deactivated.', 403);

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return err(res, 'Incorrect password.', 401);

    await conn.execute('DELETE FROM admin_tokens WHERE user_id = ? OR expires_at <= NOW()', [user.id]);
    const token   = genToken(64);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);

    
    await conn.execute(
      'INSERT INTO admin_tokens (user_id, token, expires_at) VALUES (?,?,?)',
      [user.id, token, expires.toISOString().slice(0, 19).replace('T', ' ')]
    );

    delete user.password_hash;
    return ok(res, { user, token });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: new_request
// Supports:
//   - new_item: items[] array (existing)
//   - repair:   items[] array (NOW multi-item, each with own
//               issue_description, asset_tag, photo_path)
// =============================================================
async function handleNewRequest(req, res) {
  if (!req.session?.userId) return err(res, 'Not logged in.', 401);
  const userId = req.session.userId;

  const {
    request_type, priority = 'med', notes = '',
    items, required_by,
    // legacy single-repair fields kept for backwards compat
    item_name, asset_tag, issue_description, preferred_date,
  } = req.body;

  if (!request_type) return err(res, 'request_type is required.');
  if (!['new_item', 'repair'].includes(request_type)) return err(res, 'Invalid request_type.');
  if (!['low', 'med', 'high'].includes(priority)) return err(res, 'Invalid priority.');

  const conn = await db();
  try {
    const [userRows] = await conn.execute(
      'SELECT id, name, email, department, floor_office FROM users WHERE id = ? AND is_active = 1',
      [userId]
    );
    if (!userRows.length) return err(res, 'User not found.', 401);
    const user = userRows[0];

    const insertedIds = [];

    if (request_type === 'new_item') {
      if (!items || !Array.isArray(items) || items.length === 0)
        return err(res, 'At least one item must be selected.');

      for (const { item_key, item_label, quantity, item_notes } of items) {
        if (!item_label) continue;
        const qty = Math.max(1, parseInt(quantity) || 1);
        const [result] = await conn.execute(
          `INSERT INTO maintenance_requests
           (user_id, request_type, item_name, priority, notes, quantity, required_by)
           VALUES (?,?,?,?,?,?,?)`,
          [userId, 'new_item', item_label, priority,
           item_notes || notes || null, qty, required_by || null]
        );
        insertedIds.push(result.insertId);
      }

      const itemList = items.map(i => `${i.item_label} × ${i.quantity}`).join(', ');
      const firstId  = insertedIds[0];

      sendMail({
        to: user.email, requestId: firstId,
        subject: `[#${firstId}] New Item Request Submitted`,
        html: emailWrap('New Item Request Received ✅', `
          <p>Hi <strong>${esc(user.name)}</strong>,</p>
          <p>Your request has been received and is under review.</p>
          <div class="lbl">Items Requested</div><div class="val">${esc(itemList)}</div>
          ${required_by ? `<div class="lbl">Required By</div><div class="val">${required_by}</div>` : ''}
          <div class="lbl">Priority</div><div class="val">${priority === 'med' ? 'Medium' : priority}</div>
          ${notes ? `<div class="lbl">Your Notes</div><div class="val">${esc(notes)}</div>` : ''}
          ${trackHtml('pending')}
        `),
      });

      if (MAIL.ADMIN_ADDR) {
        sendMail({
          to: MAIL.ADMIN_ADDR, requestId: firstId,
          subject: `[NEW REQUEST] ${user.name} requested: ${itemList}`,
          html: emailWrap('New Item Request', `
            <p>A new item request needs your review.</p>
            <div class="lbl">Requester</div><div class="val">${esc(user.name)}</div>
            <div class="lbl">Department</div><div class="val">${esc(user.department)}</div>
            <div class="lbl">Location</div><div class="val">${esc(user.floor_office)}</div>
            <div class="lbl">Items</div><div class="val">${esc(itemList)}</div>
            <div class="lbl">Priority</div><div class="val">${esc(priority)}</div>
            ${notes ? `<div class="lbl">Notes</div><div class="val">${esc(notes)}</div>` : ''}
            <p><a href="${APP_URL}">Open Admin Panel →</a></p>
          `),
        });
      }

      // SSE push to all connected admins
      pushToAdmins('new_request', { type: 'new_item', items: itemList, requester: user.name, department: user.department });

    } else {
      // REPAIR — now supports multiple items array
      // Also support legacy single-item submission
      let repairItems = items;
      if (!repairItems || !Array.isArray(repairItems) || repairItems.length === 0) {
        // Legacy single-item fallback
        if (!item_name) return err(res, 'item_name is required for repairs.');
        if (!issue_description) return err(res, 'issue_description is required for repairs.');
        repairItems = [{ item_name, asset_tag, issue_description, preferred_date, photo_path: null, notes }];
      }

      for (const item of repairItems) {
        if (!item.item_name) continue;
        if (!item.issue_description) return err(res, `Issue description required for item: ${item.item_name}`);

        const [result] = await conn.execute(
          `INSERT INTO maintenance_requests
           (user_id, request_type, item_name, priority, notes, asset_tag,
            issue_description, preferred_date, photo_path)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [userId, 'repair', item.item_name, priority,
           item.notes || notes || null,
           item.asset_tag || null,
           item.issue_description,
           item.preferred_date || preferred_date || null,
           item.photo_path || null]
        );
        insertedIds.push(result.insertId);
      }

      const repairSummary = repairItems.map(i => i.item_name).join(', ');
      const firstId = insertedIds[0];

      sendMail({
        to: user.email, requestId: firstId,
        subject: `[#${firstId}] Repair Request Submitted — ${esc(repairSummary)}`,
        html: emailWrap('Repair Request Received ✅', `
          <p>Hi <strong>${esc(user.name)}</strong>,</p>
          <p>Your repair request has been received and is under review.</p>
          ${repairItems.map(i => `
            <div style="border-left:3px solid #2d5a8e;padding:8px 12px;margin:8px 0;background:#f8f9fc">
              <div class="lbl">Item</div><div class="val">${esc(i.item_name)}</div>
              <div class="lbl">Issue</div><div class="val">${esc(i.issue_description)}</div>
              ${i.asset_tag ? `<div class="lbl">Asset Tag</div><div class="val">${esc(i.asset_tag)}</div>` : ''}
              ${i.notes ? `<div class="lbl">Notes</div><div class="val">${esc(i.notes)}</div>` : ''}
            </div>
          `).join('')}
          <div class="lbl">Priority</div><div class="val">${esc(priority === 'med' ? 'Medium' : priority)}</div>
          ${trackHtml('pending')}
        `),
      });

      if (MAIL.ADMIN_ADDR) {
        sendMail({
          to: MAIL.ADMIN_ADDR, requestId: firstId,
          subject: `[REPAIR] ${esc(user.name)} — ${esc(repairSummary)} (${esc(user.department)})`,
          html: emailWrap('New Repair Request', `
            <p>A repair request needs your review.</p>
            <div class="lbl">Requester</div><div class="val">${esc(user.name)}</div>
            <div class="lbl">Department</div><div class="val">${esc(user.department)}</div>
            ${repairItems.map(i => `
              <div style="border-left:3px solid #c47a2d;padding:8px 12px;margin:8px 0;background:#fdf8f0">
                <div class="lbl">Item</div><div class="val">${esc(i.item_name)}</div>
                <div class="lbl">Issue</div><div class="val">${esc(i.issue_description)}</div>
                ${i.asset_tag ? `<div class="lbl">Asset Tag</div><div class="val">${esc(i.asset_tag)}</div>` : ''}
              </div>
            `).join('')}
            <div class="lbl">Priority</div><div class="val">${priority}</div>
            <p><a href="${APP_URL}">Open Admin Panel →</a></p>
          `),
        });
      }

      pushToAdmins('new_request', { type: 'repair', items: repairSummary, requester: user.name, department: user.department });
    }

    return ok(res, { request_ids: insertedIds, message: 'Request submitted successfully.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: my_requests
// =============================================================
async function handleMyRequests(req, res) {
  if (!req.session?.userId) return err(res, 'Not logged in.', 401);

  const conn = await db();
  try {
    const [rows] = await conn.execute(
      `SELECT id, request_type, item_name, quantity, required_by,
              asset_tag, issue_description, preferred_date, photo_path,
              priority, notes, status, admin_notes,
              DATE_FORMAT(created_at, '%d %b %Y %H:%i') AS created_at,
              DATE_FORMAT(updated_at, '%d %b %Y %H:%i') AS updated_at
       FROM maintenance_requests
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.session.userId]
    );
    return ok(res, { requests: rows });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: dashboard  (admin only)
// =============================================================
async function handleDashboard(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return err(res, 'Admin token required.', 401);
  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired admin token.', 401);

    const [[sc]] = await conn.execute(`
      SELECT
        COALESCE(SUM(status='pending'),0)     AS pending,
        COALESCE(SUM(status='approved'),0)    AS approved,
        COALESCE(SUM(status='in_progress'),0) AS in_progress,
        COALESCE(SUM(status='completed'),0)   AS completed,
        COALESCE(SUM(status='rejected'),0)    AS rejected
      FROM maintenance_requests`);

    const [[tc]] = await conn.execute(`
      SELECT
        COALESCE(SUM(request_type='new_item'),0) AS new_item,
        COALESCE(SUM(request_type='repair'),0)   AS repair
      FROM maintenance_requests`);

    const [byDept] = await conn.execute(`
      SELECT u.department, COUNT(*) AS cnt
      FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id
      GROUP BY u.department ORDER BY cnt DESC LIMIT 10`);

    const [recent] = await conn.execute(`
      SELECT mr.id, mr.item_name, mr.request_type, mr.status, mr.priority,
             mr.notes, mr.issue_description,
             u.name AS requester, u.department,
             DATE_FORMAT(mr.created_at, '%d %b %Y %H:%i') AS created_at
      FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id
      ORDER BY mr.created_at DESC LIMIT 8`);

    return ok(res, { stats: { status_counts: sc, type_counts: tc, by_department: byDept, recent } });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: all_requests  (admin only)
// IMPROVEMENT: now returns photo_path so admin can view photos
// =============================================================
async function handleAllRequests(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return err(res, 'Admin token required.', 401);

  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired admin token.', 401);

    const {
      status, type, priority, department, search,
      date_from, date_to, page = 1, per_page = 20
    } = req.query;

    const conditions = ['1=1'];
    const params     = [];

    if (status)     { conditions.push('mr.status = ?');        params.push(status); }
    if (type)       { conditions.push('mr.request_type = ?');  params.push(type); }
    if (priority)   { conditions.push('mr.priority = ?');      params.push(priority); }
    if (department) { conditions.push('u.department = ?');     params.push(department); }
    if (date_from)  { conditions.push('mr.created_at >= ?');   params.push(date_from + ' 00:00:00'); }
    if (date_to)    { conditions.push('mr.created_at <= ?');   params.push(date_to   + ' 23:59:59'); }
    if (search) {
      conditions.push('(u.name LIKE ? OR u.email LIKE ? OR mr.item_name LIKE ? OR mr.asset_tag LIKE ? OR mr.issue_description LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }

    const where  = conditions.join(' AND ');
    const pageNum    = Math.max(1, parseInt(page)     || 1);
    const perPageNum = Math.max(1, parseInt(per_page) || 20);
    const offset     = (pageNum - 1) * perPageNum;

    console.log('PAGINATION PARAMS:', { page, per_page, pageNum, perPageNum, offset, params });
    const [[{ total }]] = await conn.execute(
      `SELECT COUNT(*) AS total FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id WHERE ${where}`,
      params
    );

    const [rows] = await conn.execute(
      `SELECT mr.id, mr.request_type, mr.item_name, mr.quantity, mr.required_by,
              mr.asset_tag, mr.issue_description, mr.preferred_date,
              mr.priority, mr.status, mr.notes, mr.admin_notes,
              mr.photo_path,
              DATE_FORMAT(mr.created_at, '%d %b %Y %H:%i') AS created_at,
              DATE_FORMAT(mr.updated_at, '%d %b %Y %H:%i') AS updated_at,
              u.id AS user_id, u.name AS requester_name, u.department,
              u.floor_office, u.email AS requester_email, u.designation
       FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id
       WHERE ${where}
       ORDER BY FIELD(mr.priority,'high','med','low'), mr.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(perPageNum), Number(offset)]
    );

    return ok(res, {
      requests: rows,
      pagination: {
        total: parseInt(total),
        page: pageNum,
        per_page: perPageNum,
        pages: Math.max(1, Math.ceil(total / perPageNum)),
}
    });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: update_status  (admin only)
// IMPROVEMENT: SSE push to requester on status change
// =============================================================
async function handleUpdateStatus(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) return err(res, 'Admin token required.', 401);

  const { request_id, status, admin_notes = '' } = req.body;
  const valid = ['pending', 'approved', 'in_progress', 'completed', 'rejected'];
  if (!request_id) return err(res, 'request_id is required.');
  if (!valid.includes(status)) return err(res, 'Invalid status value.');

  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired admin token.', 401);
    const adminId = tRows[0].user_id;

    const [rows] = await conn.execute(
      `SELECT mr.*, u.name AS requester_name, u.email AS requester_email
       FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id
       WHERE mr.id = ?`,
      [request_id]
    );
    if (!rows.length) return err(res, 'Request not found.', 404);
    const req_ = rows[0];

    await conn.execute(
      'UPDATE maintenance_requests SET status = ?, admin_notes = ?, updated_at = NOW() WHERE id = ?',
      [status, admin_notes || null, request_id]
    );

    await conn.execute(
      'INSERT INTO request_audit_log (request_id, changed_by, old_status, new_status, comment) VALUES (?,?,?,?,?)',
      [request_id, adminId, req_.status, status, admin_notes || null]
    );

    const labels = {
      pending:'Pending', approved:'Approved',
      in_progress:'In Progress', completed:'Completed', rejected:'Rejected',
    };

    // SSE push to the requester's connected browser
    pushToUser(req_.user_id, 'status_update', {
      request_id: parseInt(request_id),
      status,
      status_label: labels[status],
      item_name: req_.item_name,
      admin_notes: admin_notes || null,
    });

    sendMail({
      to: req_.requester_email, requestId: request_id,
      subject: `[#${request_id}] Your request is now: ${labels[status]} — ${esc(req_.item_name)}`,
      html: emailWrap('Request Status Update', `
        <p>Hi <strong>${esc(req_.requester_name)}</strong>,</p>
        <p>Your maintenance request has been updated by the Facilities team.</p>
        <div class="lbl">Request ID</div><div class="val">#${request_id}</div>
        <div class="lbl">Item</div><div class="val">${esc(req_.item_name)}</div>
        <div class="lbl">New Status</div><div class="val"><strong>${labels[status]}</strong></div>
        ${trackHtml(status)}
        ${admin_notes ? `<div class="note"><strong>Message from Facilities Team:</strong><br/>${esc(admin_notes)}</div>` : ''}
        <p style="margin-top:16px">Visit <a href="${APP_URL}">${APP_URL}</a> to track your request.</p>
      `),
    });

    return ok(res, { message: `Status updated to "${status}". Requester notified.` });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: delete_request  (admin only)
// =============================================================
async function handleDeleteRequest(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) return err(res, 'Admin token required.', 401);

  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired token.', 401);

    const id = req.body.request_id;
    if (!id) return err(res, 'request_id is required.');

    const [result] = await conn.execute('DELETE FROM maintenance_requests WHERE id = ?', [id]);
    if (!result.affectedRows) return err(res, 'Request not found.', 404);

    return ok(res, { message: 'Request deleted.' });
  } finally { conn.release(); }
}

// =============================================================
// ACTION: export_csv  (admin only, GET)
// =============================================================
async function handleExportCSV(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return err(res, 'Admin token required.', 401);

  const conn = await db();
  try {
    const [tRows] = await conn.execute(
      'SELECT user_id FROM admin_tokens WHERE token = ? AND expires_at > NOW()', [token]
    );
    if (!tRows.length) return err(res, 'Invalid or expired token.', 401);

    const { status, type, priority, department, search, date_from, date_to } = req.query;
    const conditions = ['1=1'], params = [];
    if (status)     { conditions.push('mr.status = ?');        params.push(status); }
    if (type)       { conditions.push('mr.request_type = ?');  params.push(type); }
    if (priority)   { conditions.push('mr.priority = ?');      params.push(priority); }
    if (department) { conditions.push('u.department = ?');     params.push(department); }
    if (date_from)  { conditions.push('mr.created_at >= ?');   params.push(date_from + ' 00:00:00'); }
    if (date_to)    { conditions.push('mr.created_at <= ?');   params.push(date_to   + ' 23:59:59'); }
    if (search) {
      conditions.push('(u.name LIKE ? OR u.email LIKE ? OR mr.item_name LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q);
    }

    const [rows] = await conn.execute(
      `SELECT mr.id AS ID, u.name AS Requester, u.department AS Department,
              u.floor_office AS 'Floor/Office', u.email AS Email,
              mr.item_name AS Item, mr.request_type AS Type,
              mr.quantity AS Quantity, mr.priority AS Priority,
              mr.status AS Status, mr.issue_description AS Issue,
              mr.asset_tag AS 'Asset Tag', mr.required_by AS 'Required By',
              mr.preferred_date AS 'Preferred Date',
              mr.notes AS Notes, mr.admin_notes AS 'Admin Notes',
              mr.created_at AS Submitted
       FROM maintenance_requests mr JOIN users u ON u.id = mr.user_id
       WHERE ${conditions.join(' AND ')} ORDER BY mr.created_at DESC`,
      params
    );

    const headers = rows.length ? Object.keys(rows[0]) : ['No data'];
    const csv = [
      headers.map(h => `"${h}"`).join(','),
      ...rows.map(row =>
        headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(',')
      )
    ].join('\n');

    const filename = `requests_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } finally { conn.release(); }
}
// =============================================================
// CATCH-ALL — serve index.html
// =============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================
// STARTUP
// =============================================================
async function start() {
  console.log('\n========================================');
  console.log('  Office Maintenance System v5.0');
  console.log('========================================');

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.execute('SELECT 1');
    console.log('✅ Database connected: maintenance_db');
  } catch (e) {
    console.error('❌ Database connection FAILED:', e.message);
    if (e.code === 'ECONNREFUSED')        console.error('   → MySQL is not running.');
    if (e.code === 'ER_BAD_DB_ERROR')     console.error('   → Import database.sql into phpMyAdmin first.');
    if (e.code === 'ER_ACCESS_DENIED_ERROR') console.error('   → Wrong DB user/password.');
  } finally {
    if (conn) conn.release();
  }

  // Try listening, with a small fallback if the port is in use to provide
  // a clearer error message and optionally attempt the next ports.
  function tryListen(port, attempts = 3) {
    const server = app.listen(port, () => {
      console.log(`✅ Server running at: http://localhost:${port}`);
      console.log(`   Admin login:       admin@organisation.com`);
      console.log('========================================\n');
    });

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use.`);
        if (attempts > 0) {
          const next = port + 1;
          console.warn(`Attempting to listen on port ${next} instead (${attempts} attempts left)...`);
          setTimeout(() => tryListen(next, attempts - 1), 300);
          return;
        }
        console.error('No available ports found. Please stop the process using the port or set a different PORT.');
        process.exit(1);
      } else {
        console.error('Server error:', err && err.message ? err.message : err);
        process.exit(1);
      }
    });
  }

  tryListen(PORT, 3);
}

start();