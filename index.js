const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

process.on('uncaughtException', (err) => console.error('⚠', err.message));
process.on('unhandledRejection', (err) => console.error('⚠', err && err.message ? err.message : err));

// ===== TELEGRAM CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YAHAN_APNA_TOKEN_DALO';
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || 'YAHAN_APNA_CHAT_ID_DALO';
let tgBot = null;

const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

let serverStartTime = Date.now();

// ===== SERVER PASSWORD =====
let serverPassword = process.env.SERVER_PASSWORD || null;
if (!serverPassword) {
  serverPassword = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  🔐 SERVER PASSWORD: ' + serverPassword + '          ║');
  console.log('║  Ise save karo — stop karne ke liye   ║');
  console.log('║  chahiye hoga                         ║');
  console.log('╚══════════════════════════════════════╝\n');
}

// ===== MULTIPLE SESSIONS =====
const sessions = new Map();

function createSessionState(sid) {
  return {
    id: String(sid),
    sock: null,
    isPaired: false,
    phone: null,
    pairingCode: null,
    isConnecting: false,
    pairingRequested: false,
    connectedAt: null,
    lastError: null,
    authDir: `auth_info_baileys_${sid}`,
    groupsCache: {},
    bulk: null,
    sessionStartedAt: Date.now(),
  };
}

function getSession(sid) {
  if (sid === undefined || sid === null) sid = '1';
  return sessions.get(String(sid));
}

function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function getAllSessionsInfo() {
  const out = [];
  sessions.forEach((s) => {
    out.push({
      id: s.id,
      phone: s.phone,
      phoneMasked: maskPhone(s.phone),
      paired: s.isPaired,
      connecting: s.isConnecting,
      code: s.isPaired ? null : s.pairingCode,
      connectedAt: s.connectedAt,
      error: s.lastError,
      groupCount: Object.keys(s.groupsCache).length,
      bulkRunning: s.bulk ? s.bulk.running : false,
      sessionStartedAt: s.sessionStartedAt || null,
      bulkStartedAt: s.bulk && s.bulk.running ? s.bulk.startedAt : null,
      bulkSent: s.bulk ? s.bulk.sent : 0,
      bulkFailed: s.bulk ? s.bulk.failed : 0,
      bulkCycle: s.bulk ? s.bulk.cycle : 0,
    });
  });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const logs = { list: [], id: 0 };

function pushLog(type, msg) {
  logs.list.push({ id: ++logs.id, ts: Date.now(), type, msg });
  if (logs.list.length > 500) logs.list.splice(0, logs.list.length - 500);
  const icons = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isSocketReady(sess) { return !!(sess && sess.sock && sess.isPaired); }

function parseMessagesFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const seen = new Set(); const out = [];
  content.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || seen.has(t)) return;
    seen.add(t); out.push(t);
  });
  return out;
}

function normalizeJid(tok) {
  const t = tok.trim();
  if (!t) return null;
  if (/@g\.us$/i.test(t)) return t;
  if (/@s\.whatsapp\.net$/i.test(t) || /@c\.us$/i.test(t)) return t;
  const digits = t.replace(/[^\d]/g, '');
  if (!digits || digits.length < 8 || digits.length > 15) return null;
  return digits + '@s.whatsapp.net';
}

function parseNumbers(raw) {
  if (!raw) return [];
  const out = []; const seen = new Set();
  String(raw).split(/[\r\n,;\s]+/).forEach((tok) => {
    const jid = normalizeJid(tok);
    if (!jid || seen.has(jid)) return;
    seen.add(jid);
    const label = jid.endsWith('@g.us') ? '[G] ' + jid : '[N] +' + jid.split('@')[0];
    out.push({ jid, label });
  });
  return out;
}

async function safeSend(sess, jid, text) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SEND_RETRY; attempt++) {
    try {
      if (!isSocketReady(sess)) throw new Error('socket not ready');
      await sess.sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (attempt < SEND_RETRY) { pushLog('warn', `Retry → ${jid}: ${e.message}`); await sleep(RETRY_WAIT_MS); }
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown' };
}

async function runWorker(sess) {
  const b = sess.bulk;
  if (!b || b.workerAlive) return;
  b.workerAlive = true;
  pushLog('info', `[S${sess.id}] Worker started`);
  try {
    while (!b.stopFlag) {
      if (!isSocketReady(sess)) { b.lastBeat = Date.now(); await sleep(3000); continue; }
      for (let mi = 0; mi < b.messages.length && !b.stopFlag; mi++) {
        const msg = b.messages[mi];
        b.msgIndex = mi; b.currentMessage = msg;
        for (let ti = 0; ti < b.targets.length && !b.stopFlag; ti++) {
          const t = b.targets[ti];
          b.targetIndex = ti; b.currentTarget = t.label; b.lastBeat = Date.now();
          if (!isSocketReady(sess)) { pushLog('warn', `[S${sess.id}] Socket unavailable`); break; }
          try {
            const res = await safeSend(sess, t.jid, msg);
            if (res.ok) { b.sent++; pushLog('ok', `[S${sess.id}] Cycle ${b.cycle + 1} | Msg ${mi + 1}/${b.messages.length} → ${t.label}`); }
            else { b.failed++; pushLog('err', `[S${sess.id}] Msg ${mi + 1} → ${t.label}: ${res.error}`); }
          } catch (e) { b.failed++; pushLog('err', `[S${sess.id}] Error → ${t.label}: ${e.message}`); }
          b.remaining = b.messages.length - (mi + 1);
          if (!b.stopFlag) await sleep(b.delayMs);
        }
        if (!isSocketReady(sess) && !b.stopFlag) break;
      }
      if (!b.stopFlag) {
        b.cycle++; b.remaining = b.messages.length; b.msgIndex = 0; b.targetIndex = 0;
        pushLog('info', `[S${sess.id}] Cycle ${b.cycle} completed — restarting`);
      }
    }
  } catch (loopErr) {
    pushLog('err', `[S${sess.id}] Worker crashed: ${loopErr.message}`);
    if (!b.stopFlag) { b.workerAlive = false; b.running = true; setTimeout(() => runWorker(sess), 3000); return; }
  } finally {
    if (b.stopFlag) {
      b.running = false; b.stopFlag = false; b.workerAlive = false;
      b.currentMessage = ''; b.currentTarget = '';
      pushLog('info', `[S${sess.id}] Stopped — Sent: ${b.sent}, Failed: ${b.failed}, Cycles: ${b.cycle}`);
    } else b.workerAlive = false;
  }
}

setInterval(() => {
  sessions.forEach((sess) => {
    const b = sess.bulk;
    if (b && b.running && !b.workerAlive) { pushLog('warn', `[S${sess.id}] Watchdog restart`); runWorker(sess); }
  });
}, WATCHDOG_INTERVAL_MS);

async function connectSession(sid, phone) {
  let sess = getSession(sid);
  if (!sess) { sess = createSessionState(sid); sessions.set(String(sid), sess); }
  if (!phone) throw new Error('Phone required');
  if (sess.isConnecting) throw new Error('Already connecting');
  if (sess.isPaired) throw new Error('Already paired');
  sess.isConnecting = true; sess.phone = phone; sess.pairingCode = null; sess.lastError = null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sess.authDir);
    const { version } = await fetchLatestBaileysVersion();
    sess.sock = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      mobile: false, syncFullHistory: false,
    });
    sess.sock.ev.on('creds.update', saveCreds);
    sess.sock.ev.on('groups.upsert', (groups) => {
      groups.forEach((g) => { sess.groupsCache[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }; });
    });
    sess.sock.ev.on('groups.update', (updates) => {
      updates.forEach((u) => {
        if (sess.groupsCache[u.id]) { if (u.subject) sess.groupsCache[u.id].name = u.subject; }
        else if (u.id) sess.groupsCache[u.id] = { id: u.id, name: u.subject || '', size: 0 };
      });
    });
    sess.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting' && !sess.sock.authState.creds.registered && !sess.pairingRequested) {
        sess.pairingRequested = true;
        try {
          await sleep(1000);
          sess.pairingCode = await sess.sock.requestPairingCode(phone);
          console.log(`\n📱 [S${sess.id}] PAIRING CODE for ${phone}: ${sess.pairingCode}\n`);
          pushLog('info', `[S${sess.id}] Pairing code: ${sess.pairingCode}`);
          if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
            try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `📱 *Pairing Code [Session ${sess.id}]*\n\nNumber: \`${phone}\`\nCode: \`${sess.pairingCode}\``, { parse_mode: 'Markdown' }); } catch (_) {}
          }
          sess.lastError = null;
        } catch (err) {
          sess.lastError = err.message; sess.pairingCode = null;
          sess.pairingRequested = false; sess.isConnecting = false;
        }
      }
      if (connection === 'open') {
        sess.isPaired = true; sess.pairingCode = null;
        sess.pairingRequested = false; sess.isConnecting = false;
        sess.connectedAt = new Date().toISOString(); sess.lastError = null;
        pushLog('ok', `[S${sess.id}] WhatsApp connected (${phone})`);
        if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
          try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `✅ *Connected [Session ${sess.id}]*\n\nNumber: \`${phone}\``, { parse_mode: 'Markdown' }); } catch (_) {}
        }
        setTimeout(() => {
          try {
            if (sess.sock && sess.sock.store && sess.sock.store.groupMetadata) {
              sess.sock.store.groupMetadata.forEach((v) => {
                sess.groupsCache[v.id] = { id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 };
              });
              pushLog('info', `[S${sess.id}] Loaded ${Object.keys(sess.groupsCache).length} groups`);
            }
          } catch (_) {}
        }, 3000);
        if (sess.bulk && sess.bulk.running && !sess.bulk.workerAlive) { runWorker(sess); }
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        pushLog('warn', `[S${sess.id}] Connection closed (${statusCode})`);
        sess.isPaired = false; sess.isConnecting = false;
        if (shouldReconnect && sess.phone) {
          sess.pairingRequested = false;
          setTimeout(() => connectSession(sess.id, sess.phone).catch(console.error), 3000);
        } else if (statusCode === DisconnectReason.loggedOut) {
          sess.pairingCode = null; sess.pairingRequested = false; sess.phone = null;
          if (sess.bulk && sess.bulk.running) { sess.bulk.stopFlag = true; }
        }
      }
    });
  } catch (err) {
    sess.isConnecting = false; sess.lastError = err.message; throw err;
  }
}

// ===== AUTO LOAD SESSIONS =====
async function autoLoadSessions() {
  try {
    const dirs = fs.readdirSync(__dirname).filter(d => d.startsWith('auth_info_baileys_'));
    if (!dirs.length) { console.log('📂 No saved sessions found'); return; }
    console.log(`📂 Found ${dirs.length} saved session(s) — auto connecting...`);
    for (const dir of dirs) {
      const sid = dir.replace('auth_info_baileys_', '');
      const credsFile = path.join(__dirname, dir, 'creds.json');
      if (!fs.existsSync(credsFile)) continue;
      let creds = {};
      try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (_) {}
      const phone = creds.me && creds.me.id ? creds.me.id.split(':')[0].split('@')[0] : null;
      let sess = getSession(sid);
      if (!sess) { sess = createSessionState(sid); sessions.set(sid, sess); }
      sess.phone = phone;
      pushLog('info', `🔄 Auto-loading Session ${sid}${phone ? ' (' + phone + ')' : ''}...`);
      connectSession(sid, phone).catch((e) => { pushLog('err', `[S${sid}] Auto-load failed: ${e.message}`); });
      await sleep(1500);
    }
  } catch (e) { console.error('Auto-load error:', e.message); }
}

// ============================================================
// EMBEDDED HTML — RED THEME
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>RK RAJA XWD</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#050507;color:#e2e8f0;min-height:100vh;overflow-x:hidden;position:relative}
  body::before{content:"";position:fixed;inset:-50px;z-index:-3;background-image:url('__LOGO_DATA__');background-size:cover;background-position:center center;background-repeat:no-repeat;filter:blur(10px) brightness(0.4);opacity:0.55}
  body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(1200px 800px at 15% 10%, rgba(255,0,60,.18), transparent 60%),radial-gradient(900px 600px at 85% 90%, rgba(255,0,60,.14), transparent 65%),linear-gradient(135deg, rgba(5,5,10,.75) 0%, rgba(11,11,18,.6) 55%, rgba(5,5,10,.75) 100%);pointer-events:none}
  .streaks{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
  .streaks span{position:absolute;height:1px;width:220px;left:-30%;background:linear-gradient(90deg,transparent,#ff003c,transparent);filter:drop-shadow(0 0 6px #ff003c);opacity:.55;animation:streak 7s linear infinite}
  .streaks span:nth-child(2){top:25%;animation-delay:1.5s;animation-duration:9s}
  .streaks span:nth-child(3){top:55%;animation-delay:3s;animation-duration:8s}
  .streaks span:nth-child(4){top:78%;animation-delay:4.5s;animation-duration:10s}
  @keyframes streak{from{transform:translateX(0) rotate(-12deg)}to{transform:translateX(160vw) rotate(-12deg)}}
  .container{max-width:1180px;margin:0 auto;padding:28px 18px 60px;position:relative;z-index:1}
  .brand{text-align:center;margin-bottom:26px}
  .brand h1{font-size:clamp(22px,4vw,40px);font-weight:900;letter-spacing:4px;background:linear-gradient(180deg,#ffffff 0%,#c9c9d6 45%,#ff003c 130%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 26px rgba(255,0,60,.45);font-family:"Orbitron","Rajdhani",sans-serif;text-transform:uppercase}
  .brand h1 .x{color:#ff003c;-webkit-text-fill-color:#ff003c;text-shadow:0 0 18px #ff003c}
  .brand p{color:#8b8b9c;font-size:11px;letter-spacing:3px;margin-top:6px;text-transform:uppercase}
  .tabs{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;justify-content:center}
  .tab{padding:11px 20px;border-radius:12px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,0,60,.35);background:rgba(255,0,60,.05);color:#ff5277;transition:.2s}
  .tab.active{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border-color:#ff003c;box-shadow:0 8px 24px rgba(255,0,60,.35)}
  .tab:hover:not(.active){background:rgba(255,0,60,.12)}
  .panel{display:none}.panel.active{display:block}
  .layout{display:grid;grid-template-columns:420px 1fr;gap:20px}
  @media(max-width:900px){.layout{grid-template-columns:1fr}}
  .card{position:relative;background:linear-gradient(155deg, rgba(20,20,28,.85), rgba(10,10,15,.7));border:1px solid rgba(255,0,60,.28);border-radius:18px;padding:24px;margin-bottom:20px;backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)}
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase}
  .card h2 .dot{width:8px;height:8px;border-radius:50%;background:#ff003c;box-shadow:0 0 12px #ff003c}
  label{display:block;font-size:11px;color:#9a9aab;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:rgba(5,5,10,.75);border:1px solid rgba(255,0,60,.25);border-radius:12px;padding:12px 14px;color:#f1f1f6;font-size:14px;font-family:inherit;outline:none;transition:.25s}
  input:focus,textarea:focus,select:focus{border-color:#ff003c;box-shadow:0 0 0 3px rgba(255,0,60,.14)}
  input:disabled{color:#6b6b7a}
  textarea{resize:vertical;min-height:80px}
  .field{margin-bottom:14px}
  button{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:.22s;margin-top:6px;width:100%;box-shadow:0 8px 24px rgba(255,0,60,.28)}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 30px rgba(255,0,60,.45)}
  button:disabled{background:#2a2a34;color:#6b6b7a;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid rgba(255,0,60,.5);color:#ff5277;box-shadow:none}
  button.ghost:hover:not(:disabled){background:rgba(255,0,60,.1)}
  button.danger{background:linear-gradient(180deg,#ff0040,#a80028);color:#fff;border:1px solid #ff003c}
  .btnrow{display:flex;gap:10px}.btnrow button{margin-top:0}
  .msg{margin-top:14px;padding:12px 15px;border-radius:10px;font-size:13px;display:none}
  .msg.ok{background:rgba(255,0,60,.1);color:#ff8ba6;border:1px solid rgba(255,0,60,.4);display:block}
  .msg.err{background:rgba(255,60,60,.1);color:#ffa1a1;border:1px solid rgba(255,60,60,.4);display:block}
  .code-box{background:rgba(5,5,10,.85);border:2px dashed #ff003c;border-radius:16px;padding:20px;margin:14px 0;text-align:center}
  .code-value{font-size:32px;font-weight:900;letter-spacing:8px;color:#ff003c;font-family:'Courier New',monospace;text-shadow:0 0 24px rgba(255,0,60,.7)}
  .code-label{font-size:11px;color:#8b8b9c;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase}
  .steps{background:rgba(5,5,10,.6);border:1px solid rgba(255,0,60,.18);border-radius:12px;padding:14px;font-size:12px;line-height:1.8;color:#c3c3d1}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:520px){.grid2{grid-template-columns:1fr}}
  .stat{background:rgba(5,5,10,.7);border:1px solid rgba(255,0,60,.2);border-radius:14px;padding:14px;text-align:center}
  .stat .k{font-size:10px;color:#8b8b9c;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .stat .v{font-size:20px;font-weight:900;color:#fff;word-break:break-all}
  .stat .v.red{color:#ff003c}
  .stat .v.green{color:#38ef7d}
  .stat .v.small{font-size:14px;font-weight:700}
  .statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
  @media(max-width:520px){.statgrid{grid-template-columns:1fr 1fr}}
  .log{background:#000;border:1px solid rgba(255,0,60,.25);border-radius:1
