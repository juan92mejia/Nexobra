require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { nanoid } = require('nanoid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({ quotes: [], providers: [], projects: [] }).write();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-5';

// ---------- Nexobra Mercado: cotizaciones (multi-ítem) ----------

app.get('/api/quotes', (req, res) => {
  res.json(db.get('quotes').value());
});

app.post('/api/quotes', (req, res) => {
  const { provider, phone, pago, days, iva, transp, items } = req.body;

  if (!provider || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Falta el proveedor o al menos un ítem con material, cantidad y precio.' });
  }

  const cleanItems = items
    .map(it => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      return { material: (it.material || '').trim(), qty, price, subtotal: qty * price };
    })
    .filter(it => it.material && it.qty > 0 && it.price >= 0);

  if (cleanItems.length === 0) {
    return res.status(400).json({ error: 'Agrega al menos un ítem válido (material, cantidad y precio).' });
  }

  const ivaPct = Number(iva) || 0;
  const transpValue = Number(transp) || 0;
  const subtotalItems = cleanItems.reduce((sum, it) => sum + it.subtotal, 0);
  const ivaValue = subtotalItems * (ivaPct / 100);
  const total = subtotalItems + ivaValue + transpValue;

  const quote = {
    id: nanoid(),
    provider,
    phone: phone || null, pago: pago || null, days: days || null,
    iva: ivaPct, transp: transpValue,
    items: cleanItems,
    subtotalItems, ivaValue, total,
    createdAt: new Date().toISOString()
  };

  db.get('quotes').push(quote).write();

  if (phone) {
    const existing = db.get('providers').find({ name: provider }).value();
    if (existing) {
      db.get('providers').find({ name: provider }).assign({ phone }).write();
    } else {
      db.get('providers').push({ id: nanoid(), name: provider, phone }).write();
    }
  }

  res.status(201).json(quote);
});

app.delete('/api/quotes/:id', (req, res) => {
  db.get('quotes').remove({ id: req.params.id }).write();
  res.status(204).end();
});

// ---------- Proveedores ----------

app.get('/api/providers', (req, res) => {
  res.json(db.get('providers').value());
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
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Falta el texto de la cotización.' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(501).json({
      error: 'La extracción con IA no está configurada. Agrega ANTHROPIC_API_KEY en tu archivo .env.'
    });
  }

  const prompt = `Extrae de este texto de una cotización de construcción los datos generales y CADA material cotizado. Responde ÚNICAMENTE con un objeto JSON, sin texto adicional ni backticks, con esta forma exacta:
{"provider": string o null, "phone": string o null (solo dígitos), "pago": string o null, "days": número o null, "iva": número o null (porcentaje), "transp": número o null, "items": [{"material": string, "qty": número, "price": número (precio unitario sin símbolos)}]}

Incluye un elemento en "items" por cada material distinto que aparezca cotizado en el texto, aunque haya varios (ej: tubos, tomas, lámparas serían 3 ítems separados).

Texto:
${text}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Error de la API de Anthropic:', errText);
      return res.status(502).json({ error: 'La API de Anthropic devolvió un error.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error('Error extrayendo cotización:', err);
    res.status(500).json({ error: 'No se pudo estructurar el texto.' });
  }
});

// ---------- Fallback: servir el frontend para cualquier ruta no-API ----------

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Nexobra backend corriendo en http://localhost:${PORT}`);
});
