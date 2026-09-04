const crypto = require('crypto');
const { promisify } = require('util');
const cors = require('cors');
const scrypt = promisify(crypto.scrypt);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) { error ? reject(error) : resolve(this); }));
const publicValidation = req => ['GET', 'POST'].includes(req.method) && /^\/api\/visits\/public\/validate\/[^/]+\/?$/i.test(req.path);
const roles = new Set(['admin_goldtech', 'tecnico', 'cliente_gestor', 'cliente_usuario']);
const validPassword = value => typeof value === 'string' && value.length >= 6 && value.length <= 1024;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return 'scrypt$' + salt + '$' + hash.toString('hex');
}
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 1024 || typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) {
    // Read-only compatibility: never rewrite existing credentials during login.
    return crypto.timingSafeEqual(Buffer.from(digest(password), 'hex'), Buffer.from(digest(stored), 'hex'));
  }
  const [, salt, expected] = stored.split('$');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  return crypto.timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(expected, 'hex'));
}

function installHelpdeskAuth(app, db, { env = process.env, now = Date.now } = {}) {
  const production = env.NODE_ENV === 'production';
  const development = ['development', 'test'].includes(env.NODE_ENV || 'development');
  let frontend;
  try { frontend = new URL(env.FRONTEND_URL || 'http://localhost:5173'); } catch { throw new Error('FRONTEND_URL inválida.'); }
  if (production && (!env.FRONTEND_URL || frontend.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(frontend.hostname))) {
    throw new Error('Produção exige FRONTEND_URL HTTPS pública.');
  }
  const allowedOrigin = origin => {
    if (origin === frontend.origin) return true;
    if (!development) return false;
    try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
  };
  const cookieName = production ? '__Host-goldtech_session' : 'goldtech_session';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
  const ttl = Number(env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 24 * 60 * 60 * 1000) throw new Error('SESSION_TTL_MS inválido.');
  // Bounded, single-process session store. Restart deliberately invalidates all sessions.
  const sessions = new Map(), attempts = new Map();
  const cookieId = req => {
    const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
    if (values.length !== 1) return null;
    const value = values[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? digest(value) : null;
  };
  const prune = () => {
    for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id);
    for (const [id, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(id);
  };
  const fail = res => res.status(500).json({ error: 'Não foi possível processar a solicitação.' });
  const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
    console.error('Helpdesk request failed', { code: error.code || 'INTERNAL_ERROR' });
    return fail(res);
  });
  const requireSession = safe(async (req, res, next) => {
    prune();
    const id = cookieId(req), session = sessions.get(id);
    if (!session) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    const user = await get(db, 'SELECT id,name,username,email,role,company_id,active,password_hash FROM users WHERE id=?', [session.userId]);
    if (!user || user.active !== 1 || !roles.has(user.role) || digest(user.password_hash) !== session.passwordFingerprint) {
      sessions.delete(id);
      res.clearCookie(cookieName, cookieOptions);
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
    delete user.password_hash;
    req.user = user;
    res.set('Cache-Control', 'no-store');
    return next();
  });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Keep token-only public validation independent of cookies and session CSRF rules.
    if (publicValidation(req)) return next();
    const origin = req.get('origin');
    if (origin && !allowedOrigin(origin)) return res.status(403).json({ error: 'Origem não permitida.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path.startsWith('/api/')) {
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Origem não permitida.' });
      const emptyBody = !req.get('content-type') && !req.get('transfer-encoding') && (!req.get('content-length') || req.get('content-length') === '0');
      if (!emptyBody && !req.is('application/json')) return res.status(415).json({ error: 'Envie application/json.' });
    }
    next();
  });
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigin(origin)), credentials: true }));
  app.use((req, res, next) => {
    if (/^\/api\/(visits|users|login|auth|tickets|notifications|companies|technicians|whatsapp)(\/|$)/i.test(req.path) && !publicValidation(req)) {
      res.set('Cache-Control', 'no-store');
      const json = res.json.bind(res);
      res.json = body => {
        if (res.statusCode >= 500) {
          console.error('Helpdesk request failed', { status: res.statusCode, method: req.method });
          return json({ error: 'Não foi possível processar a solicitação.' });
        }
        return json(body);
      };
    }
    next();
  });
  app.post('/api/login', safe(async (req, res) => {
    prune();
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username || username.length > 254 || typeof password !== 'string' || password.length > 1024) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const key = digest(req.ip + ':' + username.toLowerCase());
    const attempt = attempts.get(key) || { count: 0, expires: now() + 15 * 60 * 1000 };
    if (attempt.count >= 10 || attempts.size >= 10000) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
    attempt.count++; attempts.set(key, attempt);
    const user = await get(db, 'SELECT u.id,u.username,u.name,u.role,u.company_id,u.active,u.password_hash,c.name AS company_name FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.username=?', [username]);
    if (!user || user.active !== 1 || !roles.has(user.role) || !await verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Credenciais inválidas ou usuário inativo.' });
    if (sessions.size >= 10000) return res.status(503).json({ error: 'Tente novamente mais tarde.' });
    attempts.delete(key);
    sessions.delete(cookieId(req));
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(digest(token), { userId: user.id, passwordFingerprint: digest(user.password_hash), expires: now() + ttl });
    delete user.password_hash; delete user.active;
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: ttl });
    res.json({ user });
  }));
  app.get('/api/auth/me', requireSession, (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/logout', requireSession, (req, res) => {
    sessions.delete(cookieId(req));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ success: true });
  });
  app.use('/api/visits', (req, res, next) => {
    if (['GET', 'POST'].includes(req.method) && /^\/public\/validate\/[^/]+\/?$/i.test(req.path)) return next();
    requireSession(req, res, () => {
      if (!['admin_goldtech', 'tecnico'].includes(req.user.role)) return res.status(403).json({ error: 'Permissão insuficiente.' });
      // Audit actor comes from the session, not a forged frontend identity.
      if (req.method === 'POST' && /^\/?$/.test(req.path)) { req.body ||= {}; req.body.created_by_user_id = req.user.id; }
      next();
    });
  });
  app.use('/api/users', requireSession, safe(async (req, res, next) => {
    if (req.method === 'GET') return next();
    if (!['admin_goldtech', 'cliente_gestor'].includes(req.user.role)) return res.status(403).json({ error: 'Permissão insuficiente.' });
    const body = req.body || {};
    if (body.role !== undefined && (typeof body.role !== 'string' || !roles.has(body.role.toLowerCase()))) return res.status(400).json({ error: 'Perfil inválido.' });
    if (req.user.role === 'cliente_gestor') {
      const clientRoles = ['cliente_usuario', 'cliente_gestor'];
      if (!req.user.company_id || (body.company_id !== undefined && Number(body.company_id) !== req.user.company_id) || (body.role !== undefined && !clientRoles.includes(body.role.toLowerCase()))) return res.status(403).json({ error: 'Permissão insuficiente.' });
      if (req.method !== 'POST') {
        const target = await get(db, 'SELECT company_id,role FROM users WHERE id=?', [req.path.split('/')[1]]);
        if (!target || target.company_id !== req.user.company_id || !clientRoles.includes(target.role)) return res.status(403).json({ error: 'Permissão insuficiente.' });
      }
      body.company_id = req.user.company_id;
    }
    if (req.method === 'POST' || /\/password\/?$/i.test(req.path)) {
      const key = req.method === 'POST' ? 'password_hash' : 'password';
      if (!validPassword(body[key])) return res.status(400).json({ error: 'Senha deve ter entre 6 e 1024 caracteres.' });
      body[key] = await hashPassword(body[key]);
    }
    next();
  }));
  // Company writes can otherwise corrupt the identities used by visit catalogs.
  app.use('/api/companies', (req, res, next) => {
    requireSession(req, res, () => {
      if (!['GET', 'HEAD'].includes(req.method) && req.user.role !== 'admin_goldtech') return res.status(403).json({ error: 'Permissão insuficiente.' });
      next();
    });
  });
  const internal = user => ['admin_goldtech', 'tecnico'].includes(user.role);
  const denied = res => res.status(403).json({ error: 'Permissão insuficiente.' });
  app.use('/api/technicians', requireSession, (req, res, next) => internal(req.user) ? next() : denied(res));
  app.use('/api/notifications', requireSession);
  app.use('/api/tickets', (req, res, next) => {
    const body = req.body || {};
    const isIntegrationTicket =
      req.method === 'POST' &&
      /^\/?$/.test(req.path) &&
      Boolean(body.source);

    if (isIntegrationTicket) {
      const expectedToken = env.HELPDESK_API_TOKEN;
      const authorization = req.headers.authorization;
      const receivedToken = typeof authorization === 'string'
        ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
        : undefined;

      if (!expectedToken || !receivedToken) {
        return res.status(401).json({ error: 'Token de integração inválido.' });
      }

      const expectedBuffer = Buffer.from(expectedToken);
      const receivedBuffer = Buffer.from(receivedToken);

      if (
        expectedBuffer.length !== receivedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
      ) {
        return res.status(401).json({ error: 'Token de integração inválido.' });
      }

      req.isIntegration = true;
      req.isInternal = true;
      req.user = {
        id: Number(env.HELPDESK_SYSTEM_USER_ID || 1),
        role: 'integration'
      };

      return next();
    }

    return requireSession(req, res, next);
  });

  app.use('/api/tickets', safe(async (req, res, next) => {
    req.isInternal = req.isIntegration === true || internal(req.user);
    const body = req.body ||= {};
    if (req.isIntegration === true) {
      if ((body.company_id == null || body.company_id === '') && body.client_id != null) {
        body.company_id = body.client_id;
      }
      if (typeof body.priority === 'string') {
        const priority = ['Critical', 'High', 'Medium', 'Low'].find(value => value.toLowerCase() === body.priority.toLowerCase());
        if (priority) body.priority = priority;
      }
    }
    if (!req.isInternal && !req.user.company_id) return denied(res);
    // Check tenancy before every detail, update or interaction operation.
    const match = /^\/([^/]+)/.exec(req.path);
    if (match) {
      const ticket = await get(db, 'SELECT id,company_id FROM tickets WHERE id=?', [match[1]]);
      if (!ticket || (!req.isInternal && ticket.company_id !== req.user.company_id)) return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    if (req.method === 'PUT' && !req.isInternal) return denied(res);
    if (req.method === 'POST') {
      const interaction = /\/interactions\/?$/i.test(req.path);
      const actorKey = interaction ? 'user_id' : 'opened_by_user_id';
      if (body[actorKey] !== undefined && Number(body[actorKey]) !== req.user.id) return denied(res);
      body[actorKey] = req.user.id;
      if (!req.isInternal) {
        if ((body.company_id !== undefined && Number(body.company_id) !== req.user.company_id) || body.assigned_technician_id) return denied(res);
        body.company_id = req.user.company_id;
        if (interaction && ((body.interaction_type !== undefined && body.interaction_type !== 'message') || (body.visible_to_client !== undefined && ![1, true].includes(body.visible_to_client)))) return denied(res);
        if (interaction) { body.interaction_type = 'message'; body.visible_to_client = 1; }
      }
      if (interaction) {
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 20000) return res.status(400).json({ error: 'Mensagem inválida.' });
        if (body.interaction_type !== undefined && !['message', 'internal_note'].includes(body.interaction_type)) return res.status(400).json({ error: 'Tipo de interação inválido.' });
        if (body.visible_to_client !== undefined && ![0, 1, true, false].includes(body.visible_to_client)) return res.status(400).json({ error: 'Visibilidade inválida.' });
        if (body.interaction_type === 'internal_note') body.visible_to_client = 0;
      } else {
        if (!await get(db, 'SELECT id FROM companies WHERE id=?', [body.company_id])) return res.status(400).json({ error: 'Empresa inválida.' });
      }
    }
    if (['POST', 'PUT'].includes(req.method) && body.assigned_technician_id != null) {
      const tech = await get(db, "SELECT id FROM users WHERE id=? AND active=1 AND role IN ('admin_goldtech','tecnico')", [body.assigned_technician_id]);
      if (!tech) return res.status(400).json({ error: 'Técnico inválido.' });
    }
    next();
  }));
  // No authenticated provider adapter exists for the legacy webhook. Fail closed,
  // including when an unverified environment flag is set; never process payloads.
  app.use('/api/whatsapp/webhook', (req, res) => res.status(404).json({ error: 'Integração indisponível.' }));
  const recoveryAttempts = new Map();
  app.post('/api/auth/forgot-password', (req, res, next) => {
    const message = 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    for (const [key, value] of recoveryAttempts) if (value.expires <= now()) recoveryAttempts.delete(key);
    // Do not trust forwarded IP headers. A same-origin proxy must preserve its
    // security boundary; without trusted-proxy configuration this fails closed
    // into the shared proxy-IP quota, rather than allowing header spoofing.
    const keys = [[digest('ip:' + req.ip), 20], [digest('account:' + email), 5]];
    let limited = recoveryAttempts.size >= 10000;
    for (const [key, limit] of keys) {
      const entry = recoveryAttempts.get(key) || { count: 0, expires: now() + 15 * 60 * 1000 };
      if (entry.count >= limit) limited = true;
      if (recoveryAttempts.size < 10000 || recoveryAttempts.has(key)) {
        entry.count++; recoveryAttempts.set(key, entry);
      }
    }
    if (limited || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.json({ message });
    req.body.email = email;
    next();
  });
  // Password recovery remains public, but requires its existing single-use recovery token.
  app.post('/api/auth/reset-password', safe(async (req, res) => {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !validPassword(password)) return res.status(400).json({ error: 'Token ou senha inválidos.' });
    const hash = await hashPassword(password);
    const result = await run(db, 'UPDATE users SET password_hash=?,reset_token=NULL,reset_token_expires=NULL WHERE reset_token=? AND active=1 AND julianday(reset_token_expires)>julianday(?)', [hash, token, new Date(now()).toISOString()]);
    if (result.changes !== 1) return res.status(400).json({ error: 'Token inválido ou expirado.' });
    res.json({ message: 'Senha redefinida com sucesso.' });
  }));
  return { requireSession };
}
module.exports = { installHelpdeskAuth, hashPassword, verifyPassword };
