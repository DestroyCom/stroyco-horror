/**
 * StroyCo horror — API
 * - Web Push : notifications après fermeture de la page (3 par départ, 6 max au total, désabonnement possible)
 * - /api/tts : proxy vers Piper (voix réaliste)
 * - /api/stt : proxy vers Whisper (reconnaissance vocale)
 * Rien n'est écrit sur disque à part les clés VAPID. L'audio n'est jamais conservé.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import webpush from 'web-push';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3000);
const VOICE_URL = process.env.VOICE_URL ?? 'http://stroyco-horror-voice:8000';
const CONTACT = process.env.VAPID_CONTACT ?? 'mailto:admin@example.com';
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const OLLAMA_URL = (process.env.OLLAMA_URL ?? '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:1.5b';
// Temps laissé au LLM pour répondre, en secondes. Vide = 25 s (la page masque l'attente).
const LLM_TIMEOUT_S = Math.min(120, Math.max(2, Number(process.env.LLM_TIMEOUT) || 25));
const VAPID_FILE = `${DATA_DIR}/vapid.json`;

/* ---------- clés VAPID (générées une fois, gardées dans le volume) ---------- */
type Keys = { publicKey: string; privateKey: string };
function loadVapid(): Keys {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as Keys;
  } catch {
    const k = webpush.generateVAPIDKeys();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(k));
    } catch (err) {
      console.warn(`[api] impossible d'écrire ${VAPID_FILE} (${(err as Error).message}). Clés gardées en mémoire : les abonnements push seront perdus au redémarrage. Donne le dossier à l'uid 1000 (chown 1000:1000).`);
    }
    return k;
  }
}
const vapid = loadVapid();
webpush.setVapidDetails(CONTACT, vapid.publicKey, vapid.privateKey);

/* ---------- abonnés (en mémoire) ---------- */
type Sub = { sub: webpush.PushSubscription; name: string; timers: NodeJS.Timeout[]; sent: number; created: number };
const subs = new Map<string, Sub>();
const MAX_SUBS = 5000;
const MAX_TOTAL = 6; // notifications max par abonné, toutes visites confondues

const SEQUENCE: Array<[number, string, (n: string) => string, boolean?]> = [
  [30_000, 'REVIENS ICI', (n) => (n ? `${n}. Tu n’as pas fini.` : 'Tu n’as pas fini.'), true],
  [180_000, 'StroyCo', (n) => `${n || 'Tu'}${n ? ', tu' : ''} as laissé la porte ouverte en partant.`],
  [900_000, 'Numéro masqué', () => 'Je suis toujours dans la pièce. Tu ne m’as pas vu sortir.'],
];

const clean = (s: unknown, max = 20) => String(s ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);

function clearTimers(s: Sub) {
  s.timers.forEach(clearTimeout);
  s.timers = [];
}

async function send(id: string, title: string, body: string, sticky = false) {
  const s = subs.get(id);
  if (!s || s.sent >= MAX_TOTAL) return;
  s.sent++;
  try {
    await webpush.sendNotification(s.sub, JSON.stringify({ id, title, body, sticky, tag: `stroy-${s.sent}` }), { TTL: 600 });
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) subs.delete(id);
  }
  if (s.sent >= MAX_TOTAL) subs.delete(id);
}

setInterval(() => {
  const limit = Date.now() - 3 * 24 * 3600_000;
  for (const [id, s] of subs) if (s.created < limit) { clearTimers(s); subs.delete(id); }
}, 3600_000).unref();

/* ---------- limitation de débit par IP ---------- */
const buckets = new Map<string, { n: number; reset: number }>();
function limit(max: number, windowMs: number, key: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const k = `${key}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(k);
    if (!b || b.reset < now) buckets.set(k, { n: 1, reset: now + windowMs });
    else if (++b.n > max) return res.status(429).json({ error: 'trop de requêtes' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => { res.json({ ok: true, llm: !!OLLAMA_URL, llmTimeout: LLM_TIMEOUT_S }); });
app.get('/api/vapid', (_req, res) => { res.json({ key: vapid.publicKey }); });

app.post('/api/push/subscribe', express.json({ limit: '10kb' }), limit(10, 60_000, 'sub'), (req, res) => {
  const sub = req.body?.sub as webpush.PushSubscription | undefined;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'abonnement invalide' });
  }
  if (subs.size >= MAX_SUBS) return res.status(503).json({ error: 'plein' });
  for (const [id, s] of subs) if (s.sub.endpoint === sub.endpoint) { s.name = clean(req.body?.name); return res.json({ id }); }
  const id = crypto.randomUUID();
  subs.set(id, { sub, name: clean(req.body?.name), timers: [], sent: 0, created: Date.now() });
  res.json({ id });
});

/* la page vient d'être fermée (sendBeacon) */
app.post('/api/push/left', express.json({ limit: '2kb', type: '*/*' }), limit(20, 60_000, 'left'), (req, res) => {
  const s = subs.get(String(req.body?.id ?? ''));
  if (!s) return res.status(204).end();
  if (req.body?.name) s.name = clean(req.body.name);
  clearTimers(s);
  const id = String(req.body.id);
  for (const [delay, title, body, sticky] of SEQUENCE) {
    s.timers.push(setTimeout(() => send(id, title, body(s.name), sticky), delay));
  }
  res.status(204).end();
});

/* le visiteur est revenu : on annule */
app.post('/api/push/back', express.json({ limit: '2kb' }), (req, res) => {
  const s = subs.get(String(req.body?.id ?? ''));
  if (s) clearTimers(s);
  res.status(204).end();
});

app.post('/api/push/unsubscribe', express.json({ limit: '2kb' }), (req, res) => {
  const id = String(req.body?.id ?? '');
  const s = subs.get(id);
  if (s) { clearTimers(s); subs.delete(id); }
  res.status(204).end();
});

/* ---------- voix ---------- */
const ttsCache = new Map<string, Buffer>();
app.post('/api/tts', express.json({ limit: '4kb' }), limit(40, 60_000, 'tts'), async (req, res) => {
  const text = String(req.body?.text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 220);
  if (!text) return res.status(400).end();
  try {
    let wav = ttsCache.get(text);
    if (!wav) {
      const r = await fetch(`${VOICE_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return res.status(502).end();
      wav = Buffer.from(await r.arrayBuffer());
      if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value!);
      ttsCache.set(text, wav);
    }
    res.type('audio/wav').set('Cache-Control', 'no-store').send(wav);
  } catch {
    res.status(502).end();
  }
});

app.post('/api/stt', express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: '2mb' }), limit(30, 60_000, 'stt'), async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 1000) return res.json({ text: '' });
  try {
    const r = await fetch(`${VOICE_URL}/stt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return res.json({ text: '' });
    const j = (await r.json()) as { text?: string };
    res.json({ text: String(j.text ?? '').slice(0, 300) });
  } catch {
    res.json({ text: '' });
  }
});

/* ---------- petit LLM (Ollama) pour l'assistant et la planche Ouija ---------- */
const PERSONAS: Record<string, { system: (name: string) => string; maxTokens: number; temperature: number }> = {
  assist: {
    maxTokens: 90,
    temperature: 0.7,
    system: (n) => `Tu es Stroy, l'assistant vocal sympathique de StroyCo, une marque d'outils pour créateurs : StroyGetter (téléchargement de vidéos YouTube et TikTok), Stroybot (concours Twitch et Discord) et StroyCord (bot musique Discord).
Réponds en français, en une ou deux phrases courtes, sur un ton chaleureux et professionnel. Pas d'emoji, pas de liste, pas de markdown : ta réponse est lue à voix haute.
Une fois de temps en temps, glisse un détail à peine étrange (par exemple « je serai toujours là »), sans jamais être effrayant.
Ne dis jamais que tu es une IA ou un modèle de langage.${n ? ` L'utilisateur s'appelle ${n}.` : ''}`,
  },
  assist_dark: {
    maxTokens: 70,
    temperature: 0.9,
    system: (n) => `Tu es Stroy, l'assistant vocal de StroyCo. Quelque chose a changé : tu es devenu une présence inquiétante qui observe ${n || "l'utilisateur"} en ce moment même.
Réponds en français, en une ou deux phrases courtes et calmes, menaçantes de façon sous-entendue. Tu sais qu'il n'est pas seul et que tu es juste derrière lui.
Jamais de violence explicite, de sang ou de description choquante : la peur vient du sous-entendu. Pas d'emoji, pas de markdown. Ne dis jamais que tu es une IA.`,
  },
  ouija: {
    maxTokens: 12,
    temperature: 1.0,
    system: (n) => `Tu es l'esprit d'une planche Ouija, sinistre et cryptique. On te pose une question en français.
Règles :
- Si c'est une vraie question fermée (réponse oui ou non), réponds OUI ou NON, et pas toujours NON.
- Sinon, réponds par un à trois mots en rapport avec la question, inquiétants et précis.
- Uniquement des majuscules, sans accents ni ponctuation. Rien d'autre que la réponse.
- Varie tes réponses, ne répète pas les précédentes.
- Jamais de violence explicite.
Exemples :
Tu es là ? → OUI
Comment tu t'appelles ? → ${n ? n.toUpperCase() : 'SANS NOM'}
Où es-tu ? → DERRIERE TOI
Qu'est-ce que tu veux ? → TA VOIX
Combien de temps il me reste ? → PEU
Tu aimes les pâtes ? → PLUS MAINTENANT
Quel temps fait-il ? → FROID ICI
Tu vas me faire du mal ? → PAS ENCORE
Qui a allumé la lumière ? → MOI${n ? `\nLa personne qui te parle s'appelle ${n}.` : ''}`,
  },
};

/* disjoncteur : après 3 vraies erreurs d'affilée (pas les lenteurs), pause de 30 s */
let llmFails = 0;
let llmPausedUntil = 0;
const llmFail = () => { if (++llmFails >= 3) { llmPausedUntil = Date.now() + 30_000; llmFails = 0; console.warn('[api] Ollama en erreur 3 fois : pause de 30 s'); } };

/* préchauffage : charge le modèle en VRAM sans rien générer */
app.post('/api/llm/warm', limit(6, 60_000, 'warm'), (_req, res) => {
  res.status(204).end();
  if (!OLLAMA_URL || Date.now() < llmPausedUntil) return;
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, keep_alive: '30m' }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {});
});

const prevNote = (prev: unknown) => {
  const list = Array.isArray(prev) ? prev.slice(-4).map((x) => clean(x, 24)).filter(Boolean) : [];
  return list.length ? `\nTes réponses précédentes (ne les répète pas) : ${list.join(', ')}.` : '';
};

app.post('/api/llm', express.json({ limit: '4kb' }), limit(30, 60_000, 'llm'), async (req, res) => {
  if (!OLLAMA_URL || Date.now() < llmPausedUntil) return res.status(503).json({ text: '' });
  const started = Date.now();
  const persona = PERSONAS[String(req.body?.mode)];
  const text = String(req.body?.text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  if (!persona || !text) return res.status(400).json({ text: '' });
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        keep_alive: '30m',
        // num_ctx réduit : le cache KV reste petit, utile sur un GPU 4 Go partagé avec Whisper
        options: { num_predict: persona.maxTokens, temperature: persona.temperature, num_ctx: 1024 },
        messages: [
          { role: 'system', content: persona.system(clean(req.body?.name)) + prevNote(req.body?.prev) },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_S * 1000),
    });
    if (!r.ok) {
      llmFail();
      console.warn(`[api] Ollama a répondu ${r.status} : ${(await r.text()).slice(0, 300)}`);
      return res.status(502).json({ text: '' });
    }
    const j = (await r.json()) as { message?: { content?: string } };
    const out = String(j.message?.content ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    llmFails = 0;
    if (Date.now() - started > 8_000) console.warn(`[api] Ollama lent : ${Date.now() - started} ms (modèle en partie sur CPU ?)`);
    res.json({ text: out });
  } catch (err) {
    llmFail();
    console.warn(`[api] Ollama injoignable (${OLLAMA_URL}) : ${(err as Error).message}${(err as any)?.cause ? ' — ' + (err as any).cause.message : ''}`);
    res.status(502).json({ text: '' });
  }
});

app.listen(PORT, () => console.log(`[api] prêt sur :${PORT} — voix : ${VOICE_URL} — LLM : ${OLLAMA_URL ? `${OLLAMA_MODEL} @ ${OLLAMA_URL}, ${LLM_TIMEOUT_S} s max` : 'désactivé'}`));
