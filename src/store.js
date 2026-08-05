import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL || 'file:./ludwitt.db';
const AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

const db = createClient({
  url: DATABASE_URL,
  authToken: AUTH_TOKEN,
});

const QUALIFYING_EVENTS = new Set(['lesson_started', 'lesson_completed', 'quiz_submitted']);

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS developers (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      sandbox INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS apps (
      app_id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      topic TEXT NOT NULL,
      launch_url TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      icon_url TEXT,
      student_handle TEXT,
      api_key TEXT NOT NULL,
      jwt_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      event TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      metadata TEXT,
      ts INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT PRIMARY KEY
    )
  `);

  await seedDefaults();
}

async function seedDefaults() {
  const count = await db.execute(`SELECT COUNT(*) AS n FROM developers`);
  if (Number(count.rows[0]?.n ?? 0) > 0) return;

  await db.execute({
    sql: `INSERT INTO developers (id, handle, api_key, sandbox) VALUES (?, ?, ?, ?)`,
    args: ['dev-1', 'student-demo', 'sandbox_key_demo', 1],
  });
  await db.execute({
    sql: `INSERT INTO developers (id, handle, api_key, sandbox) VALUES (?, ?, ?, ?)`,
    args: ['dev-2', 'student-demo', 'prod_key_demo', 0],
  });
  for (const id of ['cohort-member-1', 'cohort-member-2']) {
    await db.execute({ sql: `INSERT OR IGNORE INTO blocked_users (user_id) VALUES (?)`, args: [id] });
  }
}

export async function authenticateDeveloper(apiKey) {
  const res = await db.execute({
    sql: `SELECT * FROM developers WHERE api_key = ?`,
    args: [apiKey],
  });
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, handle: row.handle, api_key: row.api_key, sandbox: Boolean(row.sandbox) };
}

export async function registerApp(developerId, meta) {
  const app_id = randomUUID();
  const api_key = `app_${randomUUID().replace(/-/g, '')}`;
  const jwt_secret = randomUUID();
  await db.execute({
    sql: `INSERT INTO apps (app_id, developer_id, title, description, topic, launch_url, repo_url, icon_url, student_handle, api_key, jwt_secret, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`,
    args: [
      app_id,
      developerId,
      meta.title,
      meta.description,
      meta.topic,
      meta.launch_url,
      meta.repo_url,
      meta.icon_url ?? null,
      meta.student_handle ?? null,
      api_key,
      jwt_secret,
      Date.now(),
    ],
  });
  return { app_id, api_key, jwt_secret };
}

export async function getApp(app_id) {
  const res = await db.execute({ sql: `SELECT * FROM apps WHERE app_id = ?`, args: [app_id] });
  const row = res.rows[0];
  if (!row) return null;
  return {
    app_id: row.app_id,
    developer_id: row.developer_id,
    api_key: row.api_key,
    jwt_secret: row.jwt_secret,
    launch_url: row.launch_url,
    student_handle: row.student_handle,
    status: row.status,
  };
}

export async function isBlockedUser(user_id, student_handle) {
  const normalizedUser = String(user_id ?? '').trim().toLowerCase();
  if (!normalizedUser) return false;
  const res = await db.execute({ sql: `SELECT 1 FROM blocked_users WHERE user_id = ?`, args: [normalizedUser] });
  if (res.rows.length > 0) return true;

  const normalizedHandle = String(student_handle ?? '').trim().toLowerCase();
  if (!normalizedHandle) return false;
  return normalizedUser === normalizedHandle;
}

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function recordEvent(app_id, { event, user_id, session_id, metadata, sandbox }) {
  if (sandbox || event.startsWith('sandbox.')) return;
  await db.execute({
    sql: `INSERT INTO events (app_id, event, user_id, session_id, metadata, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [app_id, event, user_id, session_id, metadata ? JSON.stringify(metadata) : null, Date.now()],
  });
}

export async function getMetrics(app_id) {
  const res = await db.execute({
    sql: `SELECT user_id, event FROM events WHERE app_id = ?`,
    args: [app_id],
  });
  const users = new Set();
  const qualified = new Set();
  for (const row of res.rows) {
    users.add(row.user_id);
    if (QUALIFYING_EVENTS.has(row.event)) qualified.add(row.user_id);
  }
  return { unique_users: users.size, qualified_users: qualified.size };
}

export async function exportSnapshot() {
  const appsRes = await db.execute(`SELECT app_id, student_handle FROM apps`);
  const header = 'app_id,student_handle,unique_users,qualified_users';
  const rows = [header];
  for (const app of appsRes.rows) {
    const m = await getMetrics(app.app_id);
    rows.push(
      [app.app_id, app.student_handle, m.unique_users, m.qualified_users].map(csvCell).join(',')
    );
  }
  return rows;
}

export async function _resetForTests() {
  await db.execute(`DELETE FROM events`);
  await db.execute(`DELETE FROM apps`);
  await db.execute(`DELETE FROM developers`);
  await db.execute(`DELETE FROM blocked_users`);
  await seedDefaults();
}

export async function _seedDeveloper(dev) {
  await db.execute({
    sql: `INSERT OR REPLACE INTO developers (id, handle, api_key, sandbox) VALUES (?, ?, ?, ?)`,
    args: [dev.id, dev.handle, dev.api_key, dev.sandbox ? 1 : 0],
  });
}

export async function _blockUser(id) {
  await db.execute({ sql: `INSERT OR IGNORE INTO blocked_users (user_id) VALUES (?)`, args: [id] });
}

export async function initStore() {
  await init();
}
