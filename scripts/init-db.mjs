import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  multipleStatements: true,
});

try {
  const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
  await connection.query(schema);
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
  console.log(`Banco ${process.env.MYSQL_DATABASE || 'controle_estoque'} e tabelas inicializados.`);
} finally {
  await connection.end();
}
