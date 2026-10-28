import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const database = process.env.MYSQL_DATABASE || 'controle_estoque';
if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('MYSQL_DATABASE deve conter apenas letras, números e sublinhados.');
const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  multipleStatements: true,
  ...(process.env.MYSQL_SSL === 'true' ? { ssl: {
    ...(process.env.MYSQL_SSL_CA ? { ca: fs.readFileSync(process.env.MYSQL_SSL_CA, 'utf8') } : {}),
    rejectUnauthorized: process.env.MYSQL_SSL_VERIFY !== 'false',
  } } : {}),
});

try {
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (error) {
    if (error.code !== 'ER_DBACCESS_DENIED_ERROR') throw error;
  }
  await connection.query(`USE \`${database}\``);
  const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
  const tableSchema = schema.replace(/^CREATE DATABASE IF NOT EXISTS [^;]+;\s*USE [^;]+;\s*/i, '');
  await connection.query(tableSchema);
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await connection.execute(
      `INSERT INTO access_users (email,name,role,active) VALUES (?,?,'admin',TRUE)
       ON DUPLICATE KEY UPDATE role='admin', active=TRUE`,
      [email, email],
    );
  }
  const legacyAllowed = (process.env.GOOGLE_ALLOWED_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  for (const email of legacyAllowed) {
    await connection.execute(
      `INSERT IGNORE INTO access_users (email,name,role,active) VALUES (?,?,'user',TRUE)`,
      [email, email],
    );
  }
  if (!admins.length && legacyAllowed.length) {
    const [[{ totalAdmins }]] = await connection.query('SELECT COUNT(*) totalAdmins FROM access_users WHERE role=\'admin\' AND active=TRUE');
    if (!Number(totalAdmins)) {
      await connection.execute("UPDATE access_users SET role='admin',active=TRUE WHERE email=?", [legacyAllowed[0]]);
    }
  }
  console.log(`Tabelas do banco ${database} inicializadas.`);
} finally {
  await connection.end();
}
