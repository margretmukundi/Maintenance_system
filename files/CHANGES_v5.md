# Office Maintenance System — v5.0 Change Log & Documentation

## Quick summary

This document maps every change made from v4.0 to v5.0.  
Use it as a reference when applying changes in VS Code or reviewing diffs.

---

## 1. Critical bug fixes

### 1.1 Password reset — wrong table name
**File:** `server.js`  
**Functions:** `handleForgotPassword`, `handleResetPassword`

**Problem:**  
The SQL schema creates `password_reset_tokens` but the server was querying `password_resets` in some error paths, causing:
```
SQLSTATE[42502]: Base table or view not found: 1146 Table 'maintenance_db.password_resets'
```

**Fix (lines changed):**
```diff
- 'INSERT INTO password_resets (user_id, token, expires_at) ...'
+ 'INSERT INTO password_reset_tokens (user_id, token, expires_at) ...'

- 'SELECT ... FROM password_resets prt JOIN users ...'
+ 'SELECT ... FROM password_reset_tokens prt JOIN users ...'

- 'DELETE FROM password_resets WHERE id = ?'
+ 'DELETE FROM password_reset_tokens WHERE id = ?'
```

---

### 1.2 Admin password reset was blocked
**File:** `server.js`  
**Function:** `handleForgotPassword`

**Problem:**  
The WHERE clause filtered `AND role = 'user'`, which silently excluded admin accounts. Admins received "code sent" but no email was ever dispatched, and no token was saved.

**Fix:**
```diff
- WHERE email = ? AND is_active = 1 AND role = 'user'
+ WHERE email = ? AND is_active = 1
```

---

### 1.3 Session secret was hardcoded
**File:** `server.js` — session middleware

**Problem:**  
A hardcoded secret means anyone who reads the source code can forge session cookies for any user account.

**Fix:**
```diff
- secret: 'maint-secret-key-change-in-production',
+ secret: process.env.SESSION_SECRET || 'dev-only-secret-CHANGE-in-production',
```

**Also added:** `.env.example` now includes `SESSION_SECRET` with clear instructions.  
In production (`NODE_ENV=production`), the server will refuse to start if `SESSION_SECRET` is not set.

---

## 2. Security improvements

### 2.1 Rate limiting
**File:** `server.js` — middleware section  
**Package added:** `express-rate-limit ^7.1.5`

Limits login, admin_login, forgot_password, and reset_password to 8 attempts per IP per 15 minutes.

```js
// New in v5.0
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 8, ... });
app.use('/api', (req,res,next) => {
  const sensitiveActions = ['login','admin_login','forgot_password','reset_password'];
  if (sensitiveActions.includes(action)) return authLimiter(req,res,next);
  next();
});
```

---

### 2.2 Helmet.js HTTP headers
**File:** `server.js` — middleware section  
**Package added:** `helmet ^7.1.0`

Adds X-Frame-Options, X-XSS-Protection, Strict-Transport-Security, and other standard security headers automatically.

```diff
+ app.use(helmet({ contentSecurityPolicy: false }));
```

`contentSecurityPolicy: false` is used because index.html uses inline scripts. You can enable it later with a nonce if you refactor the frontend to use external JS files.

---

### 2.3 Stronger reset tokens
**File:** `server.js` — `handleForgotPassword`

```diff
- const token = genToken(3); // 6-char hex = ~16M combinations
+ const token = genToken(4); // 8-char hex = ~4 billion combinations
```

---

### 2.4 Secure cookie in production
**File:** `server.js` — session config

```diff
- secure: false,
+ secure: process.env.NODE_ENV === 'production',
```

When `NODE_ENV=production`, the session cookie is only sent over HTTPS.

---

## 3. New feature: password strength validation

**File:** `server.js` — new helper function  
**Applied in:** `handleRegister`, `handleResetPassword`, `handleChangePassword`, `handleAdminChangePassword`

```js
function validatePassword(p) {
  if (!p || p.length < 8)       return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(p))         return 'At least one uppercase letter required.';
  if (!/[a-z]/.test(p))         return 'At least one lowercase letter required.';
  if (!/[0-9]/.test(p))         return 'At least one number required.';
  if (!/[^A-Za-z0-9]/.test(p))  return 'At least one special character required.';
  return null; // null = valid
}
```

**Frontend (index.html):** Add a live strength meter under every password input field. The bar shows 4 segments that fill up as the password meets each rule. Rules checklist appears below showing which criteria are still unmet (ticked in green when met).

---

## 4. New feature: change_password action

**File:** `server.js` — new functions `handleChangePassword`, `handleAdminChangePassword`

Two new route cases:
- `change_password` — for logged-in users (session-auth)
- `admin_change_password` — for admins (token-auth)

Both require: `current_password`, `new_password`, `confirm_password`.

**Frontend (index.html):** Add a "Settings" page (tab in the main nav) with:
- Profile tab: edit name, floor/office, designation
- Security tab: change password form with strength meter

---

## 5. New feature: email verification on registration

**Files:** `server.js`, `database.sql`, `index.html`

### Database changes
```sql
-- New column on users table
email_verified TINYINT(1) NOT NULL DEFAULT 0

-- New table
CREATE TABLE email_verification_tokens (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  token      VARCHAR(10)  NOT NULL,
  expires_at DATETIME     NOT NULL,
  UNIQUE KEY uq_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Backend flow
1. User registers → account created with `email_verified = 0`
2. 6-digit code emailed to them (expires 30 min)
3. `verify_email` action validates code → sets `email_verified = 1` → auto-logs in
4. `login` action returns `needs_verification: true` if `email_verified = 0`
5. `resend_verification` action for "Resend code" button

### Frontend flow
After register, show a "Check your email" screen with a 6-digit code input.  
Show a "Resend code" link. After entering the correct code, auto-login.

---

## 6. New feature: real-time updates via SSE

**File:** `server.js` — two new GET endpoints, no extra packages needed

### How it works
- `GET /api/events?token=…` — admin SSE stream (token-auth)
- `GET /api/user-events` — user SSE stream (session-auth)

On status update: server pushes `status_update` event to the requester's SSE connection.  
On new request: server pushes `new_request` event to all connected admin SSE clients.

### Frontend integration
```js
// In user panel
const sse = new EventSource('/api/user-events');
sse.addEventListener('status_update', e => {
  const data = JSON.parse(e.data);
  // Show toast: "Your request #X is now: Approved"
  // Refresh my_requests list
});

// In admin panel
const sse = new EventSource(`/api/events?token=${adminToken}`);
sse.addEventListener('new_request', e => {
  const data = JSON.parse(e.data);
  // Show notification badge
  // Auto-refresh requests table
});
```

---

## 7. New feature: photo upload for repair requests

**Files:** `server.js`, `database.sql`  
**Package added:** `multer ^1.4.5-lts.1`

### Database change
```sql
ALTER TABLE maintenance_requests
  ADD COLUMN photo_path VARCHAR(255) DEFAULT NULL
  AFTER issue_description;
```

### Backend
```
POST /api/upload
  Auth: session required
  Body: multipart/form-data, field name "photo"
  Returns: { path: "/uploads/filename.jpg", filename: "..." }
  Limits: 5 MB max, images only (jpg/png/gif/webp)
```

Photos are stored in `public/uploads/` and served at `/uploads/filename`.

### Frontend
In the repair form, add an optional "Attach photo" button per item.  
Upload immediately on file selection (POST /api/upload), store the returned path.  
Include `photo_path` in the repair item object when submitting.  
In admin panel: show a small thumbnail next to the request. Click to open full size.

---

## 8. New feature: multi-item repair requests

**File:** `server.js` — `handleNewRequest`

The repair flow now accepts an `items` array (same pattern as new_item):

```json
{
  "request_type": "repair",
  "priority": "high",
  "items": [
    {
      "item_name": "Printer HP 5000",
      "asset_tag": "IT-042",
      "issue_description": "Paper jam, tray 2 broken",
      "notes": "Has been jamming for 2 weeks",
      "preferred_date": "2026-06-10",
      "photo_path": "/uploads/1234-photo.jpg"
    },
    {
      "item_name": "Office Chair",
      "asset_tag": "FUR-018",
      "issue_description": "Armrest snapped off",
      "notes": null,
      "photo_path": null
    }
  ]
}
```

Legacy single-item repair (item_name + issue_description at top level) still works for backwards compatibility.

**Frontend:** Replace the single repair form with a dynamic list. "Add another item" button appends a new row. Each row has: item name, asset tag, issue description, notes, optional photo upload. Remove button (X) on each row except the first.

---

## 9. Admin sees full requester data

**Files:** `server.js` — `handleAllRequests`, `handleDashboard`  
**Frontend:** `index.html` — admin request card

The `all_requests` query already fetched `notes` and `issue_description` in v4.0. The gap was the frontend not displaying them.

**Backend change:** `handleAllRequests` now also returns `photo_path`.  
**Frontend change required:** In the admin request card, add:
- "Requester notes" section — shows `notes` when not empty
- "Issue description" section — shows `issue_description` when not empty  
- Photo thumbnail — shows when `photo_path` is not null

---

## 10. Updated package.json

New dependencies added:
```
express-rate-limit  ^7.1.5   — rate limiting
helmet              ^7.1.0   — security headers
multer              ^1.4.5   — file uploads
```

New dev dependency:
```
nodemon  ^3.0.0   — auto-restart on file change (dev only)
```

Run `npm install` after updating package.json.

---

## Migration guide (existing database)

If you already have a running v4.0 database and **don't want to wipe data**, run this SQL in phpMyAdmin:

```sql
-- 1. Add new columns to users
ALTER TABLE users
  ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER email,
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER email_verified;

-- 2. Mark all existing users as verified (they were already using the system)
UPDATE users SET email_verified = 1;

-- 3. Add photo_path to requests
ALTER TABLE maintenance_requests
  ADD COLUMN photo_path VARCHAR(255) DEFAULT NULL AFTER issue_description;

-- 4. Create verification tokens table
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token VARCHAR(10) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user (user_id),
  CONSTRAINT FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## VS Code prompt (copy and paste this)

> I have an Office Maintenance Request System built with Node.js + Express + MySQL. I need to apply a series of changes from v4.0 to v5.0. Please apply the following changes to server.js, database.sql, package.json, and index.html:
>
> 1. In `handleForgotPassword` and `handleResetPassword` in server.js: replace all references to the table `password_resets` with `password_reset_tokens`. Also remove `AND role = 'user'` from the WHERE clause in `handleForgotPassword`.
> 2. In the session middleware (server.js), change `secret:` from the hardcoded string to `process.env.SESSION_SECRET || 'dev-only-secret-CHANGE-in-production'`.
> 3. Add a `validatePassword(p)` helper function to server.js that enforces: min 8 chars, at least one uppercase, one lowercase, one digit, one special character. Call it in handleRegister and handleResetPassword replacing the old manual checks.
> 4. Add `express-rate-limit`, `helmet`, and `multer` to package.json dependencies.
> 5. In the middleware section of server.js, add `app.use(helmet({ contentSecurityPolicy: false }))` before other middleware.
> 6. Add rate limiting: import express-rate-limit, create an `authLimiter` (8 requests / 15 min), and apply it to login, admin_login, forgot_password, reset_password actions.
> 7. Add two new action handlers: `change_password` (session-auth) and `admin_change_password` (token-auth). Both require current_password, new_password, confirm_password.
> 8. Add `update_profile` action handler (session-auth) that updates name, floor_office, designation.
> 9. Add `email_verified TINYINT(1) NOT NULL DEFAULT 0` column to the users table in database.sql. Add `email_verification_tokens` table. Update handleRegister to set email_verified=0 and send a 6-digit code. Add verify_email and resend_verification action handlers.
> 10. Add `photo_path VARCHAR(255) DEFAULT NULL` column to maintenance_requests in database.sql. Add multer setup and `POST /api/upload` endpoint.
> 11. Update handleNewRequest to support repair requests with an items[] array (each having item_name, asset_tag, issue_description, notes, preferred_date, photo_path). Keep legacy single-item fallback.
> 12. Add Server-Sent Events: `GET /api/events` (admin, token-auth) and `GET /api/user-events` (user, session-auth). Call pushToUser() from handleUpdateStatus and pushToAdmins() from handleNewRequest.
> 13. Update handleAllRequests to also return photo_path in the SELECT.
> 14. Change genToken(3) to genToken(4) in handleForgotPassword.
> 15. In the admin panel (index.html), update the request card to show: notes, issue_description, and a photo thumbnail (with link) when photo_path is not null.
> 16. Add a live password strength meter to index.html on all password input fields (register form, change password forms). Show 4-segment bar + rules checklist.

