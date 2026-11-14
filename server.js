const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { DatabaseSync } = require("node:sqlite");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const isProductionDb = Boolean(process.env.DATABASE_URL);

let sqliteDb = null;
let neonSql = null;

if (isProductionDb) {
  const { neon } = require("@neondatabase/serverless");
  neonSql = neon(process.env.DATABASE_URL);
} else {
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new DatabaseSync(path.join(dataDir, "app.db"));
}

async function initDb() {
  if (isProductionDb) {
    await neonSql`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await neonSql`
      CREATE TABLE IF NOT EXISTS subjects (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, name)
      )
    `;
    await neonSql`
      CREATE TABLE IF NOT EXISTS tasks (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_id BIGINT REFERENCES subjects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        deadline TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  } else {
    sqliteDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        subject_id INTEGER,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        deadline TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
      );
    `);
  }
}

function postgresSql(sqlText) {
  let index = 0;
  return sqlText.replace(/\?/g, () => `$${++index}`);
}

async function all(sqlText, params = []) {
  if (isProductionDb) {
    const result = await neonSql.query(postgresSql(sqlText), params);
    return result;
  }
  return sqliteDb.prepare(sqlText).all(...params);
}

async function get(sqlText, params = []) {
  const rows = await all(sqlText, params);
  return rows[0] || null;
}

async function run(sqlText, params = []) {
  if (isProductionDb) {
    return neonSql.query(sqlText, params);
  }
  return sqliteDb.prepare(sqlText).run(...params);
}

async function insertAndGet(sqlText, params, selectSql, selectParams) {
  if (isProductionDb) {
    return get(sqlText, params);
  }
  const result = await run(sqlText, params);
  return get(selectSql, selectParams || [result.lastInsertRowid]);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function signUser(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Authentication required." });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired session." });
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanDeadline(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

app.get("/api/health", async (_req, res) => {
  try {
    await all("SELECT 1");
    res.json({ ok: true, service: "student-academic-task-manager", database: isProductionDb ? "neon-postgres" : "local-sqlite" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Database connection failed." });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!name || !email || password.length < 6) {
    return res.status(400).json({ message: "Name, valid email, and password of at least 6 characters are required." });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    let user;
    if (isProductionDb) {
      user = await get(
        "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
        [name, email, passwordHash]
      );
    } else {
      const result = sqliteDb.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, passwordHash);
      user = await get("SELECT id, name, email FROM users WHERE id = ?", [result.lastInsertRowid]);
    }
    const token = signUser(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (String(err.message).toLowerCase().includes("unique")) {
      return res.status(409).json({ message: "An account with that email already exists." });
    }
    console.error(err);
    res.status(500).json({ message: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  const user = await get("SELECT id, name, email, password_hash FROM users WHERE email = ?", [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: "Incorrect email or password." });
  }

  const safeUser = { id: user.id, name: user.name, email: user.email };
  res.json({ token: signUser(safeUser), user: safeUser });
});

app.get("/api/me", auth, async (req, res) => {
  const user = await get("SELECT id, name, email FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json({ user });
});

app.get("/api/subjects", auth, async (req, res) => {
  const subjects = await all("SELECT id, name FROM subjects WHERE user_id = ? ORDER BY name", [req.user.id]);
  res.json({ subjects });
});

app.post("/api/subjects", auth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ message: "Subject name is required." });

  try {
    let subject;
    if (isProductionDb) {
      subject = await get("INSERT INTO subjects (user_id, name) VALUES ($1, $2) RETURNING id, name", [req.user.id, name]);
    } else {
      const result = sqliteDb.prepare("INSERT INTO subjects (user_id, name) VALUES (?, ?)").run(req.user.id, name);
      subject = await get("SELECT id, name FROM subjects WHERE id = ?", [result.lastInsertRowid]);
    }
    res.status(201).json({ subject });
  } catch (err) {
    if (String(err.message).toLowerCase().includes("unique")) {
      return res.status(409).json({ message: "You already have that subject." });
    }
    console.error(err);
    res.status(500).json({ message: "Could not create subject." });
  }
});

app.delete("/api/subjects/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  if (isProductionDb) {
    const rows = await all("DELETE FROM subjects WHERE id = $1 AND user_id = $2 RETURNING id", [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ message: "Subject not found." });
  } else {
    const result = await run("DELETE FROM subjects WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!result.changes) return res.status(404).json({ message: "Subject not found." });
  }
  res.json({ message: "Subject deleted." });
});

app.get("/api/tasks", auth, async (req, res) => {
  const status = req.query.status;
  const search = String(req.query.search || "").trim();
  let sql = `
    SELECT t.id, t.title, t.description, t.deadline, t.status, t.created_at,
           s.id AS subject_id, s.name AS subject_name
    FROM tasks t
    LEFT JOIN subjects s ON s.id = t.subject_id
    WHERE t.user_id = ?
  `;
  const params = [req.user.id];

  if (status === "pending" || status === "completed") {
    sql += " AND t.status = ?";
    params.push(status);
  }
  if (search) {
    sql += " AND (LOWER(t.title) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?) OR LOWER(COALESCE(s.name,'')) LIKE LOWER(?))";
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  sql += " ORDER BY CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END, t.deadline ASC, t.created_at DESC";

  res.json({ tasks: await all(sql, params) });
});

app.post("/api/tasks", auth, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const deadline = cleanDeadline(req.body.deadline);
  const subjectId = req.body.subjectId ? Number(req.body.subjectId) : null;
  if (!title) return res.status(400).json({ message: "Task title is required." });

  if (subjectId) {
    const subject = await get("SELECT id FROM subjects WHERE id = ? AND user_id = ?", [subjectId, req.user.id]);
    if (!subject) return res.status(400).json({ message: "Invalid subject." });
  }

  let task;
  if (isProductionDb) {
    task = await get(
      `INSERT INTO tasks (user_id, subject_id, title, description, deadline)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, description, deadline, status, subject_id`,
      [req.user.id, subjectId, title, description, deadline]
    );
    task = await get(`
      SELECT t.id, t.title, t.description, t.deadline, t.status,
             s.id AS subject_id, s.name AS subject_name
      FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id
      WHERE t.id = $1 AND t.user_id = $2
    `, [task.id, req.user.id]);
  } else {
    const result = sqliteDb.prepare(`INSERT INTO tasks (user_id, subject_id, title, description, deadline) VALUES (?, ?, ?, ?, ?)`).run(req.user.id, subjectId, title, description, deadline);
    task = await get(`
      SELECT t.id, t.title, t.description, t.deadline, t.status,
             s.id AS subject_id, s.name AS subject_name
      FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id
      WHERE t.id = ? AND t.user_id = ?
    `, [result.lastInsertRowid, req.user.id]);
  }
  res.status(201).json({ task });
});

app.patch("/api/tasks/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!existing) return res.status(404).json({ message: "Task not found." });

  const title = req.body.title !== undefined ? String(req.body.title).trim() : existing.title;
  const description = req.body.description !== undefined ? String(req.body.description).trim() : existing.description;
  const deadline = req.body.deadline !== undefined ? cleanDeadline(req.body.deadline) : existing.deadline;
  const status = req.body.status !== undefined ? String(req.body.status) : existing.status;
  const subjectId = req.body.subjectId !== undefined ? (req.body.subjectId ? Number(req.body.subjectId) : null) : existing.subject_id;

  if (!title) return res.status(400).json({ message: "Task title is required." });
  if (!["pending", "completed"].includes(status)) return res.status(400).json({ message: "Invalid task status." });

  if (subjectId) {
    const subject = await get("SELECT id FROM subjects WHERE id = ? AND user_id = ?", [subjectId, req.user.id]);
    if (!subject) return res.status(400).json({ message: "Invalid subject." });
  }

  if (isProductionDb) {
    await run(
      `UPDATE tasks SET title = $1, description = $2, deadline = $3, status = $4, subject_id = $5
       WHERE id = $6 AND user_id = $7`,
      [title, description, deadline, status, subjectId, id, req.user.id]
    );
  } else {
    await run(
      `UPDATE tasks SET title = ?, description = ?, deadline = ?, status = ?, subject_id = ?
       WHERE id = ? AND user_id = ?`,
      [title, description, deadline, status, subjectId, id, req.user.id]
    );
  }

  const task = await get(`
    SELECT t.id, t.title, t.description, t.deadline, t.status,
           s.id AS subject_id, s.name AS subject_name
    FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id
    WHERE t.id = ? AND t.user_id = ?
  `, [id, req.user.id]);
  res.json({ task });
});

app.delete("/api/tasks/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  if (isProductionDb) {
    const rows = await all("DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id", [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ message: "Task not found." });
  } else {
    const result = await run("DELETE FROM tasks WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!result.changes) return res.status(404).json({ message: "Task not found." });
  }
  res.json({ message: "Task deleted." });
});

app.get("/api/dashboard", auth, async (req, res) => {
  const total = await get("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ?", [req.user.id]);
  const completed = await get("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND status = 'completed'", [req.user.id]);
  const pending = await get("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  const overdue = await get("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND status = 'pending' AND deadline IS NOT NULL AND deadline < CURRENT_TIMESTAMP", [req.user.id]);

  res.json({
    total: Number(total.count),
    completed: Number(completed.count),
    pending: Number(pending.count),
    overdue: Number(overdue.count)
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    if (!process.env.VERCEL) {
      app.listen(PORT, () => console.log(`Student Academic Task Management System running at http://localhost:${PORT}`));
    }
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });

module.exports = app;
