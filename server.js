const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = path.join(__dirname, 'p');
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.BUFFER_TOKEN || '';
const BASE = process.env.MEDIA_BASE || 'https://poetic-kindness-production-bb85.up.railway.app';
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '9', 10);
const HORIZON_DAYS = parseInt(process.env.HORIZON_DAYS || '45', 10);

const calendar = JSON.parse(fs.readFileSync(path.join(__dirname, 'calendar.json'), 'utf8'));
const log = [];
function note(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  log.push(line); if (log.length > 300) log.shift();
  console.log(line);
}

function api(method, urlPath, form) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const sep = urlPath.includes('?') ? '&' : '?';
    const req = https.request({
      hostname: 'api.bufferapp.com',
      path: '/1' + urlPath + sep + 'access_token=' + encodeURIComponent(TOKEN),
      method,
      headers: body
        ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getProfiles() {
  const r = await api('GET', '/profiles.json');
  if (!Array.isArray(r.body)) throw new Error('profiles: ' + JSON.stringify(r.body).slice(0, 200));
  return r.body;
}

async function pendingTexts(profileId) {
  const r = await api('GET', '/profiles/' + profileId + '/updates/pending.json?count=100');
  const updates = (r.body && r.body.updates) || [];
  return { count: updates.length, texts: updates.map(u => (u.text || '').trim()) };
}

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

async function runOnce() {
  if (!TOKEN) { note('BUFFER_TOKEN manquant — programmation ignorée'); return { skipped: true }; }
  const profiles = await getProfiles();
  const targets = profiles.filter(p => ['instagram', 'linkedin'].includes(p.service));
  note('canaux: ' + targets.map(p => p.service + ':' + p.id).join(', '));
  const now = Date.now();
  const horizon = now + HORIZON_DAYS * 86400000;
  const created = [];

  for (const p of targets) {
    const { count, texts } = await pendingTexts(p.id);
    let slots = MAX_QUEUE - count;
    note(p.service + ': ' + count + ' en file, ' + Math.max(slots, 0) + ' créneau(x)');
    const seen = new Set(texts.map(norm));
    for (const item of calendar) {
      if (slots <= 0) break;
      const t = new Date(item.at).getTime();
      if (t <= now || t > horizon) continue;
      const text = p.service === 'linkedin' ? item.li : item.ig;
      if (seen.has(norm(text))) continue;
      const form = {
        text,
        'profile_ids[]': p.id,
        scheduled_at: Math.floor(t / 1000),
        'media[photo]': BASE + '/p/' + item.img + '.jpg',
        'media[thumbnail]': BASE + '/p/' + item.img + '.jpg'
      };
      const r = await api('POST', '/updates/create.json', form);
      if (r.body && r.body.success) {
        created.push(p.service + ' ' + item.at + ' /p/' + item.img);
        seen.add(norm(text));
        slots--;
        note('créé ' + p.service + ' ' + item.at + ' img ' + item.img);
      } else {
        note('échec ' + p.service + ' ' + item.at + ' → ' + JSON.stringify(r.body).slice(0, 200));
        break;
      }
    }
  }
  return { created };
}

let last = { at: null, result: null, error: null };
async function tick(reason) {
  note('tick (' + reason + ')');
  try { last = { at: new Date().toISOString(), result: await runOnce(), error: null }; }
  catch (e) { last = { at: new Date().toISOString(), result: null, error: String(e.message || e) }; note('erreur ' + e.message); }
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const m = url.match(/^\/p\/(\d{2})\.jpg$/);
  if (m) {
    fs.readFile(path.join(DIR, m[1] + '.jpg'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
    return;
  }
  if (url === '/run') {
    tick('manuel').then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(last, null, 1));
    });
    return;
  }
  if (url === '/status') {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).sort(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      images: files.length, calendar: calendar.length,
      tokenSet: !!TOKEN, last, log: log.slice(-60)
    }, null, 1));
  }
  if (url === '/' || url === '/index.html') {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).sort(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Viva Viager media + scheduler</h1><p><a href="/status">/status</a> · <a href="/run">/run</a></p><ul>' +
      files.map(f => `<li><a href="/p/${f}">/p/${f}</a></li>`).join('') + '</ul>');
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  note('serveur démarré sur ' + PORT + ' — ' + calendar.length + ' posts au calendrier');
  setTimeout(() => tick('démarrage'), 5000);
  setInterval(() => tick('périodique'), 6 * 3600 * 1000);
});
