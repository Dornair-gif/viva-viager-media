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
const logLines = [];
function note(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  logLines.push(line); if (logLines.length > 400) logLines.shift();
  console.log(line);
}

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.buffer.com',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('réponse illisible: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function gqlErr(r) {
  if (r && r.errors && r.errors.length) return r.errors.map(e => e.message).join(' | ');
  return null;
}

async function getContext() {
  const r = await gql(`query { account { organizations { id name channels { id service } } } }`);
  const err = gqlErr(r);
  if (err) throw new Error('account: ' + err);
  const orgs = (r.data && r.data.account && r.data.account.organizations) || [];
  const org = orgs.find(o => (o.channels || []).some(c => ['instagram', 'linkedin'].includes(c.service))) || orgs[0];
  if (!org) throw new Error('aucune organisation');
  const channels = (org.channels || []).filter(c => ['instagram', 'linkedin'].includes(c.service));
  return { orgId: org.id, orgName: org.name, channels };
}

async function scheduledFor(orgId, channelId) {
  const r = await gql(`query { posts(input: {organizationId: ${JSON.stringify(orgId)}, filter: {status: [scheduled], channelIds: [${JSON.stringify(channelId)}]}, sort: [{field: dueAt, direction: asc}]}) { edges { node { id text } } } }`);
  const err = gqlErr(r);
  if (err) throw new Error('posts: ' + err);
  const edges = (r.data && r.data.posts && r.data.posts.edges) || [];
  return edges.map(e => (e.node && e.node.text) || '');
}

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

function createMutation(orgId, channelId, text, dueAt, imgUrl, withMeta) {
  const meta = withMeta ? `, metadata: {instagram: {type: post, shouldShareToFeed: true}}` : '';
  return `mutation { createPost(input: {
    organizationId: ${JSON.stringify(orgId)}
    channelId: ${JSON.stringify(channelId)}
    text: ${JSON.stringify(text)}
    mode: customScheduled
    dueAt: ${JSON.stringify(dueAt)}
    schedulingType: automatic
    assets: [{image: {url: ${JSON.stringify(imgUrl)}}}]${meta}
  }) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`;
}

async function createPost(orgId, ch, text, dueAt, imgUrl) {
  const isIg = ch.service === 'instagram';
  let r = await gql(createMutation(orgId, ch.id, text, dueAt, imgUrl, isIg));
  let err = gqlErr(r) || (r.data && r.data.createPost && r.data.createPost.message);
  if (err && isIg && /metadata|instagram|type/i.test(err)) {
    note('métadonnées IG refusées, nouvel essai sans → ' + err.slice(0, 120));
    r = await gql(createMutation(orgId, ch.id, text, dueAt, imgUrl, false));
    err = gqlErr(r) || (r.data && r.data.createPost && r.data.createPost.message);
  }
  if (err) return { ok: false, error: err };
  const post = r.data && r.data.createPost && r.data.createPost.post;
  return { ok: !!post, id: post && post.id, error: post ? null : 'réponse inattendue' };
}

async function runOnce() {
  if (!TOKEN) { note('BUFFER_TOKEN manquant'); return { skipped: true }; }
  const { orgId, orgName, channels } = await getContext();
  note('organisation ' + orgName + ' — canaux: ' + channels.map(c => c.service).join(', '));
  const now = Date.now();
  const horizon = now + HORIZON_DAYS * 86400000;
  const created = [];

  for (const ch of channels) {
    const texts = await scheduledFor(orgId, ch.id);
    let slots = MAX_QUEUE - texts.length;
    note(ch.service + ': ' + texts.length + ' programmé(s), ' + Math.max(slots, 0) + ' créneau(x)');
    const seen = new Set(texts.map(norm));
    for (const item of calendar) {
      if (slots <= 0) break;
      const t = new Date(item.at).getTime();
      if (t <= now || t > horizon) continue;
      const text = ch.service === 'linkedin' ? item.li : item.ig;
      if (seen.has(norm(text))) continue;
      const res = await createPost(orgId, ch, text, item.at, BASE + '/p/' + item.img + '.jpg');
      if (res.ok) {
        created.push(ch.service + ' ' + item.at + ' /p/' + item.img);
        seen.add(norm(text)); slots--;
        note('créé ' + ch.service + ' ' + item.at + ' img ' + item.img);
      } else {
        note('échec ' + ch.service + ' ' + item.at + ' → ' + String(res.error).slice(0, 200));
        break;
      }
    }
  }
  return { created, count: created.length };
}

let last = { at: null, result: null, error: null };
let running = false;
async function tick(reason) {
  if (running) { note('tick ignoré (déjà en cours)'); return; }
  running = true;
  note('tick (' + reason + ')');
  try { last = { at: new Date().toISOString(), result: await runOnce(), error: null }; }
  catch (e) { last = { at: new Date().toISOString(), result: null, error: String(e.message || e) }; note('erreur ' + e.message); }
  running = false;
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(last, null, 1));
    });
    return;
  }
  if (url === '/status') {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).sort(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      images: files.length, calendar: calendar.length, tokenSet: !!TOKEN,
      last, log: logLines.slice(-80)
    }, null, 1));
  }
  if (url === '/' || url === '/index.html') {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).sort(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Viva Viager — media + scheduler</h1><p><a href="/status">/status</a> · <a href="/run">/run</a></p><ul>' +
      files.map(f => `<li><a href="/p/${f}">/p/${f}</a></li>`).join('') + '</ul>');
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  note('serveur démarré sur ' + PORT + ' — ' + calendar.length + ' posts au calendrier');
  setTimeout(() => tick('démarrage'), 5000);
  setInterval(() => tick('périodique'), 6 * 3600 * 1000);
});
