const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { readDB, writeDB } = require('../data/database');
const { addActivity } = require('../services/activityService');
require('dotenv').config();

// Use the same validated secret from authMiddleware
const { JWT_SECRET } = require('../utils/authMiddleware');

// Email transporter configuration
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Basic input sanitizer — strips HTML tags and trims whitespace.
 * Prevents stored XSS in names, emails, etc.
 */
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

/**
 * Validates email format (basic RFC 5322 subset).
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Patient Registration ─────────────────────────────────────────────────

exports.register = async (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  db.pending_verifications = db.pending_verifications || {};
  
  const email = sanitize(req.body.email);
  const password = req.body.password; // Don't sanitize passwords — they get hashed
  const first_name = sanitize(req.body.first_name);
  const last_name = sanitize(req.body.last_name);

  if (!email || !password || !first_name || !last_name) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  if (first_name.length > 50 || last_name.length > 50) {
    return res.status(400).json({ error: 'Name fields must be 50 characters or less.' });
  }

  const existing = db.patient_accounts.find(u => u.email === email);
  if (existing) {
    return res.status(400).json({ error: 'Email already taken.' });
  }

  // Hash password
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newAccount = {
    id: Date.now(),
    email,
    password: hashedPassword,
    first_name,
    last_name,
    created_at: new Date().toISOString()
  };

  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Generate 6-digit OTP

  db.pending_verifications[email] = {
    accountData: newAccount,
    otp,
    attempts: 0,           // Track verification attempts
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes expiry
  };
  writeDB(db);

  // Send OTP via real email
  const mailOptions = {
    from: `"D.I.E.T.S. Ecosystem" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your D.I.E.T.S. Verification Code',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #0f172a; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b;">
        <div style="background: linear-gradient(135deg, #14b8a6, #10b981); padding: 24px 32px; text-align: center;">
          <h1 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800; letter-spacing: 1px;">D.I.E.T.S. Ecosystem</h1>
          <p style="margin: 4px 0 0; color: #064e3b; font-size: 12px;">Aurora Memorial Hospital</p>
        </div>
        <div style="padding: 32px;">
          <p style="color: #cbd5e1; font-size: 14px; margin: 0 0 8px;">Hello <strong style="color: #ffffff;">${first_name}</strong>,</p>
          <p style="color: #94a3b8; font-size: 13px; line-height: 1.6; margin: 0 0 24px;">Use the verification code below to complete your account registration. This code expires in <strong style="color: #f59e0b;">10 minutes</strong>.</p>
          <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #14b8a6; font-family: monospace;">${otp}</span>
          </div>
          <p style="color: #64748b; font-size: 11px; text-align: center; margin: 0;">If you did not request this code, please ignore this email.</p>
        </div>
        <div style="background: #0c1324; padding: 16px 32px; text-align: center; border-top: 1px solid #1e293b;">
          <p style="color: #475569; font-size: 10px; margin: 0;">&copy; 2026 Aurora Memorial Hospital &middot; D.I.E.T.S. Ecosystem v1.0</p>
        </div>
      </div>
    `
  };

  try {
    if(process.env.EMAIL_USER) {
      await emailTransporter.sendMail(mailOptions);
    } else {
      console.log(`[EMAIL SIMULATED] OTP for ${email} is ${otp}`);
    }
    console.log(`[EMAIL] OTP sent to ${email}`);
    addActivity('auth', `OTP sent to ${email}`, null, 'info');
    res.status(202).json({ message: 'OTP sent to your email. Please check your inbox.', email });
  } catch (mailErr) {
    console.error('[EMAIL ERROR]', mailErr);
    const errDb = readDB();
    if (errDb.pending_verifications) {
      delete errDb.pending_verifications[email];
      writeDB(errDb);
    }
    addActivity('auth', `Failed to send OTP to ${email}`, null, 'warning');
    res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
  }
};

// ── Resend OTP ────────────────────────────────────────────────────────────

exports.resendOtp = async (req, res) => {
  const db = readDB();
  db.pending_verifications = db.pending_verifications || {};

  const email = sanitize(req.body.email);
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const pending = db.pending_verifications[email];
  if (!pending) {
    return res.status(400).json({ error: 'No pending registration found for this email.' });
  }

  // Initialize or increment resendCount
  pending.resendCount = pending.resendCount || 0;
  if (pending.resendCount >= 3) {
    return res.status(429).json({ error: 'Maximum resend limit (3) reached for this email.' });
  }

  pending.resendCount += 1;
  pending.attempts = 0;     // Reset attempt counter on resend
  pending.expiresAt = Date.now() + 10 * 60 * 1000; // Reset expiry
  writeDB(db);

  // Resend OTP via real email
  const mailOptions = {
    from: `"D.I.E.T.S. Ecosystem" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your D.I.E.T.S. Verification Code (Resend)',
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #0f172a; border-radius: 16px; overflow: hidden; border: 1px solid #1e293b;">
        <div style="background: linear-gradient(135deg, #14b8a6, #10b981); padding: 24px 32px; text-align: center;">
          <h1 style="margin: 0; color: #0f172a; font-size: 22px; font-weight: 800; letter-spacing: 1px;">D.I.E.T.S. Ecosystem</h1>
          <p style="margin: 4px 0 0; color: #064e3b; font-size: 12px;">Aurora Memorial Hospital</p>
        </div>
        <div style="padding: 32px;">
          <p style="color: #cbd5e1; font-size: 14px; margin: 0 0 8px;">Hello <strong style="color: #ffffff;">${pending.accountData.first_name}</strong>,</p>
          <p style="color: #94a3b8; font-size: 13px; line-height: 1.6; margin: 0 0 24px;">As requested, here is your verification code. This code expires in <strong style="color: #f59e0b;">10 minutes</strong>.</p>
          <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #14b8a6; font-family: monospace;">${pending.otp}</span>
          </div>
          <p style="color: #64748b; font-size: 11px; text-align: center; margin: 0;">If you did not request this code, please ignore this email.</p>
        </div>
        <div style="background: #0c1324; padding: 16px 32px; text-align: center; border-top: 1px solid #1e293b;">
          <p style="color: #475569; font-size: 10px; margin: 0;">&copy; 2026 Aurora Memorial Hospital &middot; D.I.E.T.S. Ecosystem v1.0</p>
        </div>
      </div>
    `
  };

  try {
    if(process.env.EMAIL_USER) {
      await emailTransporter.sendMail(mailOptions);
    } else {
      console.log(`[EMAIL SIMULATED] Resend OTP for ${email} is ${pending.otp}`);
    }
    console.log(`[EMAIL] Resent OTP to ${email} (Count: ${pending.resendCount})`);
    addActivity('auth', `OTP resent to ${email} (Attempt ${pending.resendCount}/3)`, null, 'info');
    res.status(202).json({ message: `OTP resent successfully. You have ${3 - pending.resendCount} attempts left.` });
  } catch (mailErr) {
    console.error('[EMAIL ERROR]', mailErr);
    addActivity('auth', `Failed to resend OTP to ${email}`, null, 'warning');
    res.status(500).json({ error: 'Failed to resend verification email. Please try again later.' });
  }
};

// ── Verify OTP (with brute-force protection) ──────────────────────────────

exports.verifyOtp = (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  db.pending_verifications = db.pending_verifications || {};

  const email = sanitize(req.body.email);
  const otp = sanitize(req.body.otp);
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  const pending = db.pending_verifications[email];
  if (!pending) {
    return res.status(400).json({ error: 'No pending registration found for this email, or it has expired.' });
  }

  if (Date.now() > pending.expiresAt) {
    delete db.pending_verifications[email];
    writeDB(db);
    return res.status(400).json({ error: 'OTP has expired. Please register again.' });
  }

  // Brute-force protection: max 5 verification attempts
  pending.attempts = (pending.attempts || 0) + 1;
  if (pending.attempts > 5) {
    delete db.pending_verifications[email];
    writeDB(db);
    addActivity('auth', `OTP verification blocked for ${email} — too many failed attempts`, null, 'warning');
    return res.status(429).json({ error: 'Too many failed attempts. Please register again.' });
  }

  if (pending.otp.toString().trim() !== otp.toString().trim()) {
    writeDB(db); // Persist incremented attempt counter
    return res.status(400).json({ error: `Invalid OTP code. ${5 - pending.attempts} attempts remaining.` });
  }

  // OTP is valid, save to DB
  db.patient_accounts.push(pending.accountData);
  delete db.pending_verifications[email];
  writeDB(db);

  addActivity('auth', `Patient account verified and created: ${email}`, null, 'info');
  res.status(201).json({ message: 'Account verified and created successfully', user: { email, first_name: pending.accountData.first_name, last_name: pending.accountData.last_name } });
};

// ── Patient Login ─────────────────────────────────────────────────────────

exports.login = async (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  
  const email = sanitize(req.body.email);
  const password = req.body.password;
  const user = db.patient_accounts.find(u => u.email === email);
  
  if (!user) {
    // Generic error message to prevent user enumeration
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Only accept bcrypt-hashed passwords — no plaintext fallback
  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Generate JWT Token
  const token = jwt.sign(
    { id: user.id, email: user.email, role: 'patient' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ 
    message: 'Login successful', 
    token, 
    user: { email: user.email, first_name: user.first_name, last_name: user.last_name } 
  });
};

// ── Staff Login (database-backed) ─────────────────────────────────────────

exports.staffLogin = async (req, res) => {
  const { username, password, role } = req.body;
  const db = readDB();
  db.staff_accounts = db.staff_accounts || [];

  // Find by username AND role in the database
  const staffUser = db.staff_accounts.find(
    s => s.username === username && s.role === role
  );

  if (!staffUser) {
    addActivity('auth', `Failed staff login attempt: ${username} (${role})`, null, 'warning');
    return res.status(401).json({ error: 'Invalid staff credentials.' });
  }

  const validPassword = await bcrypt.compare(password, staffUser.password);
  if (!validPassword) {
    addActivity('auth', `Failed staff login attempt: ${username} (${role}) — wrong password`, null, 'warning');
    return res.status(401).json({ error: 'Invalid staff credentials.' });
  }

  const token = jwt.sign(
    { username, role },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  addActivity('auth', `Staff logged in: ${username} (${role})`, null, 'info');
  res.json({ 
    message: 'Login successful', 
    token, 
    user: { username, role } 
  });
};

// ── Password Reset ────────────────────────────────────────────────────────

exports.reset = (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  
  const email = sanitize(req.body.email);

  // Generic response regardless of whether the email exists (prevents enumeration)
  addActivity('auth', `Password reset requested for: ${email}`, null, 'warning');
  res.json({ message: 'If that email is registered, a password reset link has been sent.' });
};
