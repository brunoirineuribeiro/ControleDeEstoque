import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import mysql from 'mysql2/promise';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Configure um SESSION_SECRET com pelo menos 32 caracteres em produção.');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const mysqlSslCa = process.env.MYSQL_SSL_CA;
const pool = mysql.createPool({ host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '', database: process.env.MYSQL_DATABASE || 'controle_estoque', waitForConnections: true, connectionLimit: 10, decimalNumbers: true, dateStrings: true, ...(mysqlSslCa ? { ssl: { ca: fs.readFileSync(mysqlSslCa, 'utf8'), rejectUnauthorized: true } } : {}) });
const Store = MySQLStoreFactory(session);
const sessionStore = new Store({}, pool as any);
const oauth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL);

declare module 'express-session' { interface SessionData { user?: { id: number; name: string; email: string; picture?: string; role: 'admin' | 'user' }; oauthState?: string } }
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
    const email = profile.email.toLowerCase();
    const [authorizedRows] = await pool.execute<any[]>('SELECT role FROM access_users WHERE email=? AND active=TRUE', [email]);
    if (!authorizedRows.length) return res.status(403).send('Este e-mail ainda não foi autorizado. Peça um convite ao administrador do sistema.');
    const [linkedEmailRows] = await pool.execute<any[]>('SELECT google_id FROM users WHERE email=?', [email]);
    if (linkedEmailRows.length && linkedEmailRows[0].google_id !== profile.sub) return res.status(403).send('Este e-mail já está vinculado a outra conta Google.');
    const [result] = await pool.execute<any>('INSERT INTO users (google_id,name,email,picture) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), picture=VALUES(picture)', [profile.sub, profile.name || profile.email, email, profile.picture || null]);
    const [rows] = await pool.execute<any[]>('SELECT id,name,email,picture FROM users WHERE google_id=?', [profile.sub]);
    await pool.execute('UPDATE access_users SET accepted_at=COALESCE(accepted_at,CURRENT_TIMESTAMP), name=IF(name=email,?,name) WHERE email=?', [profile.name || profile.email, email]);
    await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.user = { ...rows[0], role: authorizedRows[0].role };
    res.redirect(process.env.APP_URL || 'http://localhost:5173');
  } catch (error) { console.error('Falha no login Google:', error); res.status(500).send('Falha ao concluir o login. Confira as configurações e tente novamente.'); }
});
app.post('/auth/logout', (req, res) => req.session.destroy(err => { if (err) return res.status(500).json({ error: 'Não foi possível encerrar a sessão.' }); res.clearCookie('estoque.sid'); res.json({ ok: true }); }));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
const auth: express.RequestHandler = async (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Entre com sua conta Google para continuar.' });
  try {
    const [rows] = await pool.execute<any[]>('SELECT role FROM access_users WHERE email=? AND active=TRUE', [req.session.user.email.toLowerCase()]);
    if (!rows.length) {
      req.session.destroy(() => undefined);
      return res.status(401).json({ error: 'Seu acesso foi revogado. Entre em contato com o administrador.' });
    }
    req.session.user.role = rows[0].role;
    next();
  } catch (error) { next(error); }
};
const adminOnly: express.RequestHandler = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Somente administradores podem gerenciar usuários.' });
app.get('/api/me', async (req, res, next) => {
  if (!req.session.user) return res.json({ user: null, googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
  try {
    const [rows] = await pool.execute<any[]>('SELECT role FROM access_users WHERE email=? AND active=TRUE', [req.session.user.email.toLowerCase()]);
    if (!rows.length) {
      req.session.destroy(() => undefined);
      return res.json({ user: null, googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
    }
    req.session.user.role = rows[0].role;
    res.json({ user: req.session.user, googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
  } catch (error) { next(error); }
});

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
async function deliverInvite(email: string, name: string, role: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('Configure RESEND_API_KEY e EMAIL_FROM para habilitar o envio de convites.');
  const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  const safeName = escapeHtml(name || email);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [email], subject: 'Convite para o Controle de Estoque',
      text: `Olá, ${name || email}! Você recebeu um convite para acessar o Controle de Estoque como ${role === 'admin' ? 'administrador' : 'usuário'}. Acesse ${appUrl} e entre com esta conta Google: ${email}`,
      html: `<p>Olá, ${safeName}!</p><p>Você recebeu um convite para acessar o <strong>Controle de Estoque</strong> como ${role === 'admin' ? 'administrador' : 'usuário'}.</p><p><a href="${appUrl}">Acessar o sistema</a> e entrar com esta conta Google: <strong>${escapeHtml(email)}</strong>.</p>`,
    }),
  });
  if (!response.ok) throw new Error('O serviço de e-mail não aceitou o convite. Confira a configuração do Resend.');
}

app.get('/api/users', auth, adminOnly, async (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`;
  const [rows] = await pool.execute("SELECT a.id,a.email,a.name,a.role,a.active,a.invited_at invitedAt,a.invite_sent_at inviteSentAt,a.accepted_at acceptedAt FROM access_users a WHERE (?='%%' OR a.email LIKE ? OR a.name LIKE ?) ORDER BY a.invited_at DESC", [search, search, search]);
  res.json(rows);
});
app.post('/api/users', auth, adminOnly, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (!name || name.length > 160) return res.status(400).json({ error: 'Informe o nome do usuário (até 160 caracteres).' });
  try {
    const [created] = await pool.execute<any>('INSERT INTO access_users (email,name,role,active,invited_by) VALUES (?,?,?,TRUE,?)', [email, name, role, req.session.user!.id]);
    try {
      await deliverInvite(email, name, role);
      await pool.execute('UPDATE access_users SET invite_sent_at=CURRENT_TIMESTAMP WHERE id=?', [created.insertId]);
      res.status(201).json({ id: created.insertId, inviteSent: true });
    } catch (error) {
      console.error('Falha ao enviar convite:', error);
      res.status(201).json({ id: created.insertId, inviteSent: false, message: error instanceof Error ? error.message : 'Usuário cadastrado, mas o convite não foi enviado.' });
    }
  } catch (error: any) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    throw error;
  }
});
app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  const active = Boolean(req.body?.active);
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (!name || name.length > 160) return res.status(400).json({ error: 'Informe o nome do usuário (até 160 caracteres).' });
  const [currentRows] = await pool.execute<any[]>('SELECT id,email,role,active FROM access_users WHERE id=?', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const current = currentRows[0];
  if (current.email === req.session.user!.email && (email !== current.email || role !== 'admin' || !active)) return res.status(409).json({ error: 'Não é possível remover, desativar ou alterar o próprio acesso de administrador.' });
  if (current.role === 'admin' && current.active && (role !== 'admin' || !active)) {
    const [[{ total }]] = await pool.query<any[]>('SELECT COUNT(*) total FROM access_users WHERE role=\'admin\' AND active=TRUE AND id<>?', [req.params.id]);
    if (!Number(total)) return res.status(409).json({ error: 'O sistema precisa manter ao menos um administrador ativo.' });
  }
  try {
    const [updated] = await pool.execute<any>('UPDATE access_users SET email=?,name=?,role=?,active=? WHERE id=?', [email,name,role,active,req.params.id]);
    if (!updated.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ ok: true });
  } catch (error: any) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    throw error;
  }
});
app.post('/api/users/:id/invite', auth, adminOnly, async (req, res) => {
  const [rows] = await pool.execute<any[]>('SELECT email,name,role,active FROM access_users WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!rows[0].active) return res.status(409).json({ error: 'Ative o usuário antes de enviar um convite.' });
  try {
    await deliverInvite(rows[0].email, rows[0].name, rows[0].role);
    await pool.execute('UPDATE access_users SET invite_sent_at=CURRENT_TIMESTAMP WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Não foi possível enviar o convite.' }); }
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Usuário inválido.' });
  const [rows] = await pool.execute<any[]>('SELECT id,email,role,active FROM access_users WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const target = rows[0];
  if (target.email === req.session.user!.email) return res.status(409).json({ error: 'Não é possível remover o próprio acesso.' });
  if (target.role === 'admin' && target.active) {
    const [[{ total }]] = await pool.query<any[]>('SELECT COUNT(*) total FROM access_users WHERE role=\'admin\' AND active=TRUE AND id<>?', [req.params.id]);
    if (!Number(total)) return res.status(409).json({ error: 'O sistema precisa manter ao menos um administrador ativo.' });
  }
  await pool.execute('DELETE FROM access_users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
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
if (process.env.NODE_ENV === 'production') {
  const distPath = fileURLToPath(new URL('../dist', import.meta.url));
  if (!fs.existsSync(path.join(distPath, 'index.html'))) throw new Error('Build do frontend não encontrado. Execute "pnpm run build" antes de iniciar em produção.');
  app.use(express.static(distPath, { index: 'index.html', maxAge: '1h' }));
}
app.use((error:any, _req:express.Request, res:express.Response, _next:express.NextFunction) => { console.error(error); res.status(500).json({ error: 'Ocorreu um erro no servidor.' }); });
async function startServer() {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await pool.execute(
      `INSERT INTO access_users (email,name,role,active) VALUES (?,?,'admin',TRUE)
       ON DUPLICATE KEY UPDATE role='admin', active=TRUE`,
      [email, email],
    );
  }
  app.listen(port, () => console.log(`API de estoque disponível na porta ${port}`));
}
startServer().catch(error => { console.error('Falha ao inicializar o sistema de usuários:', error); process.exit(1); });
