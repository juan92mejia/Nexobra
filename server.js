require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { MongoClient } = require('mongodb');

// ---------- Almacenamiento persistente ----------
// Si se configura MONGODB_URI (una base de datos gratuita en MongoDB Atlas, ver
// README), todos los datos de Nexobra se guardan ahí — sobreviven a que el servidor
// se duerma/reinicie, que es lo que pasa con el disco local en el plan gratuito de
// Render. Si no se configura, sigue funcionando con el archivo local db.json de
// siempre (útil para probar en tu computador), aunque en Render ese archivo se borra
// cada vez que el servicio se reinicia.
class MongoStateAdapter {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName || 'nexobra';
    this.client = null;
    this.collection = null;
    this._writeQueue = Promise.resolve();
  }
  async _ensureConnected() {
    if (!this.collection) {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.collection = this.client.db(this.dbName).collection('nexobra_state');
    }
  }
  async read() {
    await this._ensureConnected();
    const doc = await this.collection.findOne({ _id: 'main' });
    return doc ? doc.state : null;
  }
  write(data) {
    // Encola las escrituras para que siempre queden en el mismo orden en que se
    // pidieron, aunque una tarde más que otra en llegar a la base de datos.
    this._writeQueue = this._writeQueue.then(async () => {
      await this._ensureConnected();
      await this.collection.updateOne({ _id: 'main' }, { $set: { state: data, updatedAt: new Date() } }, { upsert: true });
    });
    return this._writeQueue;
  }
}

// Fusiona con lo que ya exista guardado (importante en producción: no queremos
// perder cotizaciones/proyectos ya guardados solo porque agregamos colecciones nuevas).
const DEFAULT_STATE = {
  quotes: [],
  providers: [],
  projects: [],
  budgetItems: [],
  ordersInProgress: [],
  completedOrders: [],
  materialAliases: [],
  obras: [],
  agreements: [],
  groups: [],
  empresas: [],
  sessions: [],
  activityLog: [],
  settings: {
    costoCapitalAnual: 0, tolerancia: 0, esRetenedor: true, pctAnticipado: 60, pctDisparo: 15, toleranciaCompletitud: 8,
    empresaNombre: '', empresaNit: '', empresaDireccion: ''
  }
};

// `db` se asigna dentro de startServer(), antes de que se acepte cualquier petición
// — el resto del archivo (todas las rutas) puede seguir usando `db` con toda
// normalidad porque para cuando llegue una petición real ya está listo.
let db;
const usingMongo = !!process.env.MONGODB_URI;

function fmtLog(n) { return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n || 0); }

function logActivity(req, action, entity, summary) {
  try {
    const log = db.get('activityLog');
    log.push({ id: nanoid(), ts: new Date().toISOString(), groupId: (req && req.groupId) || null, action, entity, summary }).write();
    // Evita que el historial crezca sin límite para siempre — conserva las últimas 5000 acciones.
    const all = log.value();
    if (all.length > 5000) db.set('activityLog', all.slice(all.length - 5000)).write();
  } catch (e) { /* el historial nunca debe tumbar una petición */ }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const UVT_2025 = 49799; // valor referencial DIAN 2025 — verifica el vigente cada año
const RETEFUENTE_BASE_UVT = 10;

function getSettings() {
  return db.get('settings').value() || DEFAULT_STATE.settings;
}

// ---------- Autenticación por grupo empresarial ----------
// Un "grupo empresarial" (ej. un holding) inicia sesión con un solo usuario/contraseña.
// Dentro de ese login puede tener varias empresas (cada una con su propio NIT), y cada
// empresa segmenta sus propias obras/cotizaciones/presupuesto — pero los proveedores se
// comparten en toda la aplicación. Si más adelante se necesita vincular OTRO grupo
// empresarial ajeno, se crea con su propio usuario/contraseña independiente.
// Mientras no exista ningún grupo creado, la app funciona sin pedir login (modo simple,
// para no bloquear a quien la usa como una sola empresa).

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;
  return db.get('sessions').find({ token }).value() || null;
}
function empresaIdsForGroup(groupId) {
  return db.get('empresas').filter({ groupId }).map(e => e.id).value();
}
function scopeByGroup(list, req) {
  if (!req.groupId) return list;
  const ids = empresaIdsForGroup(req.groupId);
  return list.filter(x => !x.empresaId || ids.includes(x.empresaId));
}

async function askClaude(prompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('missing_key');
    err.code = 'missing_key';
    throw err;
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens || 1000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('Error de la API de Anthropic:', errText);
    const err = new Error('api_error');
    err.code = 'api_error';
    throw err;
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(c => c.type === 'text');
  const raw = textBlock ? textBlock.text : '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Calcula todos los valores derivados de una cotización: subtotales, IVA, costo
// financiero del anticipo, y las retenciones colombianas (retefuente, ReteICA,
// garantía técnica). Las retenciones NO cambian el costo total — solo a quién se
// le paga cada peso — así que nunca alteran `total`, solo el neto al proveedor.
function calcQuote(q, settings) {
  const items = (q.items || []).map(it => ({ ...it, subtotal: (Number(it.qty) || 0) * (Number(it.price) || 0) }));
  const subtotalItems = items.reduce((s, it) => s + it.subtotal, 0);
  const ivaValue = subtotalItems * ((Number(q.iva) || 0) / 100);
  const anticipoPct = Number(q.anticipoPct) || 0;
  const anticipoMonto = subtotalItems * (anticipoPct / 100);
  const days = Number(q.days) || 0;
  const costoCapitalAnual = Number(settings.costoCapitalAnual) || 0;
  const financeCost = anticipoMonto * (costoCapitalAnual / 100) * (days / 365);
  const transp = Number(q.transp) || 0;
  const total = subtotalItems + ivaValue + transp + financeCost;

  const superaBaseRetefuente = subtotalItems >= (UVT_2025 * RETEFUENTE_BASE_UVT);
  const retefuentePct = q.declarante === 'no' ? 3.5 : 2.5;
  const retefuenteMonto = (settings.esRetenedor && superaBaseRetefuente) ? subtotalItems * (retefuentePct / 100) : 0;
  const reteicaMonto = subtotalItems * ((Number(q.reteicaPct) || 0) / 100);
  const garantiaMonto = total * ((Number(q.garantiaPct) || 0) / 100);
  const netoInmediatoProveedor = total - retefuenteMonto - reteicaMonto - garantiaMonto;

  return { ...q, items, subtotalItems, ivaValue, transp, anticipoMonto, financeCost, total, retefuentePct, retefuenteMonto, reteicaMonto, garantiaMonto, netoInmediatoProveedor, superaBaseRetefuente };
}

function ensureProvider(name, phone) {
  let p = db.get('providers').find(x => x.name.toLowerCase() === String(name).toLowerCase()).value();
  if (!p) {
    p = { id: nanoid(), name, phone: phone || null, nit: '', direccion: '', categoria: '', orders: 0, onTime: 0, late: 0, qualityGood: 0, qualityRegular: 0, qualityBad: 0, spend: 0 };
    db.get('providers').push(p).write();
  } else if (phone) {
    db.get('providers').find({ id: p.id }).assign({ phone }).write();
  }
  return p;
}

function withProviderDefaults(p) {
  return { nit: '', direccion: '', categoria: '', orders: 0, onTime: 0, late: 0, qualityGood: 0, qualityRegular: 0, qualityBad: 0, spend: 0, ...p };
}

function providerStats(p) {
  if (!p.orders) return null;
  const onTimePct = (p.onTime / p.orders) * 100;
  const qualityAvg = ((p.qualityGood * 100) + (p.qualityRegular * 60) + (p.qualityBad * 20)) / p.orders;
  return { orders: p.orders, onTimePct, qualityAvg, spend: p.spend || 0 };
}

// Exige sesión válida en toda /api excepto /api/auth/* — pero solo una vez que exista
// al menos un grupo empresarial creado. Si nadie ha configurado un login todavía, la
// app sigue funcionando abierta (modo simple, como antes de este cambio).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  const hasGroups = db.get('groups').value().length > 0;
  if (!hasGroups) return next();
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
  req.groupId = session.groupId;
  next();
});

app.get('/api/auth/status', (req, res) => {
  res.json({ hasGroups: db.get('groups').value().length > 0 });
});

app.post('/api/auth/setup', (req, res) => {
  if (db.get('groups').value().length > 0) return res.status(400).json({ error: 'Ya existe un grupo empresarial configurado. Pide que te creen un usuario, o inicia sesión.' });
  const { groupNombre, username, password, empresas } = req.body;
  if (!groupNombre || !username || !password) return res.status(400).json({ error: 'Completa el nombre del grupo empresarial, usuario y contraseña.' });
  if (String(password).length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
  const { salt, hash } = hashPassword(password);
  const group = { id: nanoid(), nombre: String(groupNombre).trim(), username: String(username).trim().toLowerCase(), salt, hash };
  db.get('groups').push(group).write();
  const empresasCreadas = (Array.isArray(empresas) ? empresas : [])
    .filter(e => e && e.nombre)
    .map(e => ({ id: nanoid(), groupId: group.id, nombre: String(e.nombre).trim(), nit: String(e.nit || '').trim(), direccion: String(e.direccion || '').trim() }));
  empresasCreadas.forEach(e => db.get('empresas').push(e).write());
  const token = nanoid();
  db.get('sessions').push({ token, groupId: group.id, createdAt: new Date().toISOString() }).write();
  res.status(201).json({ token, group: { id: group.id, nombre: group.nombre }, empresas: empresasCreadas });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const group = db.get('groups').find(g => g.username === String(username || '').trim().toLowerCase()).value();
  if (!group || !verifyPassword(password, group.salt, group.hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  const token = nanoid();
  db.get('sessions').push({ token, groupId: group.id, createdAt: new Date().toISOString() }).write();
  const empresas = db.get('empresas').filter({ groupId: group.id }).value();
  res.json({ token, group: { id: group.id, nombre: group.nombre }, empresas });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) db.get('sessions').remove({ token }).write();
  res.status(204).end();
});

app.post('/api/auth/groups', (req, res) => {
  // Vincular otro grupo empresarial ajeno al actual — cada uno con su propio login independiente.
  const { groupNombre, username, password, empresas } = req.body;
  if (!groupNombre || !username || !password) return res.status(400).json({ error: 'Completa el nombre del grupo empresarial, usuario y contraseña.' });
  if (String(password).length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
  const existing = db.get('groups').find(g => g.username === String(username).trim().toLowerCase()).value();
  if (existing) return res.status(400).json({ error: 'Ese nombre de usuario ya existe. Elige otro.' });
  const { salt, hash } = hashPassword(password);
  const group = { id: nanoid(), nombre: String(groupNombre).trim(), username: String(username).trim().toLowerCase(), salt, hash };
  db.get('groups').push(group).write();
  const empresasCreadas = (Array.isArray(empresas) ? empresas : [])
    .filter(e => e && e.nombre)
    .map(e => ({ id: nanoid(), groupId: group.id, nombre: String(e.nombre).trim(), nit: String(e.nit || '').trim(), direccion: String(e.direccion || '').trim() }));
  empresasCreadas.forEach(e => db.get('empresas').push(e).write());
  res.status(201).json({ group: { id: group.id, nombre: group.nombre }, empresas: empresasCreadas });
});

app.get('/api/me', (req, res) => {
  if (!req.groupId) return res.json({ group: null, empresas: [] });
  const group = db.get('groups').find({ id: req.groupId }).value();
  const empresas = db.get('empresas').filter({ groupId: req.groupId }).value();
  res.json({ group: group ? { id: group.id, nombre: group.nombre } : null, empresas });
});

// ---------- Empresas dentro del grupo empresarial ----------
// Cada empresa tiene su propio NIT/razón social para membretar cotizaciones y órdenes
// de compra, pero todas comparten el mismo listado de proveedores de la aplicación.

app.post('/api/empresas', (req, res) => {
  if (!req.groupId) return res.status(400).json({ error: 'Inicia sesión para crear empresas dentro de un grupo empresarial.' });
  const { nombre, nit, direccion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Escribe la razón social de la empresa.' });
  const empresa = { id: nanoid(), groupId: req.groupId, nombre: String(nombre).trim(), nit: String(nit || '').trim(), direccion: String(direccion || '').trim() };
  db.get('empresas').push(empresa).write();
  logActivity(req, 'crear', 'empresa', `Empresa agregada al grupo: ${empresa.nombre}`);
  res.status(201).json(empresa);
});

app.put('/api/empresas/:id', (req, res) => {
  const ref = db.get('empresas').find({ id: req.params.id });
  const empresa = ref.value();
  if (!empresa || (req.groupId && empresa.groupId !== req.groupId)) return res.status(404).json({ error: 'Empresa no encontrada.' });
  const { nombre, nit, direccion } = req.body;
  const updates = {};
  if (nombre != null) updates.nombre = String(nombre).trim();
  if (nit != null) updates.nit = String(nit).trim();
  if (direccion != null) updates.direccion = String(direccion).trim();
  ref.assign(updates).write();
  logActivity(req, 'editar', 'empresa', `Empresa actualizada: ${ref.value().nombre}`);
  res.json(ref.value());
});

app.delete('/api/empresas/:id', (req, res) => {
  const empresa = db.get('empresas').find({ id: req.params.id }).value();
  if (!empresa || (req.groupId && empresa.groupId !== req.groupId)) return res.status(404).json({ error: 'Empresa no encontrada.' });
  db.get('empresas').remove({ id: req.params.id }).write();
  logActivity(req, 'eliminar', 'empresa', `Empresa eliminada del grupo: ${empresa.nombre}`);
  res.status(204).end();
});

// ---------- Historial de acciones ----------
// Registro de todo lo que se crea/edita/elimina en Nexobra Mercado, para poder
// consultar el histórico y verificar cotizaciones nuevas contra lo ya registrado.

app.get('/api/activity', (req, res) => {
  const list = scopeByGroup(db.get('activityLog').value(), req);
  res.json([...list].reverse()); // más reciente primero
});

app.delete('/api/activity', (req, res) => {
  const all = db.get('activityLog').value();
  const kept = req.groupId ? all.filter(a => a.groupId !== req.groupId) : [];
  db.set('activityLog', kept).write();
  res.status(204).end();
});

// ---------- Ajustes de comparación ----------

app.get('/api/settings', (req, res) => res.json(getSettings()));

app.put('/api/settings', (req, res) => {
  const current = getSettings();
  const fields = ['costoCapitalAnual', 'tolerancia', 'esRetenedor', 'pctAnticipado', 'pctDisparo', 'toleranciaCompletitud', 'empresaNombre', 'empresaNit', 'empresaDireccion'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] != null) updates[f] = req.body[f]; });
  const merged = { ...current, ...updates };
  db.set('settings', merged).write();
  res.json(merged);
});

// ---------- Nexobra Mercado: cotizaciones (multi-ítem) ----------

app.get('/api/quotes', (req, res) => {
  const settings = getSettings();
  res.json(scopeByGroup(db.get('quotes').value(), req).map(q => calcQuote(q, settings)));
});

app.post('/api/quotes', (req, res) => {
  const { provider, phone, pago, days, iva, transp, items, city, anticipoPct, declarante, reteicaPct, garantiaPct, garantiaDias, obraId, empresaId } = req.body;

  if (!provider || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Falta el proveedor o al menos un ítem con material, cantidad y precio.' });
  }

  const cleanItems = items
    .map(it => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      let disponible = it.disponible === '' || it.disponible == null ? qty : Number(it.disponible);
      if (isNaN(disponible)) disponible = qty;
      if (disponible > qty) disponible = qty;
      return { material: (it.material || '').trim(), qty, price, disponible, subtotal: qty * price };
    })
    .filter(it => it.material && it.qty > 0 && it.price >= 0);

  if (cleanItems.length === 0) {
    return res.status(400).json({ error: 'Agrega al menos un ítem válido (material, cantidad y precio).' });
  }

  const quote = {
    id: nanoid(),
    provider,
    phone: phone || null,
    pago: pago || null,
    days: days || null,
    iva: Number(iva) || 0,
    transp: Number(transp) || 0,
    city: city || null,
    anticipoPct: Number(anticipoPct) || 0,
    declarante: declarante === 'no' ? 'no' : 'si',
    reteicaPct: Number(reteicaPct) || 0,
    garantiaPct: Number(garantiaPct) || 0,
    garantiaDias: Number(garantiaDias) || 0,
    obraId: obraId || null,
    empresaId: empresaId || null,
    items: cleanItems,
    createdAt: new Date().toISOString()
  };

  db.get('quotes').push(quote).write();
  ensureProvider(provider, phone || null);
  logActivity(req, 'crear', 'cotizacion', `Cotización de ${provider} (${cleanItems.length} ítem${cleanItems.length === 1 ? '' : 's'})`);

  res.status(201).json(calcQuote(quote, getSettings()));
});

// Editar una cotización ya guardada: datos básicos, pago/condiciones, garantía técnica
// y los materiales cotizados (agregar/quitar ítems). Reemplaza el registro completo,
// igual que crearla, pero conserva su id y fecha de creación original.
app.put('/api/quotes/:id', (req, res) => {
  const ref = db.get('quotes').find({ id: req.params.id });
  const existing = ref.value();
  if (!existing) return res.status(404).json({ error: 'No se encontró la cotización.' });

  const { provider, phone, pago, days, iva, transp, items, city, anticipoPct, declarante, reteicaPct, garantiaPct, garantiaDias, obraId, empresaId } = req.body;

  if (!provider || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Falta el proveedor o al menos un ítem con material, cantidad y precio.' });
  }

  const cleanItems = items
    .map(it => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      let disponible = it.disponible === '' || it.disponible == null ? qty : Number(it.disponible);
      if (isNaN(disponible)) disponible = qty;
      if (disponible > qty) disponible = qty;
      return { material: (it.material || '').trim(), qty, price, disponible, subtotal: qty * price };
    })
    .filter(it => it.material && it.qty > 0 && it.price >= 0);

  if (cleanItems.length === 0) {
    return res.status(400).json({ error: 'Agrega al menos un ítem válido (material, cantidad y precio).' });
  }

  const updates = {
    provider, phone: phone || null, pago: pago || null, days: days || null,
    iva: Number(iva) || 0, transp: Number(transp) || 0, city: city || null,
    anticipoPct: Number(anticipoPct) || 0, declarante: declarante === 'no' ? 'no' : 'si',
    reteicaPct: Number(reteicaPct) || 0, garantiaPct: Number(garantiaPct) || 0, garantiaDias: Number(garantiaDias) || 0,
    obraId: obraId || null, empresaId: empresaId != null ? (empresaId || null) : existing.empresaId,
    items: cleanItems, updatedAt: new Date().toISOString()
  };

  ref.assign(updates).write();
  ensureProvider(provider, phone || null);
  logActivity(req, 'editar', 'cotizacion', `Cotización de ${provider} actualizada (${cleanItems.length} ítem${cleanItems.length === 1 ? '' : 's'})`);
  res.json(calcQuote(ref.value(), getSettings()));
});

app.delete('/api/quotes/:id', (req, res) => {
  const existing = db.get('quotes').find({ id: req.params.id }).value();
  db.get('quotes').remove({ id: req.params.id }).write();
  if (existing) logActivity(req, 'eliminar', 'cotizacion', `Cotización de ${existing.provider} eliminada`);
  res.status(204).end();
});

// ---------- Proveedores: historial real de cumplimiento y gasto ----------

app.get('/api/providers', (req, res) => {
  const providers = db.get('providers').value().map(withProviderDefaults);
  const totalSpend = providers.reduce((s, p) => s + (p.spend || 0), 0);
  res.json(providers.map(p => ({ ...p, stats: providerStats(p), participacionPct: totalSpend > 0 ? ((p.spend || 0) / totalSpend) * 100 : 0 })));
});

app.put('/api/providers/:id', (req, res) => {
  const { nit, direccion, categoria, phone } = req.body;
  const ref = db.get('providers').find({ id: req.params.id });
  if (!ref.value()) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  const updates = {};
  if (nit != null) updates.nit = String(nit).trim();
  if (direccion != null) updates.direccion = String(direccion).trim();
  if (categoria != null) updates.categoria = String(categoria).trim();
  if (phone != null) updates.phone = String(phone).trim();
  ref.assign(updates).write();
  const p = withProviderDefaults(ref.value());
  res.json({ ...p, stats: providerStats(p) });
});

// ---------- Pedidos: marcar cotización como pedido, y registrar el resultado ----------

app.get('/api/orders/in-progress', (req, res) => {
  res.json(db.get('ordersInProgress').value());
});

app.get('/api/orders/completed', (req, res) => {
  res.json(db.get('completedOrders').value());
});

// Generar un pedido a partir de una cotización — opcionalmente solo con una PARTE de
// sus materiales (cuando al final no se compra el pedido completo). La cotización
// original nunca se modifica: el pedido es un registro nuevo con los totales
// recalculados solo para los materiales seleccionados.
app.post('/api/orders', (req, res) => {
  const { quoteId, items: selectedNames } = req.body;
  const quote = db.get('quotes').find({ id: quoteId }).value();
  if (!quote) return res.status(404).json({ error: 'No se encontró la cotización.' });

  let itemsToUse = quote.items;
  let parcial = false;
  if (Array.isArray(selectedNames) && selectedNames.length > 0 && selectedNames.length < quote.items.length) {
    const wanted = new Set(selectedNames.map(normalizeMaterialName));
    const filtered = quote.items.filter(it => wanted.has(normalizeMaterialName(it.material)));
    if (filtered.length > 0) { itemsToUse = filtered; parcial = true; }
  }

  const calc = calcQuote({ ...quote, items: itemsToUse }, getSettings());
  const entry = {
    id: nanoid(),
    quoteId: quote.id,
    provider: quote.provider,
    resumen: itemsToUse.map(it => `${it.qty} ${it.material}`).join(', '),
    items: itemsToUse.map(it => ({ material: it.material, qty: it.qty, price: it.price })),
    total: calc.total,
    parcial,
    diasPrometidos: Number(quote.days) || 0,
    fechaPedido: new Date().toISOString().slice(0, 10)
  };
  db.get('ordersInProgress').push(entry).write();
  logActivity(req, 'crear', 'pedido', `Pedido a ${quote.provider}${parcial ? ' (parcial)' : ''} por $${fmtLog(calc.total)}`);
  res.status(201).json(entry);
});

app.post('/api/orders/:id/complete', (req, res) => {
  const order = db.get('ordersInProgress').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'No se encontró el pedido en curso.' });

  const onTime = !!req.body.onTime;
  const quality = ['buena', 'regular', 'mala'].includes(req.body.quality) ? req.body.quality : 'buena';

  const prov = ensureProvider(order.provider, null);
  const updates = {
    orders: (prov.orders || 0) + 1,
    onTime: (prov.onTime || 0) + (onTime ? 1 : 0),
    late: (prov.late || 0) + (onTime ? 0 : 1),
    qualityGood: (prov.qualityGood || 0) + (quality === 'buena' ? 1 : 0),
    qualityRegular: (prov.qualityRegular || 0) + (quality === 'regular' ? 1 : 0),
    qualityBad: (prov.qualityBad || 0) + (quality === 'mala' ? 1 : 0),
    spend: (prov.spend || 0) + order.total
  };
  db.get('providers').find({ id: prov.id }).assign(updates).write();

  const completed = { id: nanoid(), provider: order.provider, items: order.items, total: order.total, onTime, quality, fecha: new Date().toISOString().slice(0, 10) };
  db.get('completedOrders').push(completed).write();
  db.get('ordersInProgress').remove({ id: order.id }).write();
  logActivity(req, 'completar', 'pedido', `Pedido de ${order.provider} recibido — ${onTime ? 'a tiempo' : 'con retraso'}, calidad ${quality}`);

  res.json(completed);
});

// ---------- Presupuesto de obra y compra anticipada ----------

app.get('/api/budget', (req, res) => {
  res.json(scopeByGroup(db.get('budgetItems').value(), req));
});

app.post('/api/budget', (req, res) => {
  const { material, unidad, cantidadTotal, obraId, empresaId } = req.body;
  const cantidad = Number(cantidadTotal);
  if (!material || isNaN(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: 'Completa material y una cantidad total mayor a 0.' });
  }
  const item = { id: nanoid(), material: String(material).trim(), unidad: unidad ? String(unidad).trim() : '', cantidadTotal: cantidad, obraId: obraId || null, empresaId: empresaId || null };
  db.get('budgetItems').push(item).write();
  logActivity(req, 'crear', 'presupuesto', `Material de presupuesto: ${item.material} (${fmtLog(cantidad)} ${item.unidad || 'unid.'})`);
  res.status(201).json(item);
});

app.post('/api/budget/bulk', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const obraId = req.body.obraId || null;
  const empresaId = req.body.empresaId || null;
  const created = [];
  items.forEach(it => {
    const cantidad = Number(it.cantidad != null ? it.cantidad : it.cantidadTotal);
    if (!it.material || isNaN(cantidad) || cantidad <= 0) return;
    const item = { id: nanoid(), material: String(it.material).trim(), unidad: it.unidad ? String(it.unidad).trim() : '', cantidadTotal: cantidad, obraId, empresaId };
    db.get('budgetItems').push(item).write();
    created.push(item);
  });
  if (created.length > 0) logActivity(req, 'importar', 'presupuesto', `${created.length} materiales de presupuesto importados`);
  res.status(201).json({ count: created.length, items: created });
});

app.delete('/api/budget/:id', (req, res) => {
  const existing = db.get('budgetItems').find({ id: req.params.id }).value();
  db.get('budgetItems').remove({ id: req.params.id }).write();
  if (existing) logActivity(req, 'eliminar', 'presupuesto', `Material de presupuesto eliminado: ${existing.material}`);
  res.status(204).end();
});

// ---------- Unificación de materiales equivalentes ----------
// Distintos proveedores nombran el mismo material de forma diferente
// ("Válvula compuerta elástica 2\" HD" vs "Válvula compuerta elástica BR 2\" APOLO").
// Sin esto, el comparador los trata como productos distintos y nunca detecta que
// un proveedor cubre el pedido completo. La unificación SIEMPRE la confirma una
// persona — nunca se fusiona automáticamente, para no ocultar que en realidad
// podrían ser productos diferentes (marca, modelo, calidad).

function normalizeMaterialName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

app.get('/api/material-aliases', (req, res) => {
  res.json(db.get('materialAliases').value());
});

app.post('/api/material-aliases', (req, res) => {
  const names = (Array.isArray(req.body.names) ? req.body.names : []).map(normalizeMaterialName).filter(Boolean);
  const canonical = String(req.body.canonical || '').trim();
  if (!canonical || names.length < 1) {
    return res.status(400).json({ error: 'Falta el nombre unificado o los materiales a unir.' });
  }
  const groups = db.get('materialAliases');
  // Si alguno de los nombres ya pertenece a un grupo existente, se fusiona ahí en vez de duplicar.
  let existing = groups.value().find(g => names.some(n => g.aliases.includes(n)) || g.aliases.includes(normalizeMaterialName(canonical)));
  if (existing) {
    const merged = Array.from(new Set([...existing.aliases, ...names, normalizeMaterialName(canonical)]));
    groups.find({ id: existing.id }).assign({ canonical, aliases: merged }).write();
    return res.status(200).json(groups.find({ id: existing.id }).value());
  }
  const group = { id: nanoid(), canonical, aliases: Array.from(new Set([...names, normalizeMaterialName(canonical)])) };
  groups.push(group).write();
  logActivity(req, 'crear', 'unificacion', `Materiales unificados como "${canonical}"`);
  res.status(201).json(group);
});

app.delete('/api/material-aliases/:id', (req, res) => {
  const existing = db.get('materialAliases').find({ id: req.params.id }).value();
  db.get('materialAliases').remove({ id: req.params.id }).write();
  if (existing) logActivity(req, 'eliminar', 'unificacion', `Se deshizo la unificación de "${existing.canonical}"`);
  res.status(204).end();
});

// ---------- Obras/proyectos (para segmentar cotizaciones y presupuesto) ----------
// Inspirado en el "control de presupuesto por obra" de plataformas de e-procurement
// como IConstruye, pero sin forzar la complejidad: si no creas ninguna obra, todo
// sigue funcionando junto como hasta ahora ("General").

app.get('/api/obras', (req, res) => {
  res.json(scopeByGroup(db.get('obras').value(), req));
});

app.post('/api/obras', (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para la obra/proyecto.' });
  const obra = { id: nanoid(), nombre, empresaId: req.body.empresaId || null };
  db.get('obras').push(obra).write();
  logActivity(req, 'crear', 'obra', `Obra creada: ${nombre}`);
  res.status(201).json(obra);
});

app.delete('/api/obras/:id', (req, res) => {
  const existing = db.get('obras').find({ id: req.params.id }).value();
  db.get('obras').remove({ id: req.params.id }).write();
  if (existing) logActivity(req, 'eliminar', 'obra', `Obra eliminada: ${existing.nombre}`);
  res.status(204).end();
});

// ---------- Acuerdos marco / compra contra convenios ----------
// Un precio pactado con un proveedor para un material, vigente por un periodo —
// igual que "Compra contra Convenios" en las plataformas grandes de e-procurement.
// Se muestra como precio de referencia en el comparador y avisa cuando el acuerdo
// está por vencer, para renegociar a tiempo (esto último no lo vimos en la competencia).

app.get('/api/agreements', (req, res) => {
  res.json(scopeByGroup(db.get('agreements').value(), req));
});

app.post('/api/agreements', (req, res) => {
  const { provider, material, price, iva, vigenciaHasta, empresaId } = req.body;
  const priceNum = Number(price);
  if (!provider || !material || !priceNum || priceNum <= 0 || !vigenciaHasta) {
    return res.status(400).json({ error: 'Completa proveedor, material, precio pactado y fecha de vigencia.' });
  }
  const agreement = { id: nanoid(), provider: String(provider).trim(), material: String(material).trim(), price: priceNum, iva: Number(iva) || 0, vigenciaHasta, empresaId: empresaId || null };
  db.get('agreements').push(agreement).write();
  ensureProvider(provider, null);
  logActivity(req, 'crear', 'acuerdo', `Acuerdo marco con ${agreement.provider} para ${agreement.material} — $${fmtLog(priceNum)}, vigente hasta ${vigenciaHasta}`);
  res.status(201).json(agreement);
});

app.delete('/api/agreements/:id', (req, res) => {
  const existing = db.get('agreements').find({ id: req.params.id }).value();
  db.get('agreements').remove({ id: req.params.id }).write();
  if (existing) logActivity(req, 'eliminar', 'acuerdo', `Acuerdo marco eliminado: ${existing.provider} — ${existing.material}`);
  res.status(204).end();
});

// ---------- Nexobra Nextrics: proyectos financieros ----------

function calcProject(p) {
  const contrato = Number(p.contrato) || 0;
  const adiciones = Number(p.adiciones) || 0;
  const contratoTotal = contrato + adiciones;
  const presupuesto = Number(p.presupuesto) || 0;
  const ejecutado = Number(p.ejecutado) || 0;
  const pagado = Number(p.pagado) || 0;
  const avance = Number(p.avance) || 0;

  const margenPresupuestado = contratoTotal > 0 ? ((contratoTotal - presupuesto) / contratoTotal) * 100 : 0;
  let proyeccionCosto = presupuesto;
  let desviacionPct = 0;
  if (avance > 0) {
    proyeccionCosto = (ejecutado / avance) * 100;
    desviacionPct = presupuesto > 0 ? ((proyeccionCosto - presupuesto) / presupuesto) * 100 : 0;
  }
  const margenProyectado = contratoTotal > 0 ? ((contratoTotal - proyeccionCosto) / contratoTotal) * 100 : 0;

  let fechaFinEstimada = null, diasTranscurridos = null, avanceEsperado = null, atrasoCronograma = null;
  const duracionDias = Number(p.duracionDias) || 0;
  if (p.fechaInicio && duracionDias > 0) {
    const inicio = new Date(p.fechaInicio + 'T00:00:00');
    if (!isNaN(inicio.getTime())) {
      const fin = new Date(inicio.getTime() + duracionDias * 86400000);
      fechaFinEstimada = fin.toISOString().slice(0, 10);
      const transcurridosRaw = Math.floor((Date.now() - inicio.getTime()) / 86400000);
      diasTranscurridos = Math.max(0, Math.min(duracionDias, transcurridosRaw));
      avanceEsperado = (diasTranscurridos / duracionDias) * 100;
      atrasoCronograma = avance - avanceEsperado;
    }
  }

  return {
    ...p, contratoTotal, margenPresupuestado, margenProyectado, desviacionPct,
    proyeccionCosto, porCobrar: contratoTotal - pagado,
    fechaFinEstimada, diasTranscurridos, avanceEsperado, atrasoCronograma
  };
}

app.get('/api/projects', (req, res) => {
  const projects = db.get('projects').value().map(calcProject);
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { nombre, contrato, adiciones, presupuesto, ejecutado, pagado, avance, fechaInicio, duracionDias } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El proyecto necesita un nombre.' });

  const project = {
    id: nanoid(), nombre,
    contrato: Number(contrato) || 0,
    adiciones: Number(adiciones) || 0,
    presupuesto: Number(presupuesto) || 0,
    ejecutado: Number(ejecutado) || 0,
    pagado: Number(pagado) || 0,
    avance: Number(avance) || 0,
    fechaInicio: fechaInicio || null,
    duracionDias: Number(duracionDias) || 0,
    updatedAt: new Date().toISOString()
  };
  db.get('projects').push(project).write();
  res.status(201).json(calcProject(project));
});

app.put('/api/projects/:id', (req, res) => {
  const existing = db.get('projects').find({ id: req.params.id }).value();
  if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const fields = ['nombre', 'contrato', 'adiciones', 'presupuesto', 'ejecutado', 'pagado', 'avance', 'fechaInicio', 'duracionDias'];
  const updates = { updatedAt: new Date().toISOString() };
  fields.forEach(f => { if (req.body[f] != null) updates[f] = req.body[f]; });

  db.get('projects').find({ id: req.params.id }).assign(updates).write();
  const updated = db.get('projects').find({ id: req.params.id }).value();
  res.json(calcProject(updated));
});

app.delete('/api/projects/:id', (req, res) => {
  db.get('projects').remove({ id: req.params.id }).write();
  res.status(204).end();
});

// ---------- Extracción de cotizaciones con IA (usa tu propia llave de Anthropic) ----------

app.post('/api/extract', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto de la cotización.' });

  const prompt = `Extrae de este texto de una cotización de construcción en Colombia los datos generales y CADA material cotizado. Responde ÚNICAMENTE con un objeto JSON, sin texto adicional ni backticks, con esta forma exacta:
{"provider": string o null, "phone": string o null (solo dígitos), "pago": string o null, "days": número o null, "iva": número o null (porcentaje), "transp": número o null, "city": string o null (ciudad desde la que despachan), "anticipoPct": número o null (porcentaje de anticipo, 0 si no piden), "declarante": "si" o "no" (si se menciona si el proveedor es declarante de renta; si no se menciona usa "si"), "reteicaPct": número o null (si se menciona tarifa de ReteICA), "garantiaPct": número o null (retención de garantía técnica si se menciona), "garantiaDias": número o null (plazo de liberación de la garantía si se menciona), "items": [{"material": string, "qty": número, "price": número (precio unitario sin símbolos), "disponible": número o null (unidades disponibles ahora; si dice stock completo usa qty; si no se menciona, null)}]}

Incluye un elemento en "items" por cada material distinto que aparezca cotizado en el texto, aunque haya varios (ej: tubos, tomas, lámparas serían 3 ítems separados).

Texto:
${text}`;

  try {
    const parsed = await askClaude(prompt, 1200);
    res.json(parsed);
  } catch (err) {
    if (err.code === 'missing_key') return res.status(501).json({ error: 'La extracción con IA no está configurada. Agrega ANTHROPIC_API_KEY en tu archivo .env.' });
    console.error('Error extrayendo cotización:', err);
    res.status(500).json({ error: 'No se pudo estructurar el texto.' });
  }
});

// ---------- IA: fabricantes/distribuidores conocidos para un material ----------

app.post('/api/ai/manufacturers', async (req, res) => {
  const { material, city } = req.body;
  if (!material || !material.trim()) return res.status(400).json({ error: 'Falta el material.' });

  const prompt = `Dame hasta 6 nombres de empresas fabricantes o distribuidores mayoristas ampliamente conocidos en Colombia ` +
    `para el material de construcción "${material}"${city ? ' (idealmente con presencia u operación cerca de ' + city + ')' : ''}. ` +
    `Responde SOLO un JSON array de strings con los nombres de las empresas, sin URLs, teléfonos ni descripciones. ` +
    `Usa únicamente nombres de empresas reales y conocidas que sepas que existen en Colombia para ese tipo de material; ` +
    `si no conoces ninguna con confianza, responde un array vacío [].`;

  try {
    const parsed = await askClaude(prompt, 400);
    res.json({ names: Array.isArray(parsed) ? parsed : [] });
  } catch (err) {
    if (err.code === 'missing_key') return res.status(501).json({ error: 'La sugerencia con IA no está configurada. Agrega ANTHROPIC_API_KEY en tu archivo .env.' });
    res.status(500).json({ error: 'No se pudo consultar la IA en este momento.' });
  }
});

// ---------- IA: referencia aproximada de ReteICA por ciudad ----------

app.post('/api/ai/reteica', async (req, res) => {
  const { city } = req.body;
  if (!city || !city.trim()) return res.status(400).json({ error: 'Falta la ciudad.' });

  const prompt = `Da una referencia MUY aproximada y no oficial de la tarifa de ReteICA (retención de industria y comercio) ` +
    `que suele aplicarse a la compra/comercio de materiales de construcción en el municipio de "${city}", Colombia. ` +
    `Responde SOLO JSON: {"rango": "texto corto con el rango aproximado, por ejemplo '3 a 7 por mil', o null si no tienes ninguna referencia confiable para ese municipio", ` +
    `"nota": "una frase corta recordando que es solo referencial y debe confirmarse con el proveedor o la Secretaría de Hacienda municipal"}`;

  try {
    const parsed = await askClaude(prompt, 300);
    res.json(parsed);
  } catch (err) {
    if (err.code === 'missing_key') return res.status(501).json({ error: 'La sugerencia con IA no está configurada. Agrega ANTHROPIC_API_KEY en tu archivo .env.' });
    res.status(500).json({ error: 'No se pudo consultar la IA en este momento.' });
  }
});

// ---------- IA: interpretar texto de un presupuesto de obra (ej. extraído de un PDF) ----------

app.post('/api/ai/budget-extract', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del presupuesto.' });

  const prompt = `Este es un fragmento de texto extraído automáticamente de un PDF de presupuesto de obra de construcción ` +
    `(las columnas pueden haber quedado desordenadas). Extrae los ítems de MATERIALES (ignora mano de obra, ` +
    `equipos, transporte interno y subtotales) como un JSON array de objetos {"material": string, "unidad": string, "cantidad": número}. ` +
    `Si un ítem no tiene cantidad clara o no es un material físico, no lo incluyas. Si no encuentras ítems claros, responde [].\n\nTexto:\n${text}`;

  try {
    const parsed = await askClaude(prompt, 2000);
    res.json({ items: Array.isArray(parsed) ? parsed : [] });
  } catch (err) {
    if (err.code === 'missing_key') return res.status(501).json({ error: 'La interpretación con IA no está configurada. Agrega ANTHROPIC_API_KEY en tu archivo .env.' });
    res.status(500).json({ error: 'No se pudo interpretar el texto en este momento.' });
  }
});

// ---------- Fallback: servir el frontend para cualquier ruta no-API ----------

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  const adapter = usingMongo
    ? new MongoStateAdapter(process.env.MONGODB_URI, process.env.MONGODB_DB)
    : new FileSync(path.join(__dirname, 'db.json'));
  db = await low(adapter);
  await db.setState(Object.assign({}, DEFAULT_STATE, db.getState())).write();

  app.listen(PORT, () => {
    console.log(`Nexobra backend corriendo en http://localhost:${PORT}` + (usingMongo ? ' — datos persistentes en MongoDB' : ' — datos en archivo local db.json (no persistente en Render sin MONGODB_URI)'));
  });
}

startServer().catch(err => {
  console.error('No se pudo iniciar Nexobra:', err);
  process.exit(1);
});
