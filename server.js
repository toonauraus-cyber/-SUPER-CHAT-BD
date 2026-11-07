"use strict";

require("dotenv").config?.();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add a PostgreSQL connection string in the service environment.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 24) {
  console.error("SESSION_SECRET is missing or too short. Set a random secret of at least 24 characters.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.socket.io", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const donationLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const DEFAULT_PAYMENT_METHODS = ["bKash", "Nagad", "Rocket", "Upay"];
const DEFAULT_WITHDRAWAL_METHODS = ["bKash", "Nagad", "Rocket", "Upay", "Tap", "Pubali Bank"];

async function query(text, params = []) {
  return pool.query(text, params);
}
function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}
function slugify(value) {
  return clean(value, 80).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "creator";
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function amountValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000000) return null;
  return Math.round(n * 100) / 100;
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status };
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in first." });
  next();
}
function requireCreator(req, res, next) {
  if (!req.session.user || req.session.user.role !== "creator") return res.status(403).json({ error: "Creator access required." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}
function slugRoom(slug) { return `creator:${slug}`; }

async function initializeDatabase() {
  // Create/upgrade the session table via connect-pg-simple, then initialize application schema.
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'creator' CHECK (role IN ('admin','creator')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS creator_profiles (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '',
      banner_url TEXT NOT NULL DEFAULT '',
      theme_color TEXT NOT NULL DEFAULT '#7657ff',
      currency TEXT NOT NULL DEFAULT 'BDT',
      alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payment_methods (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      account_number TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT 'Personal',
      instructions TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawal_methods (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      min_amount NUMERIC(12,2) NOT NULL DEFAULT 100,
      max_amount NUMERIC(12,2) NOT NULL DEFAULT 100000,
      fee_type TEXT NOT NULL DEFAULT 'fixed' CHECK (fee_type IN ('fixed','percent')),
      fee_value NUMERIC(12,2) NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS donations (
      id BIGSERIAL PRIMARY KEY,
      creator_id BIGINT NOT NULL REFERENCES users(id),
      donor_name TEXT NOT NULL DEFAULT 'Anonymous',
      message TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL,
      transaction_reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
      is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      creator_id BIGINT NOT NULL REFERENCES users(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL,
      account_details TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_donations_creator_created ON donations(creator_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_creator_created ON withdrawals(creator_id, created_at DESC);
  `);

  for (let i = 0; i < DEFAULT_PAYMENT_METHODS.length; i++) {
    await query(
      `INSERT INTO payment_methods(name, enabled, sort_order)
       VALUES($1, FALSE, $2) ON CONFLICT(name) DO NOTHING`,
      [DEFAULT_PAYMENT_METHODS[i], i]
    );
  }
  for (let i = 0; i < DEFAULT_WITHDRAWAL_METHODS.length; i++) {
    await query(
      `INSERT INTO withdrawal_methods(name, enabled, sort_order)
       VALUES($1, TRUE, $2) ON CONFLICT(name) DO NOTHING`,
      [DEFAULT_WITHDRAWAL_METHODS[i], i]
    );
  }

  const adminEmail = clean(process.env.ADMIN_EMAIL, 180).toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  if (!adminEmail || !validEmail(adminEmail) || adminPassword.length < 12) {
    throw new Error("Set a valid ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) in Environment.");
  }
  const existing = await query("SELECT id FROM users WHERE email=$1", [adminEmail]);
  if (!existing.rowCount) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await query(
      `INSERT INTO users(name,email,password_hash,role,status)
       VALUES($1,$2,$3,'admin','active')`,
      ["Platform Administrator", adminEmail, hash]
    );
    console.log("Initial administrator account created.");
  }
  await query(
    `INSERT INTO platform_settings(key,value) VALUES
      ('platform_name','SUPER CHAT BD'),
      ('donation_notice','Your support helps creators keep creating.'),
      ('minimum_donation','10'),
      ('platform_fee_percent','0')
     ON CONFLICT(key) DO NOTHING`
  );
}

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, service: "SUPER CHAT BD", database: "connected" });
  } catch (e) {
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 180).toLowerCase();
  const password = String(req.body.password || "");
  if (name.length < 2 || !validEmail(email) || password.length < 10) {
    return res.status(400).json({ error: "Enter your name, a valid email and a password of at least 10 characters." });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const base = slugify(req.body.slug || name);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query(
        `INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'creator') RETURNING *`,
        [name, email, hash]
      );
      const user = userResult.rows[0];
      let slug = base, suffix = 2;
      while ((await client.query("SELECT 1 FROM creator_profiles WHERE slug=$1", [slug])).rowCount) {
        slug = `${base}-${suffix++}`;
      }
      await client.query(
        `INSERT INTO creator_profiles(user_id,slug,display_name) VALUES($1,$2,$3)`,
        [user.id, slug, name]
      );
      await client.query("COMMIT");
      req.session.user = publicUser(user);
      res.status(201).json({ user: req.session.user, slug });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23505") return res.status(409).json({ error: "This email is already registered." });
      throw e;
    } finally { client.release(); }
  } catch (e) {
    console.error("Registration error:", e.message);
    res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = clean(req.body.email, 180).toLowerCase();
  const password = String(req.body.password || "");
  try {
    const result = await query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || user.status !== "active" || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect, or the account is unavailable." });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start a secure session." });
      req.session.user = publicUser(user);
      res.json({ user: req.session.user });
    });
  } catch (e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/public/creator/:slug", async (req, res) => {
  const slug = clean(req.params.slug, 100);
  const result = await query(
    `SELECT p.slug,p.display_name,p.bio,p.avatar_url,p.logo_url,p.banner_url,p.theme_color,p.alert_enabled
     FROM creator_profiles p JOIN users u ON u.id=p.user_id
     WHERE p.slug=$1 AND u.status='active'`,
    [slug]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Creator page not found." });
  const profile = result.rows[0];
  const donations = await query(
    `SELECT donor_name,message,amount,created_at FROM donations
     WHERE creator_id=(SELECT user_id FROM creator_profiles WHERE slug=$1)
       AND status='verified' ORDER BY created_at DESC LIMIT 15`, [slug]
  );
  res.json({ profile, supporters: donations.rows });
});

app.get("/api/public/payment-methods", async (req, res) => {
  const result = await query(
    `SELECT name,account_number,account_type,instructions FROM payment_methods
     WHERE enabled=TRUE ORDER BY sort_order,id`
  );
  res.json({ methods: result.rows });
});

app.post("/api/public/donations", donationLimiter, async (req, res) => {
  const slug = clean(req.body.slug, 100);
  const donorName = clean(req.body.donorName, 80) || "Anonymous";
  const message = clean(req.body.message, 300);
  const amount = amountValue(req.body.amount);
  const method = clean(req.body.paymentMethod, 50);
  const reference = clean(req.body.transactionReference, 120);
  const anonymous = Boolean(req.body.anonymous);
  if (!amount || amount < 10 || !method || !reference) {
    return res.status(400).json({ error: "Minimum donation is ৳10. Select a payment method and enter its transaction reference." });
  }
  const creator = await query(
    `SELECT p.user_id FROM creator_profiles p JOIN users u ON u.id=p.user_id
     WHERE p.slug=$1 AND u.status='active'`, [slug]
  );
  if (!creator.rowCount) return res.status(404).json({ error: "Creator page not found." });
  const enabled = await query("SELECT name FROM payment_methods WHERE name=$1 AND enabled=TRUE", [method]);
  if (!enabled.rowCount) return res.status(400).json({ error: "This payment method is currently unavailable." });
  const inserted = await query(
    `INSERT INTO donations(creator_id,donor_name,message,amount,payment_method,transaction_reference,is_anonymous)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,created_at`,
    [creator.rows[0].user_id, anonymous ? "Anonymous" : donorName, message, amount, method, reference, anonymous]
  );
  res.status(201).json({
    donation: inserted.rows[0],
    message: "Donation submitted for verification. The live alert appears after the admin verifies the payment."
  });
});

app.get("/api/creator/profile", requireCreator, async (req, res) => {
  const result = await query("SELECT * FROM creator_profiles WHERE user_id=$1", [req.session.user.id]);
  res.json({ profile: result.rows[0] });
});

app.put("/api/creator/profile", requireCreator, async (req, res) => {
  const displayName = clean(req.body.displayName, 100);
  const bio = clean(req.body.bio, 500);
  const avatar = clean(req.body.avatarUrl, 1000);
  const logo = clean(req.body.logoUrl, 1000);
  const banner = clean(req.body.bannerUrl, 1000);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.themeColor) ? req.body.themeColor : "#7657ff";
  if (displayName.length < 2) return res.status(400).json({ error: "Display name must contain at least 2 characters." });
  const result = await query(
    `UPDATE creator_profiles SET display_name=$1,bio=$2,avatar_url=$3,logo_url=$4,banner_url=$5,
     theme_color=$6,updated_at=NOW() WHERE user_id=$7 RETURNING *`,
    [displayName,bio,avatar,logo,banner,color,req.session.user.id]
  );
  res.json({ profile: result.rows[0] });
});

app.get("/api/creator/dashboard", requireCreator, async (req, res) => {
  const id = req.session.user.id;
  const [profile, stats, donations, withdrawals, methods] = await Promise.all([
    query("SELECT * FROM creator_profiles WHERE user_id=$1", [id]),
    query(`SELECT
      COALESCE(SUM(amount) FILTER (WHERE status='verified'),0) AS total_verified,
      COUNT(*) FILTER (WHERE status='verified') AS verified_count,
      COUNT(*) FILTER (WHERE status='pending') AS pending_count
      FROM donations WHERE creator_id=$1`, [id]),
    query(`SELECT id,donor_name,message,amount,payment_method,status,created_at
      FROM donations WHERE creator_id=$1 ORDER BY created_at DESC LIMIT 30`, [id]),
    query(`SELECT id,amount,method,status,admin_note,created_at FROM withdrawals
      WHERE creator_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
    query("SELECT name,min_amount,max_amount,fee_type,fee_value FROM withdrawal_methods WHERE enabled=TRUE ORDER BY sort_order,id")
  ]);
  res.json({
    profile: profile.rows[0],
    stats: stats.rows[0],
    donations: donations.rows,
    withdrawals: withdrawals.rows,
    withdrawalMethods: methods.rows
  });
});

app.post("/api/creator/withdrawals", requireCreator, async (req, res) => {
  const amount = amountValue(req.body.amount);
  const method = clean(req.body.method, 60);
  const details = clean(req.body.accountDetails, 200);
  const note = clean(req.body.note, 300);
  if (!amount || !method || details.length < 5) return res.status(400).json({ error: "Enter a valid amount, withdrawal method and account details." });
  const methodResult = await query("SELECT * FROM withdrawal_methods WHERE name=$1 AND enabled=TRUE", [method]);
  if (!methodResult.rowCount) return res.status(400).json({ error: "Selected withdrawal method is unavailable." });
  const m = methodResult.rows[0];
  if (amount < Number(m.min_amount) || amount > Number(m.max_amount)) {
    return res.status(400).json({ error: `Amount must be between ৳${m.min_amount} and ৳${m.max_amount}.` });
  }
  const verified = await query("SELECT COALESCE(SUM(amount),0) AS total FROM donations WHERE creator_id=$1 AND status='verified'", [req.session.user.id]);
  const previous = await query(
    "SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE creator_id=$1 AND status IN ('pending','approved','paid')",
    [req.session.user.id]
  );
  const available = Number(verified.rows[0].total) - Number(previous.rows[0].total);
  if (amount > available) return res.status(400).json({ error: `Insufficient withdrawable balance. Available: ৳${available.toFixed(2)}.` });
  const result = await query(
    `INSERT INTO withdrawals(creator_id,amount,method,account_details,note)
     VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at`,
    [req.session.user.id, amount, method, details, note]
  );
  res.status(201).json({ withdrawal: result.rows[0], message: "Withdrawal request submitted for admin review." });
});

app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  const [users, donations, withdrawals] = await Promise.all([
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE role='creator') AS creators FROM users`),
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='pending') AS pending,
      COALESCE(SUM(amount) FILTER (WHERE status='verified'),0) AS verified_amount FROM donations`),
    query(`SELECT COUNT(*) FILTER (WHERE status='pending') AS pending FROM withdrawals`)
  ]);
  res.json({ users: users.rows[0], donations: donations.rows[0], withdrawals: withdrawals.rows[0] });
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT u.id,u.name,u.email,u.role,u.status,u.created_at,p.slug,p.display_name
     FROM users u LEFT JOIN creator_profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 300`
  );
  res.json({ users: result.rows });
});

app.patch("/api/admin/users/:id/status", requireAdmin, async (req, res) => {
  const status = req.body.status === "suspended" ? "suspended" : "active";
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id === req.session.user.id) return res.status(400).json({ error: "Invalid account." });
  await query("UPDATE users SET status=$1,updated_at=NOW() WHERE id=$2 AND role='creator'", [status,id]);
  res.json({ ok: true });
});

app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT d.*,u.name AS creator_name,p.slug FROM donations d
     JOIN users u ON u.id=d.creator_id JOIN creator_profiles p ON p.user_id=u.id
     ORDER BY d.created_at DESC LIMIT 500`
  );
  res.json({ donations: result.rows });
});

app.patch("/api/admin/donations/:id", requireAdmin, async (req, res) => {
  const status = ["verified","rejected"].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "Invalid donation status." });
  const result = await query(
    `UPDATE donations SET status=$1,verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END
     WHERE id=$2 AND status='pending' RETURNING *`,
    [status, Number(req.params.id)]
  );
  if (!result.rowCount) return res.status(409).json({ error: "Donation not found or already reviewed." });
  const d = result.rows[0];
  if (status === "verified") {
    const p = await query("SELECT slug,display_name,alert_enabled FROM creator_profiles WHERE user_id=$1", [d.creator_id]);
    if (p.rowCount && p.rows[0].alert_enabled) {
      io.to(slugRoom(p.rows[0].slug)).emit("donation:verified", {
        id: d.id,
        donorName: d.is_anonymous ? "Anonymous" : d.donor_name,
        message: d.message,
        amount: Number(d.amount),
        createdAt: d.verified_at
      });
    }
  }
  res.json({ ok: true, donation: d });
});

app.get("/api/admin/payment-methods", requireAdmin, async (req, res) => {
  const result = await query("SELECT * FROM payment_methods ORDER BY sort_order,id");
  res.json({ methods: result.rows });
});

app.put("/api/admin/payment-methods/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = clean(req.body.name, 60);
  const number = clean(req.body.accountNumber, 100);
  const type = clean(req.body.accountType, 40) || "Personal";
  const instructions = clean(req.body.instructions, 500);
  const enabled = Boolean(req.body.enabled);
  if (!name) return res.status(400).json({ error: "Payment method name is required." });
  const result = await query(
    `UPDATE payment_methods SET name=$1,account_number=$2,account_type=$3,instructions=$4,enabled=$5,updated_at=NOW()
     WHERE id=$6 RETURNING *`,
    [name,number,type,instructions,enabled,id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Payment method not found." });
  res.json({ method: result.rows[0] });
});

app.post("/api/admin/payment-methods", requireAdmin, async (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) return res.status(400).json({ error: "Method name is required." });
  try {
    const result = await query(
      `INSERT INTO payment_methods(name,account_number,account_type,instructions,enabled,sort_order)
       VALUES($1,$2,$3,$4,$5,100) RETURNING *`,
      [name,clean(req.body.accountNumber,100),clean(req.body.accountType,40)||"Personal",clean(req.body.instructions,500),Boolean(req.body.enabled)]
    );
    res.status(201).json({ method: result.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That payment method already exists." });
    throw e;
  }
});

app.get("/api/admin/withdrawal-methods", requireAdmin, async (req, res) => {
  const result = await query("SELECT * FROM withdrawal_methods ORDER BY sort_order,id");
  res.json({ methods: result.rows });
});

app.put("/api/admin/withdrawal-methods/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = clean(req.body.name, 60);
  const min = amountValue(req.body.minAmount);
  const max = amountValue(req.body.maxAmount);
  const feeType = req.body.feeType === "percent" ? "percent" : "fixed";
  const feeValue = Number(req.body.feeValue || 0);
  if (!name || !min || !max || max < min || !Number.isFinite(feeValue) || feeValue < 0) {
    return res.status(400).json({ error: "Check method name, min/max amounts and fee." });
  }
  const result = await query(
    `UPDATE withdrawal_methods SET name=$1,enabled=$2,min_amount=$3,max_amount=$4,
     fee_type=$5,fee_value=$6,updated_at=NOW() WHERE id=$7 RETURNING *`,
    [name,Boolean(req.body.enabled),min,max,feeType,feeValue,id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Withdrawal method not found." });
  res.json({ method: result.rows[0] });
});

app.post("/api/admin/withdrawal-methods", requireAdmin, async (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) return res.status(400).json({ error: "Method name is required." });
  try {
    const result = await query(
      `INSERT INTO withdrawal_methods(name,enabled,min_amount,max_amount,fee_type,fee_value,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,100) RETURNING *`,
      [name,Boolean(req.body.enabled),Number(req.body.minAmount||100),Number(req.body.maxAmount||100000),
       req.body.feeType==="percent"?"percent":"fixed",Number(req.body.feeValue||0)]
    );
    res.status(201).json({ method: result.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That withdrawal method already exists." });
    throw e;
  }
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT w.*,u.name AS creator_name,u.email FROM withdrawals w
     JOIN users u ON u.id=w.creator_id ORDER BY w.created_at DESC LIMIT 300`
  );
  res.json({ withdrawals: result.rows });
});

app.patch("/api/admin/withdrawals/:id", requireAdmin, async (req, res) => {
  const status = ["approved","rejected","paid"].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "Invalid withdrawal status." });
  const result = await query(
    `UPDATE withdrawals SET status=$1,admin_note=$2,updated_at=NOW()
     WHERE id=$3 AND status IN ('pending','approved') RETURNING *`,
    [status,clean(req.body.adminNote,300),Number(req.params.id)]
  );
  if (!result.rowCount) return res.status(409).json({ error: "Withdrawal not found or already completed." });
  res.json({ ok: true, withdrawal: result.rows[0] });
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  const result = await query("SELECT key,value FROM platform_settings ORDER BY key");
  res.json({ settings: result.rows });
});
app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  const allowed = ["platform_name","donation_notice","minimum_donation","platform_fee_percent"];
  const entries = Object.entries(req.body || {}).filter(([k,v]) => allowed.includes(k) && typeof v === "string");
  for (const [key,value] of entries) {
    await query(
      `INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
      [key,clean(value,500)]
    );
  }
  res.json({ ok: true });
});

app.get("/api/admin/creator/:slug", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT p.*,u.email,u.status FROM creator_profiles p JOIN users u ON u.id=p.user_id WHERE p.slug=$1`,
    [clean(req.params.slug,100)]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Creator not found." });
  res.json({ creator: result.rows[0] });
});

io.on("connection", socket => {
  socket.on("creator:join", async slugInput => {
    const slug = clean(slugInput, 100);
    if (!slug) return;
    const result = await query(
      `SELECT 1 FROM creator_profiles p JOIN users u ON u.id=p.user_id
       WHERE p.slug=$1 AND u.status='active' AND p.alert_enabled=TRUE`, [slug]
    ).catch(() => ({ rowCount: 0 }));
    if (result.rowCount) socket.join(slugRoom(slug));
  });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

async function start() {
  try {
    await pool.query("SELECT 1");
    await initializeDatabase();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`SUPER CHAT BD is running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
}

process.on("SIGTERM", async () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
process.on("SIGINT", async () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});

start();
