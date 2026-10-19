import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import mysql from 'mysql2/promise';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Configure um SESSION_SECRET com pelo menos 32 caracteres em produção.');
const pool = mysql.createPool({ host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '', database: process.env.MYSQL_DATABASE || 'controle_estoque', waitForConnections: true, connectionLimit: 10, decimalNumbers: true, dateStrings: true });
const Store = MySQLStoreFactory(session);
const sessionStore = new Store({}, pool as any);
const oauth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL);

declare module 'express-session' { interface SessionData { user?: { id: number; name: string; email: string; picture?: string }; oauthState?: string } }
app.use(express.json({ limit: '32kb' }));
app.use(session({ name: 'estoque.sid', secret: process.env.SESSION_SECRET || 'development-only-change-me', store: sessionStore, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 } }));

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).send('Configure as credenciais do Google no arquivo .env.');
  const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state;
  res.redirect(oauth.generateAuthUrl({ access_type: 'online', scope: ['openid', 'email', 'profile'], state }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Não foi possível validar o login. Tente novamente.');
    delete req.session.oauthState;
    const { tokens } = await oauth.getToken(String(req.query.code));
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token!, audience: process.env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) return res.status(401).send('A conta Google não possui um e-mail verificado.');
    const allowed = (process.env.GOOGLE_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(profile.email.toLowerCase())) return res.status(403).send('Esta conta não está autorizada a acessar o sistema.');
    const [result] = await pool.execute<any>('INSERT INTO users (google_id,name,email,picture) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), picture=VALUES(picture)', [profile.sub, profile.name || profile.email, profile.email, profile.picture || null]);
    const [rows] = await pool.execute<any[]>('SELECT id,name,email,picture FROM users WHERE google_id=?', [profile.sub]);
    await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.user = rows[0];
    res.redirect(process.env.APP_URL || 'http://localhost:5173');
  } catch (error) { console.error('Falha no login Google:', error); res.status(500).send('Falha ao concluir o login. Confira as configurações e tente novamente.'); }
});
app.post('/auth/logout', (req, res) => req.session.destroy(err => { if (err) return res.status(500).json({ error: 'Não foi possível encerrar a sessão.' }); res.clearCookie('estoque.sid'); res.json({ ok: true }); }));
const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => req.session.user ? next() : res.status(401).json({ error: 'Entre com sua conta Google para continuar.' });
const devLoginEnabled = () => process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_LOGIN === 'true';
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null, googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), devLoginEnabled: devLoginEnabled() }));
app.post('/auth/dev-login', async (req, res) => {
  if (!devLoginEnabled()) return res.status(404).json({ error: 'Login de teste desativado.' });
  const [rows] = await pool.execute<any[]>('SELECT id,name,email,picture FROM users WHERE google_id=?', ['seed-demo-user']);
  if (!rows.length) return res.status(404).json({ error: 'Usuário de demonstração não encontrado. Execute npm run db:seed-demo.' });
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.user = rows[0];
  res.json({ user: rows[0] });
});
app.get('/api/dashboard', auth, async (req, res) => {
  const [summary] = await pool.execute<any[]>('SELECT COUNT(*) totalProducts, COALESCE(SUM(quantity),0) totalUnits, COALESCE(SUM(quantity*cost),0) stockValue, SUM(CASE WHEN quantity <= minimum_quantity THEN 1 ELSE 0 END) lowStock FROM products WHERE active=1');
  const [recent] = await pool.execute<any[]>('SELECT m.id,m.type,m.quantity,m.note,m.created_at createdAt,p.name product,p.sku,u.name user FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC LIMIT 8');
  const [weekly] = await pool.execute<any[]>('SELECT DATE(created_at) day, type, SUM(quantity) quantity FROM movements WHERE created_at >= DATE_SUB(CURDATE(),INTERVAL 6 DAY) GROUP BY DATE(created_at),type ORDER BY day');
  res.json({ summary: summary[0], recent, weekly });
});
app.get('/api/products', auth, async (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`;
  const [rows] = await pool.execute('SELECT * FROM products WHERE (? = "%%" OR name LIKE ? OR sku LIKE ? OR category LIKE ?) ORDER BY updated_at DESC', [search, search, search, search]); res.json(rows);
});
app.post('/api/products', auth, async (req, res) => {
  const { sku, name, category = 'Geral', unit = 'un', quantity = 0, minimum_quantity = 0, cost = 0 } = req.body || {};
  if (!String(sku || '').trim() || !String(name || '').trim()) return res.status(400).json({ error: 'Código e nome são obrigatórios.' });
  if ([quantity, minimum_quantity, cost].some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) return res.status(400).json({ error: 'Estoque, mínimo e custo devem ser números iguais ou maiores que zero.' });
  try { const [r] = await pool.execute<any>('INSERT INTO products (sku,name,category,unit,quantity,minimum_quantity,cost) VALUES (?,?,?,?,?,?,?)', [sku.trim(), name.trim(), category, unit, quantity, minimum_quantity, cost]); res.status(201).json({ id: r.insertId }); }
  catch (e:any) { if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este código de produto já está cadastrado.' }); throw e; }
});
app.put('/api/products/:id', auth, async (req, res) => {
  const { sku, name, category = 'Geral', unit = 'un', quantity = 0, minimum_quantity = 0, cost = 0, active = true } = req.body || {};
  if (!String(sku || '').trim() || !String(name || '').trim()) return res.status(400).json({ error: 'Código e nome são obrigatórios.' });
  if ([quantity, minimum_quantity, cost].some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) return res.status(400).json({ error: 'Estoque, mínimo e custo devem ser números iguais ou maiores que zero.' });
  try { const [r] = await pool.execute<any>('UPDATE products SET sku=?,name=?,category=?,unit=?,quantity=?,minimum_quantity=?,cost=?,active=? WHERE id=?', [sku.trim(),name.trim(),category,unit,quantity,minimum_quantity,cost,Boolean(active),req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Produto não encontrado.' }); res.json({ ok: true }); }
  catch (e:any) { if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este código de produto já está cadastrado.' }); throw e; }
});
app.delete('/api/products/:id', auth, async (req, res) => {
  try { const [r] = await pool.execute<any>('DELETE FROM products WHERE id=?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Produto não encontrado.' }); res.json({ ok: true }); }
  catch (e:any) { if (e.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ error: 'Este produto possui movimentações e não pode ser excluído. Edite o produto e desative-o.' }); throw e; }
});
app.get('/api/movements', auth, async (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`; const type = ['entrada','saida'].includes(String(req.query.type)) ? String(req.query.type) : null;
  const from = String(req.query.from || ''); const to = String(req.query.to || '');
  const [rows] = await pool.execute('SELECT m.id,m.type,m.quantity,m.note,m.created_at createdAt,p.id productId,p.name product,p.sku,u.name user FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id WHERE (p.name LIKE ? OR p.sku LIKE ?) AND (? IS NULL OR m.type=?) AND (? = "" OR DATE(m.created_at)>=?) AND (? = "" OR DATE(m.created_at)<=?) ORDER BY m.created_at DESC LIMIT 300', [search,search,type,type,from,from,to,to]); res.json(rows);
});
app.post('/api/movements', auth, async (req, res) => {
  const { product_id, type, quantity, note = '' } = req.body || {};
  if (!Number.isInteger(Number(product_id)) || !['entrada','saida'].includes(type) || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) return res.status(400).json({ error: 'Informe um produto, tipo de movimentação e quantidade válida.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction(); const [rows] = await conn.execute<any[]>('SELECT id,quantity FROM products WHERE id=? AND active=1 FOR UPDATE', [product_id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Produto ativo não encontrado.' }); }
    const current = Number(rows[0].quantity), amount = Number(quantity);
    if (type === 'saida' && current < amount) { await conn.rollback(); return res.status(409).json({ error: `Saldo insuficiente. Disponível: ${current}.` }); }
    await conn.execute('INSERT INTO movements (product_id,user_id,type,quantity,note) VALUES (?,?,?,?,?)', [product_id,req.session.user!.id,type,amount,String(note).slice(0,500)]);
    await conn.execute('UPDATE products SET quantity=quantity+? WHERE id=?', [type === 'entrada' ? amount : -amount,product_id]);
    await conn.commit(); res.status(201).json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
});
app.use((error:any, _req:express.Request, res:express.Response, _next:express.NextFunction) => { console.error(error); res.status(500).json({ error: 'Ocorreu um erro no servidor.' }); });
app.listen(port, () => console.log(`API de estoque disponível na porta ${port}`));
