'use strict';
/**
 * 持久化存储层 · 双后端
 *
 *   postgres：设置了 DATABASE_URL（postgres://…）时启用。
 *             帖子、账号、图片全部进数据库，容器重建/重新部署都不会丢。
 *   file    ：没设 DATABASE_URL 时用本地文件（data/db.json + data/uploads/），
 *             适合本机开发；但容器重建会丢数据，上线请务必配 DATABASE_URL。
 *
 * 对外 API 全部是 async，server.js 不需要关心底层是哪个后端。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = /^postgres(ql)?:\/\//i.test(DATABASE_URL);

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif'
};

let pool = null;
let cfg = { dataDir: '', dbFile: '', uploadDir: '' };
let mode = 'file';

/** 初始化存储。返回实际生效的模式：'postgres' | 'file' */
async function init(options) {
  cfg = options || cfg;
  if (!USE_PG) {
    mode = 'file';
    return mode;
  }

  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    console.error('[存储] 未安装 pg 模块，降级为本地文件模式（请在部署时执行 npm install）');
    mode = 'file';
    return mode;
  }

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // 托管数据库常要求 SSL；用 PGSSL=1 显式开启，自签证书也接受
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
      max: 4,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000
    });
    pool.on('error', err => console.error('[存储] 数据库连接池异常:', err.message));

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wall_doc (
        id         smallint    PRIMARY KEY,
        doc        jsonb       NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wall_file (
        name       text        PRIMARY KEY,
        mime       text        NOT NULL,
        bytes      bytea       NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    mode = 'postgres';
    return mode;
  } catch (err) {
    console.error('[存储] 连接数据库失败，降级为本地文件模式（数据会随容器重建丢失）:', err.message);
    try { await pool.end(); } catch { /* 忽略 */ }
    pool = null;
    mode = 'file';
    return mode;
  }
}

function getMode() { return mode; }

/** 读整份数据文档；不存在时返回 null */
async function readDoc() {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT doc FROM wall_doc WHERE id = 1');
    return r.rows.length ? r.rows[0].doc : null;
  }
  const raw = await fsp.readFile(cfg.dbFile, 'utf8');
  return JSON.parse(raw);
}

/** 整份写入（幂等覆盖） */
async function writeDoc(doc) {
  const json = JSON.stringify(doc);
  if (mode === 'postgres') {
    await pool.query(
      `INSERT INTO wall_doc (id, doc, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [json]
    );
    return;
  }
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  const tmp = cfg.dbFile + '.tmp';
  await fsp.writeFile(tmp, json);
  await fsp.rename(tmp, cfg.dbFile);
}

/** 存一张图片 */
async function putFile(name, buf) {
  if (mode === 'postgres') {
    const ext = path.extname(name).slice(1).toLowerCase();
    await pool.query(
      `INSERT INTO wall_file (name, mime, bytes) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
      [name, MIME_BY_EXT[ext] || 'application/octet-stream', buf]
    );
    return;
  }
  await fsp.mkdir(cfg.uploadDir, { recursive: true });
  await fsp.writeFile(path.join(cfg.uploadDir, name), buf);
}

/** 取一张图片；不存在返回 null */
async function getFile(name) {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT mime, bytes FROM wall_file WHERE name = $1', [name]);
    if (!r.rows.length) return null;
    const bytes = r.rows[0].bytes;
    return { mime: r.rows[0].mime, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '') };
  }
  const abs = path.join(cfg.uploadDir, name);
  const bytes = await fsp.readFile(abs).catch(() => null);
  if (!bytes) return null;
  const ext = path.extname(name).slice(1).toLowerCase();
  return { mime: MIME_BY_EXT[ext] || 'application/octet-stream', bytes };
}

/** 删一张图片（不存在也算成功） */
async function delFile(name) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM wall_file WHERE name = $1', [name]);
    return;
  }
  await fsp.unlink(path.join(cfg.uploadDir, name)).catch(() => {});
}

async function close() {
  if (pool) { try { await pool.end(); } catch { /* 忽略 */ } pool = null; }
}

module.exports = { init, getMode, readDoc, writeDoc, putFile, getFile, delFile, close };
