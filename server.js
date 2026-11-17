// Halay TikTok Canlı Yayın Overlay Sunucusu
// - TikTok yayınına OTOMATİK bağlanır (yayın kapalıysa bekler, açılınca bağlanır, düşerse yeniden bağlanır)
// - Birisi yayına girince / "halay" yazınca => isimli halaycı gelir
// - Gül (Rose) hediyesi gelince => her gül için 5 halaycı gelir
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Ayarlar (hepsi ortam değişkeni ile değiştirilebilir) ----------
const USERNAME = (process.env.TIKTOK_USERNAME || 'Jhonduranbaba3').replace(/^@/, '').trim();
const PORT = Number(process.env.PORT || 3000);
const ROSE_DANCERS = Number(process.env.ROSE_DANCERS || 5);          // 1 gül = kaç kişi
const MAX_BATCH = Number(process.env.MAX_BATCH || 40);                // tek seferde en fazla kişi
const JOIN_COOLDOWN_MS = Number(process.env.JOIN_COOLDOWN_MIN || 10) * 60_000; // aynı kişi tekrar girerse
const RETRY_MS = Number(process.env.RETRY_SECONDS || 30) * 1000;      // yayın kapalıyken tekrar deneme
const CHAT_KEYWORD = (process.env.CHAT_KEYWORD || 'halay').toLowerCase(); // yazınca halaya katılır ('' = kapalı)
const ADMIN_KEY = process.env.ADMIN_KEY || '';                        // test linkini korumak için (opsiyonel)
const ROSE_NAMES = ['rose', 'gül', 'gul'];
const ROSE_GIFT_ID = 5655;

if (process.env.SIGN_API_KEY) SignConfig.apiKey = process.env.SIGN_API_KEY; // Euler Stream anahtarı (opsiyonel)

// ---------- Web sunucu ----------
const app = express();
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let status = { state: USERNAME ? 'starting' : 'no-username', username: USERNAME, text: '' };
const recentJoin = new Map(); // isim -> son giriş zamanı

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
function setStatus(state, text = '') {
  status = { state, username: USERNAME, text };
  console.log(`[durum] ${state} ${text}`);
  broadcast({ type: 'status', ...status });
}
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'status', ...status, config: { rose: ROSE_DANCERS } })));

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Misafir';

function joinDancer(name, source, force = false) {
  const key = clean(name).toLowerCase();
  const now = Date.now();
  if (!force && (source === 'member' || source === 'chat')) {
    const last = recentJoin.get(key) || 0;
    if (now - last < JOIN_COOLDOWN_MS) return;
    recentJoin.set(key, now);
    if (recentJoin.size > 5000) recentJoin.clear();
  }
  broadcast({ type: 'join', name: clean(name), source });
}

function roseDancers(name, rosesCount) {
  const n = Math.min(MAX_BATCH, ROSE_DANCERS * Math.max(1, rosesCount));
  console.log(`[gül] ${name} x${rosesCount} => ${n} halaycı`);
  broadcast({ type: 'rose', name: clean(name), roses: rosesCount, dancers: n });
}

// Test / simülasyon: /api/simulate?type=member|rose|chat&name=Ali&count=2&key=ADMIN_KEY
app.get('/api/simulate', (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false });
  const name = clean(req.query.name || 'Test');
  const type = String(req.query.type || 'member');
  if (type === 'rose') roseDancers(name, Math.min(10, Number(req.query.count) || 1));
  else joinDancer(name, type, true);
  res.json({ ok: true });
});
app.get('/api/status', (_req, res) => res.json({ ...status, clients: wss.clients.size }));

server.listen(PORT, () => {
  console.log(`Halay sitesi hazır: http://localhost:${PORT}`);
  if (!USERNAME) console.log('UYARI: TIKTOK_USERNAME ayarlanmadı. Sadece test modu çalışır.');
});

// ---------- TikTok bağlantı döngüsü (tamamen otomatik) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectOnce() {
  const conn = new TikTokLiveConnection(USERNAME, { processInitialData: false });
  let closed;
  const closedPromise = new Promise((r) => (closed = r));

  conn.on(WebcastEvent.MEMBER, (d) => {
    const name = d.user?.nickname || d.user?.uniqueId;
    if (name) joinDancer(name, 'member');
  });

  conn.on(WebcastEvent.CHAT, (d) => {
    if (!CHAT_KEYWORD) return;
    if (String(d.comment || '').toLowerCase().includes(CHAT_KEYWORD)) {
      const name = d.user?.nickname || d.user?.uniqueId;
      if (name) joinDancer(name, 'chat');
    }
  });

  conn.on(WebcastEvent.GIFT, (d) => {
    const giftName = String(d.giftDetails?.giftName || '').toLowerCase();
    const isRose = ROSE_NAMES.includes(giftName) || Number(d.giftId) === ROSE_GIFT_ID;
    if (!isRose) return;
    if (d.giftDetails?.giftType === 1 && !d.repeatEnd) return; // seri sürüyor, bitince say
    const name = d.user?.nickname || d.user?.uniqueId || 'Gül Atan';
    roseDancers(name, Number(d.repeatCount) || 1);
  });

  conn.on(WebcastEvent.STREAM_END, () => setStatus('ended', 'Yayın bitti'));
  conn.on(ControlEvent.DISCONNECTED, () => closed());
  conn.on(ControlEvent.ERROR, (e) => console.log('[hata]', e?.info || e?.message || e));

  await conn.connect();
  setStatus('live', `@${USERNAME} yayınına bağlandı`);
  await closedPromise;
}

async function main() {
  if (!USERNAME) return;
  for (;;) {
    try {
      setStatus('waiting', `@${USERNAME} yayını aranıyor...`);
      await connectOnce();
      setStatus('waiting', 'Bağlantı koptu, yeniden deneniyor...');
    } catch (err) {
      const offline = err?.name === 'UserOfflineError' || /offline|not live/i.test(String(err?.message));
      setStatus('waiting', offline ? `@${USERNAME} şu an yayında değil, bekleniyor` : `Bağlanamadı: ${err?.message || err}`);
    }
    await sleep(RETRY_MS);
  }
}
process.on('unhandledRejection', (e) => console.log('[unhandled]', e?.message || e));
main();
