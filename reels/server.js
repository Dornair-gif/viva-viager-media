// viva-reels : voix ElevenLabs + montage ffmpeg pour les reels VIVA VIAGER.
// Ne publie rien. Aucun envoi vers Buffer. Tout passe par une validation humaine.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || '/data';
const TOKEN = process.env.ADMIN_TOKEN || '';
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf';
const RED = '0xF13F14';
const NAVY = '0x1D3746';
const STUDIO = fs.readFileSync(path.join(HERE, 'studio.html'), 'utf8');

const CLIPS = path.join(DATA, 'clips');
const THUMBS = path.join(DATA, 'thumbs');
const REELS = path.join(DATA, 'reels');
for (const d of [CLIPS, THUMBS, REELS]) fs.mkdirSync(d, { recursive: true });

// ---------- utilitaires ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
async function readBody(req, max = 2_000_000) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > max) throw new Error('corps trop grand'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
function authed(req) {
  if (!TOKEN) return false;
  const got = Buffer.from(String(req.headers['x-token'] || ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const safeId = (s) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(s || '');
function safeClipName(s) {
  const base = path.basename(String(s || '')).replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.(mp4|mov|m4v|webm)$/i.test(base) && base.length < 120 ? base : null;
}
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(() => fn()); chain = p.catch(() => {}); return p; };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} a échoué (${code}) : ${err.slice(-800)}`)));
  });
}
const ff = (args) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
async function probeDur(file) {
  const o = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = parseFloat(o);
  if (!(d > 0)) throw new Error('durée illisible : ' + path.basename(file));
  return d;
}

// ---------- reels (métadonnées) ----------
const reelDir = (id) => path.join(REELS, id);
const metaFile = (id) => path.join(reelDir(id), 'meta.json');
async function readMeta(id) {
  try { return JSON.parse(await fsp.readFile(metaFile(id), 'utf8')); } catch { return null; }
}
async function writeMeta(m) {
  await fsp.mkdir(reelDir(m.id), { recursive: true });
  await fsp.writeFile(metaFile(m.id), JSON.stringify(m, null, 1));
}
const voiceHash = (m) => crypto.createHash('sha1').update((m.text || '') + '|' + (m.voiceId || EL_VOICE)).digest('hex');

// ---------- ElevenLabs ----------
async function listVoices() {
  if (!EL_KEY) throw new Error('ELEVENLABS_API_KEY non défini sur le service');
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': EL_KEY } });
  if (!r.ok) throw new Error('ElevenLabs voix : HTTP ' + r.status);
  const j = await r.json();
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {}, preview: v.preview_url || null }));
}
async function makeVoice(m) {
  if (!EL_KEY) throw new Error('ELEVENLABS_API_KEY non défini sur le service');
  const voice = m.voiceId || EL_VOICE;
  if (!voice) throw new Error('Aucune voix choisie (ELEVENLABS_VOICE_ID ou choix dans le studio)');
  if (!m.text || m.text.trim().length < 10) throw new Error('Texte trop court');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': EL_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: m.text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error('ElevenLabs voix off : HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const dir = reelDir(m.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'voice.mp3'), Buffer.from(j.audio_base64, 'base64'));
  await fsp.writeFile(path.join(dir, 'align.json'), JSON.stringify(j.alignment || j.normalized_alignment || null));
  m.voiceId = voice;
  m.voiceHash = voiceHash(m);
  m.status = 'voix';
  await writeMeta(m);
  return m;
}

// ---------- sous-titres ----------
function wrap(s, max) {
  const words = s.split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
function wordsFromAlignment(al, text, dur) {
  if (al && al.characters && al.character_start_times_seconds) {
    const words = []; let cur = null;
    al.characters.forEach((ch, i) => {
      const s = al.character_start_times_seconds[i], e = al.character_end_times_seconds[i];
      if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
      if (!cur) cur = { w: '', s, e };
      cur.w += ch; cur.e = e;
    });
    if (cur) words.push(cur);
    if (words.length) return words;
  }
  const ws = text.split(/\s+/).filter(Boolean);
  const total = ws.reduce((a, w) => a + w.length + 1, 0);
  let t = 0;
  return ws.map((w) => { const d = dur * (w.length + 1) / total; const o = { w, s: t, e: t + d }; t += d; return o; });
}
function chunkWords(words) {
  const chunks = []; let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 4 || /[.!?…:;]$/.test(w.w) || (cur.length >= 3 && /,$/.test(w.w))) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i, a) => ({
    text: c.map((x) => x.w).join(' '),
    s: c[0].s,
    e: i < a.length - 1 ? a[i + 1][0].s : c[c.length - 1].e + 0.4,
  }));
}

// ---------- montage ----------
let tfCount = 0;
async function textLines(tmp, lines, o) {
  // un drawtext par ligne, chacun centré, texte lu depuis un fichier (aucun échappement à gérer)
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const f = path.join(tmp, `t${tfCount++}.txt`);
    await fsp.writeFile(f, lines[i]);
    let p = `drawtext=fontfile=${FONT}:textfile=${f}:expansion=none:fontsize=${o.size}:fontcolor=${o.color || 'white'}:x=(w-text_w)/2:y=${o.y + i * o.lh}`;
    if (o.box) p += `:box=1:boxcolor=${o.box}:boxborderw=${o.pad || 24}`;
    else p += ':borderw=4:bordercolor=black@0.85';
    if (o.enable) p += `:enable='${o.enable}'`;
    parts.push(p);
  }
  return parts;
}

// Reel déjà monté (ex. export Claude Design muet) : on ajoute seulement la voix, sans texte ni carton.
async function renderVoiceOnly(m, clipName, voice, dA) {
  const dir = reelDir(m.id);
  const src = path.join(CLIPS, clipName);
  const dV = await probeDur(src);
  const total = Math.max(dV, dA + 0.4);
  const final = path.join(dir, 'final.mp4');
  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p` +
    (total > dV + 0.05 ? `,tpad=stop_mode=clone:stop_duration=${(total - dV).toFixed(3)}` : '');
  await ff(['-i', src, '-i', voice, '-map', '0:v', '-map', '1:a', '-vf', vf,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,apad,aresample=44100', '-ac', '2', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final]);
  m.status = 'monte';
  m.duration = Math.round((await probeDur(final)) * 10) / 10;
  m.renderedAt = new Date().toISOString();
  await writeMeta(m);
  return m;
}
async function render(m) {
  const dir = reelDir(m.id);
  const voice = path.join(dir, 'voice.mp3');
  if (!fs.existsSync(voice)) throw new Error("Générez d'abord la voix");
  if (m.voiceHash !== voiceHash(m)) throw new Error('Le texte ou la voix a changé : régénérez la voix');
  const clips = (m.clips || []).map(safeClipName).filter(Boolean);
  if (!clips.length) throw new Error('Choisissez au moins un clip');
  for (const c of clips) if (!fs.existsSync(path.join(CLIPS, c))) throw new Error('Clip introuvable : ' + c);
  const dur = await probeDur(voice);
  if (m.mode === 'voix-seule') return renderVoiceOnly(m, clips[0], voice, dur);
  const bodyLen = dur + 0.5;
  const per = bodyLen / clips.length;
  const tmp = path.join(dir, 'tmp');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const segs = [];
  for (let i = 0; i < clips.length; i++) {
    const seg = path.join(tmp, `seg${i}.mp4`);
    await ff(['-stream_loop', '-1', '-i', path.join(CLIPS, clips[i]), '-t', per.toFixed(3), '-an',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', seg]);
    segs.push(seg);
  }
  await fsp.writeFile(path.join(tmp, 'list.txt'), segs.map((s) => `file '${s}'`).join('\n'));
  const joined = path.join(tmp, 'joined.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-c', 'copy', joined]);

  let al = null;
  try { al = JSON.parse(await fsp.readFile(path.join(dir, 'align.json'), 'utf8')); } catch { /* repli proportionnel */ }
  const chunks = chunkWords(wordsFromAlignment(al, m.text, dur));
  const filters = ['drawbox=x=0:y=1080:w=1080:h=840:color=black@0.35:t=fill'];
  if (m.hook && m.hook.trim()) {
    filters.push(...await textLines(tmp, wrap(m.hook.trim(), 20), { size: 78, y: 250, lh: 110, box: `${RED}@0.92`, pad: 26, enable: 'between(t,0,4)' }));
  }
  for (const c of chunks) {
    const en = `between(t,${c.s.toFixed(2)},${c.e.toFixed(2)})`;
    filters.push(...await textLines(tmp, wrap(c.text, 22).slice(0, 3), { size: 66, y: 1240, lh: 84, enable: en }));
  }
  await fsp.writeFile(path.join(tmp, 'overlay.txt'), filters.join(',\n'));
  const body = path.join(tmp, 'body.mp4');
  await ff(['-i', joined, '-i', voice, '-filter_script:v', path.join(tmp, 'overlay.txt'),
    '-map', '0:v', '-map', '1:a', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,apad,aresample=44100', '-ac', '2',
    '-t', bodyLen.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', body]);

  const cta = (m.cta || 'Rendez-vous gratuit').slice(0, 60);
  const endFilters = [
    ...await textLines(tmp, ['VIVA VIAGER'], { size: 120, y: 760, lh: 0, color: RED, box: undefined, enable: undefined }),
    ...await textLines(tmp, wrap(cta, 18), { size: 72, y: 960, lh: 100, color: 'white' }),
    ...await textLines(tmp, ['vivaviager.com'], { size: 54, y: 1240, lh: 0, color: 'white' }),
  ];
  const end = path.join(tmp, 'end.mp4');
  await ff(['-f', 'lavfi', '-i', `color=c=${NAVY}:s=1080x1920:r=30:d=2.5`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '2.5', '-vf', endFilters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', end]);

  const final = path.join(dir, 'final.mp4');
  await ff(['-i', body, '-i', end, '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final]);
  await fsp.rm(tmp, { recursive: true, force: true });
  m.status = 'monte';
  m.duration = Math.round((await probeDur(final)) * 10) / 10;
  m.renderedAt = new Date().toISOString();
  await writeMeta(m);
  return m;
}

// ---------- HTTP ----------
function sendFile(req, res, file, type) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'fichier absent' });
  const st = fs.statSync(file);
  const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (rg) {
    const s = rg[1] ? Number(rg[1]) : 0;
    const e = rg[2] ? Math.min(Number(rg[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e}/${st.size}`, 'content-length': e - s + 1 });
    return fs.createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '/studio')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(STUDIO);
    }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'introuvable' });
    if (!TOKEN) return json(res, 503, { error: 'ADMIN_TOKEN non défini sur le service' });
    if (!authed(req)) return json(res, 401, { error: 'jeton invalide' });

    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, { elevenlabsKey: !!EL_KEY, defaultVoice: EL_VOICE || null });
    }
    if (req.method === 'GET' && p === '/api/voices') return json(res, 200, await listVoices());

    if (req.method === 'GET' && p === '/api/clips') {
      const names = (await fsp.readdir(CLIPS)).filter((n) => safeClipName(n));
      const out = [];
      for (const n of names) { const st = await fsp.stat(path.join(CLIPS, n)); out.push({ name: n, size: st.size }); }
      return json(res, 200, out.sort((a, b) => a.name.localeCompare(b.name)));
    }
    let mt;
    if ((mt = /^\/api\/clips\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
      const name = safeClipName(decodeURIComponent(mt[1]));
      if (!name) return json(res, 400, { error: 'nom ou format de clip refusé (mp4, mov, m4v, webm)' });
      const dest = path.join(CLIPS, name);
      await pipeline(req, fs.createWriteStream(dest + '.part'));
      await fsp.rename(dest + '.part', dest);
      try { await ff(['-ss', '1', '-i', dest, '-frames:v', '1', '-vf', 'scale=270:-1', path.join(THUMBS, name + '.jpg')]); }
      catch { await ff(['-i', dest, '-frames:v', '1', '-vf', 'scale=270:-1', path.join(THUMBS, name + '.jpg')]).catch(() => {}); }
      return json(res, 200, { ok: true, name });
    }
    if ((mt = /^\/api\/thumbs\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const name = safeClipName(decodeURIComponent(mt[1]));
      return name ? sendFile(req, res, path.join(THUMBS, name + '.jpg'), 'image/jpeg') : json(res, 400, { error: 'nom invalide' });
    }

    if (req.method === 'GET' && p === '/api/reels') {
      const out = [];
      for (const id of await fsp.readdir(REELS)) { const m = await readMeta(id); if (m) out.push(m); }
      return json(res, 200, out.sort((a, b) => (a.date || a.id).localeCompare(b.date || b.id)));
    }
    if ((mt = /^\/api\/reels\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
      const id = mt[1];
      if (!safeId(id)) return json(res, 400, { error: 'identifiant invalide (minuscules, chiffres, tirets)' });
      const b = JSON.parse(await readBody(req) || '{}');
      const old = (await readMeta(id)) || { id, status: 'brouillon', createdAt: new Date().toISOString() };
      const m = { ...old,
        hook: String(b.hook ?? old.hook ?? '').slice(0, 120),
        text: String(b.text ?? old.text ?? '').slice(0, 1500),
        cta: String(b.cta ?? old.cta ?? 'Rendez-vous gratuit').slice(0, 60),
        date: String(b.date ?? old.date ?? '').slice(0, 10),
        mode: (b.mode ?? old.mode) === 'voix-seule' ? 'voix-seule' : 'complet',
        voiceId: String(b.voiceId ?? old.voiceId ?? '').slice(0, 64),
        clips: Array.isArray(b.clips) ? b.clips.map(safeClipName).filter(Boolean).slice(0, 12) : (old.clips || []) };
      if (old.status !== 'brouillon' && (m.text !== old.text || m.voiceId !== old.voiceId)) m.status = 'brouillon';
      else if (old.status === 'valide' || old.status === 'monte') m.status = 'voix';
      await writeMeta(m);
      return json(res, 200, m);
    }
    if ((mt = /^\/api\/reels\/([^/]+)\/(voice|render|approve|video|audio)$/.exec(p))) {
      const [, id, act] = mt;
      if (!safeId(id)) return json(res, 400, { error: 'identifiant invalide' });
      const m = await readMeta(id);
      if (!m) return json(res, 404, { error: 'reel inconnu' });
      if (act === 'video' && req.method === 'GET') return sendFile(req, res, path.join(reelDir(id), 'final.mp4'), 'video/mp4');
      if (act === 'audio' && req.method === 'GET') return sendFile(req, res, path.join(reelDir(id), 'voice.mp3'), 'audio/mpeg');
      if (req.method !== 'POST') return json(res, 405, { error: 'méthode' });
      if (act === 'voice') return json(res, 200, await serial(() => makeVoice(m)));
      if (act === 'render') return json(res, 200, await serial(() => render(m)));
      if (act === 'approve') {
        if (m.status !== 'monte' && m.status !== 'valide') return json(res, 409, { error: 'montez le reel avant de le valider' });
        const b = JSON.parse(await readBody(req) || '{}');
        m.status = b.approved === false ? 'monte' : 'valide';
        await writeMeta(m);
        return json(res, 200, m);
      }
    }
    return json(res, 404, { error: 'introuvable' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, () => console.log('viva-reels sur le port ' + PORT));
