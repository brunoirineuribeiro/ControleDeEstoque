import 'dotenv/config';
import mysql from 'mysql2/promise';

const db = await mysql.createConnection({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'controle_estoque',
  decimalNumbers: true,
});

const products = [
  { sku: 'DEMO-CAF', name: 'Café especial em grãos', category: 'Bebidas', unit: 'kg', minimum: 10, cost: 24.9 },
  { sku: 'DEMO-CHA', name: 'Chá verde', category: 'Bebidas', unit: 'cx', minimum: 8, cost: 14.5 },
  { sku: 'DEMO-COPO', name: 'Copo biodegradável', category: 'Descartáveis', unit: 'pct', minimum: 5, cost: 1.2 },
  { sku: 'DEMO-ACUC', name: 'Açúcar orgânico', category: 'Mercearia', unit: 'kg', minimum: 5, cost: 6.9 },
];

const events = [
  { sku: 'DEMO-CAF', type: 'entrada', quantity: 45, daysAgo: 6, note: 'TESTE: recebimento inicial de café' },
  { sku: 'DEMO-CAF', type: 'saida', quantity: 8, daysAgo: 2, note: 'TESTE: consumo de café' },
  { sku: 'DEMO-CHA', type: 'entrada', quantity: 10, daysAgo: 3, note: 'TESTE: recebimento inicial de chá' },
  { sku: 'DEMO-CHA', type: 'saida', quantity: 5, daysAgo: 1, note: 'TESTE: consumo de chá' },
  { sku: 'DEMO-COPO', type: 'entrada', quantity: 22, daysAgo: 5, note: 'TESTE: recebimento de copos' },
  { sku: 'DEMO-COPO', type: 'saida', quantity: 7, daysAgo: 0, note: 'TESTE: uso de copos' },
  { sku: 'DEMO-ACUC', type: 'entrada', quantity: 4, daysAgo: 0, note: 'TESTE: recebimento de açúcar' },
];

try {
  await db.beginTransaction();
  await db.execute(
    `INSERT INTO users (google_id,name,email) VALUES ('seed-demo-user','Usuário de demonstração','demo@estoque.local')
     ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email)`,
  );
  const [[user]] = await db.query('SELECT id FROM users WHERE google_id=?', ['seed-demo-user']);

  for (const p of products) {
    await db.execute(
      `INSERT INTO products (sku,name,category,unit,quantity,minimum_quantity,cost)
       VALUES (?,?,?,?,0,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), unit=VALUES(unit), minimum_quantity=VALUES(minimum_quantity), cost=VALUES(cost)`,
      [p.sku, p.name, p.category, p.unit, p.minimum, p.cost],
    );
  }

  for (const event of events) {
    const [[product]] = await db.query('SELECT id FROM products WHERE sku=?', [event.sku]);
    const [existing] = await db.execute(
      'SELECT id FROM movements WHERE product_id=? AND user_id=? AND note=? LIMIT 1',
      [product.id, user.id, event.note],
    );
    if (existing.length) continue;
    await db.execute(
      `INSERT INTO movements (product_id,user_id,type,quantity,note,created_at)
       VALUES (?,?,?,?,?,DATE_SUB(CURDATE(), INTERVAL ? DAY) + INTERVAL 10 HOUR)`,
      [product.id, user.id, event.type, event.quantity, event.note, event.daysAgo],
    );
    await db.execute('UPDATE products SET quantity=quantity+? WHERE id=?', [event.type === 'entrada' ? event.quantity : -event.quantity, product.id]);
  }

  await db.commit();
  console.log(`Dados de demonstração prontos: ${products.length} produtos e ${events.length} movimentações (identificados como TESTE).`);
} catch (error) {
  await db.rollback();
  console.error('Falha ao inserir os dados de demonstração.');
  throw error;
} finally {
  await db.end();
}
