# Student Academic Task Management System

A simple full-stack student task manager built with Node.js, Express, HTML/CSS/JS, and a database.

## Local development

1. Install Node.js 22+.
2. Run `npm install`.
3. Run `npm start`.
4. Open http://localhost:3000.

When `DATABASE_URL` is not set, the app uses a local SQLite database at `data/app.db`.

## Production deployment

For Vercel, set `DATABASE_URL` to a hosted PostgreSQL connection string (Neon is recommended) and set `JWT_SECRET` to a long random secret. The app automatically creates its required tables on startup.

Do not commit `.env` or `.env.local` files containing secrets.
