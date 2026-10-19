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
  console.log(`Banco ${process.env.MYSQL_DATABASE || 'controle_estoque'} e tabelas inicializados.`);
} finally {
  await connection.end();
}
