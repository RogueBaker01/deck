const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');
const events = new EventEmitter();

let pty = null;
try {
  pty = require('node-pty');
} catch {
  // shortcut: fallback to child_process pipe if node-pty native addon isn't built yet
}

const PORT = Number(process.env.DECK_PORT || 4777);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGY_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const STATE_FILE = path.join(__dirname, '.deck-state.json');

const GROUPS = {
  isolated: { id: 'isolated', label: 'Aislado', color: '#52525b' },
  A: { id: 'A', label: 'Grupo A', color: '#10b981' },
  B: { id: 'B', label: 'Grupo B', color: '#f59e0b' },
  C: { id: 'C', label: 'Grupo C', color: '#a855f7' },
  D: { id: 'D', label: 'Grupo D', color: '#f43f5e' }
};

const panes = new Map();
const clients = new Set();
let nextNum = 1;

function slugify(str) {
  return String(str || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 800 })
      .toString().trim();
  } catch {
    return '';
  }
}

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/[\r\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function detectAttention(cleanText) {
  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const waits = /(\[y\/n\]|\(y\/n\)|yes\/no|confirm|allow|approve|waiting for|press enter|\?\s*$|>\s*$)/i.test(last);
  return { lastLine: last.slice(0, 140), needsAttention: waits };
}

function scanAntigravitySubagents() {
  const brainDir = path.join(AGY_DIR, 'brain');
  const results = [];
  if (!fs.existsSync(brainDir)) return results;
  try {
    const convs = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const tPath = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        let mtime = 0;
        try { mtime = fs.statSync(tPath).mtimeMs; } catch {}
        return { id: d.name, tPath, mtime };
      })
      .filter(c => c.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 8);

    for (const c of convs) {
      const content = fs.readFileSync(c.tPath, 'utf8');
      const subagents = [];
      const regex = /"invoke_subagent"[^}]*"Role"\s*:\s*"([^"]+)"/g;
      let m;
      while ((m = regex.exec(content)) !== null) {
        if (!subagents.includes(m[1])) subagents.push(m[1]);
      }
      results.push({ conversationId: c.id, mtime: c.mtime, subagents: subagents.slice(-5) });
    }
  } catch {}
  return results;
}

function notifyWindows(title, message, kind = 'done') {
  if (process.env.DECK_NO_NOTIFY === '1') return;
  const safeTitle = String(title || '/deck').replace(/'/g, "''").slice(0, 60);
  const safeMsg = String(message || 'Tarea finalizada').replace(/'/g, "''").slice(0, 140);
  const beepCmd = kind === 'waiting'
    ? '[console]::beep(660, 160); [console]::beep(990, 240)'
    : '[console]::beep(880, 140); [console]::beep(1175, 240)';
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '[System.Media.SystemSounds]::Exclamation.Play()',
    beepCmd,
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(4000, '${safeTitle}', '${safeMsg}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    '[System.Windows.Forms.Application]::DoEvents()',
    'Start-Sleep -Milliseconds 4200',
    '$n.Dispose()'
  ].join('; ');
  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
  } catch {}
}

function serializePane(p) {
  return {
    id: p.id,
    num: p.num,
    role: p.role,
    slug: slugify(p.role),
    cwd: p.cwd,
    branch: p.branch,
    group: GROUPS[p.group] ? p.group : 'isolated',
    groupMeta: GROUPS[p.group] || GROUPS.isolated,
    status: p.status,
    attention: p.attention,
    done: Boolean(p.done),
    remoteControl: p.remoteControl,
    lastLine: p.lastLine,
    subagents: p.subagents,
    queueLength: p.queue.length,
    createdAt: p.createdAt
  };
}

function broadcast(msg) {
  events.emit(msg.type, msg);
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function detectPaneConversationId(pane) {
  if (pane.conversationId) return pane.conversationId;
  const brainDir = path.join(AGY_DIR, 'brain');
  if (!fs.existsSync(brainDir)) return null;
  const used = new Set(Array.from(panes.values()).map(p => p.conversationId).filter(Boolean));
  try {
    const candidates = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !used.has(d.name))
      .map(d => {
        const dirPath = path.join(brainDir, d.name);
        const tPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
        let mtime = 0;
        try { mtime = fs.statSync(tPath).mtimeMs; } catch {}
        if (!mtime) { try { mtime = fs.statSync(dirPath).mtimeMs; } catch {} }
        return { id: d.name, mtime };
      })
      .filter(c => c.mtime >= pane.createdAt - 2000)
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length) {
      pane.conversationId = candidates[0].id;
      return pane.conversationId;
    }
  } catch {}
  return null;
}

function saveSessionState() {
  if (process.env.DECK_NO_STATE === '1') return;
  try {
    const snapshot = Array.from(panes.values()).map(p => {
      const wasAgy = Boolean(p.wasAgy || p.remoteControl || /Antigravity CLI/i.test(p.buffer));
      if (wasAgy && !p.conversationId) detectPaneConversationId(p);
      return {
        role: p.role,
        cwd: p.cwd,
        group: p.group,
        remoteControl: Boolean(p.remoteControl),
        wasAgy,
        conversationId: p.conversationId || null
      };
    });
    if (snapshot.length > 0) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: Date.now(), panes: snapshot }, null, 2));
    }
  } catch {}
}

function loadPreviousSession() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(data.panes) && data.panes.length > 0 ? data : null;
  } catch {
    return null;
  }
}

function restorePreviousSession(saved) {
  if (!saved || !Array.isArray(saved.panes) || !saved.panes.length) return 0;
  for (const existing of Array.from(panes.values())) {
    clearTimeout(existing.idleTimer);
    existing.kill();
    panes.delete(existing.id);
  }
  let usedContinue = false;
  for (const item of saved.panes) {
    const hasId = Boolean(item.conversationId);
    const shouldContinue = Boolean(item.wasAgy && !hasId && !usedContinue);
    if (shouldContinue) usedContinue = true;
    createPane({
      role: item.role,
      cwd: item.cwd,
      group: item.group || 'isolated',
      remoteControl: Boolean(item.remoteControl),
      autoAgy: Boolean(item.wasAgy),
      continueAgy: shouldContinue,
      conversationId: item.conversationId || null
    });
  }
  return saved.panes.length;
}

function broadcastState() {
  broadcast({
    type: 'state',
    groups: GROUPS,
    panes: Array.from(panes.values()).map(serializePane),
    agySessions: scanAntigravitySubagents()
  });
}

function findPane(target) {
  if (!target) return null;
  if (panes.has(target)) return panes.get(target);
  const tSlug = slugify(target);
  for (const p of panes.values()) {
    if (p.role.toLowerCase() === String(target).toLowerCase() || slugify(p.role) === tSlug || String(p.num) === String(target)) {
      return p;
    }
  }
  return null;
}

function formatDeckMessage(receiver, fromName, text) {
  const isAgy = Boolean(receiver.wasAgy || receiver.remoteControl || /Antigravity CLI/i.test(receiver.buffer));
  const grp = GROUPS[receiver.group]?.label || receiver.group;
  if (isAgy) {
    return /^\/btw\b/i.test(text) ? text : `/btw [DECK from ${fromName} (${grp})]: ${text}`;
  }
  return `# [DECK MSG from ${fromName} (${grp})]: ${text}`;
}

function flushQueue(pane) {
  if (!pane.queue.length || !pane.proc) return;
  const next = pane.queue.shift();
  const formatted = formatDeckMessage(pane, next.from, next.text);
  pane.write(`\r\n${formatted}\r\n`);
  broadcastState();
}

function createPane(opts = {}) {
  const num = nextNum++;
  const id = `pane-${num}`;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  const role = opts.role || path.basename(cwd) || `Agente ${num}`;
  const group = GROUPS[opts.group] ? opts.group : 'isolated';
  const remoteControl = Boolean(opts.remoteControl);
  const shell = process.env.COMSPEC || 'powershell.exe';
  const usePowershell = true;

  const env = {
    ...process.env,
    DECK_PORT: String(PORT),
    DECK_PANE_ID: id,
    DECK_ROLE: role,
    DECK_GROUP: group,
    PATH: `${path.join(__dirname, 'bin')}${path.delimiter}${process.env.PATH || ''}`
  };

  const pane = {
    id,
    num,
    role,
    cwd,
    branch: getGitBranch(cwd),
    group,
    status: 'Running',
    attention: false,
    done: false,
    outputBytes: 0,
    notified: false,
    remoteControl,
    wasAgy: Boolean(opts.autoAgy || remoteControl),
    conversationId: opts.conversationId || null,
    lastLine: 'Iniciando terminal...',
    subagents: Array.isArray(opts.subagents) ? opts.subagents : [],
    buffer: '',
    queue: [],
    createdAt: Date.now(),
    proc: null,
    idleTimer: null,
    write: () => {},
    resize: () => {},
    kill: () => {}
  };

  const onOutput = (raw) => {
    pane.buffer = (pane.buffer + raw).slice(-40000);
    pane.outputBytes += raw.length;
    pane.status = 'Running';
    pane.done = false;
    const clean = stripAnsi(raw);
    const det = detectAttention(clean);
    if (det && det.lastLine) {
      pane.lastLine = det.lastLine;
      if (det.needsAttention && !/^[A-Z]:\\.*>$/i.test(det.lastLine)) {
        pane.attention = true;
        pane.status = 'Waiting';
        if (!pane.notified) {
          pane.notified = true;
          events.emit('alert', { id: pane.id, kind: 'waiting' });
          notifyWindows(`/deck · ${pane.role}`, `Esperando confirmación: ${pane.lastLine}`, 'waiting');
        }
      }
    }
    const subMatch = clean.match(/(?:invoke_subagent|subagent|Subagent)\s*[:\-]?\s*([a-zA-Z0-9_-]+)/);
    if (subMatch && !pane.subagents.includes(subMatch[1])) {
      pane.subagents.push(subMatch[1]);
    }

    clearTimeout(pane.idleTimer);
    pane.idleTimer = setTimeout(() => {
      if (pane.status === 'Waiting') return;
      pane.status = 'Done';
      pane.done = true;
      pane.attention = false;
      if (pane.outputBytes > 250 && !pane.notified) {
        pane.notified = true;
        events.emit('alert', { id: pane.id, kind: 'done' });
        notifyWindows(`/deck · ${pane.role} terminó`, pane.lastLine || 'CLI listo para revisar', 'done');
      }
      flushQueue(pane);
      broadcastState();
    }, 3500);

    broadcast({ type: 'output', id: pane.id, data: raw });
    broadcastState();
  };

  if (pty) {
    const ptyProc = pty.spawn('powershell.exe', ['-NoLogo'], {
      name: 'xterm-256color',
      cols: opts.cols || 100,
      rows: opts.rows || 28,
      cwd,
      env
    });
    pane.proc = ptyProc;
    pane.write = (d) => ptyProc.write(d);
    pane.resize = (cols, rows) => {
      try { ptyProc.resize(Math.max(20, cols), Math.max(5, rows)); } catch {}
    };
    pane.kill = () => {
      try { ptyProc.kill(); } catch {}
    };
    ptyProc.onData(onOutput);
    ptyProc.onExit(() => {
      pane.status = 'Stopped';
      pane.attention = true;
      pane.lastLine = 'Proceso terminado';
      broadcastState();
    });
  } else {
    const cp = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', '-'], { cwd, env, stdio: 'pipe' });
    pane.proc = cp;
    pane.write = (d) => cp.stdin.write(d);
    pane.kill = () => cp.kill();
    cp.stdout.on('data', (b) => onOutput(b.toString()));
    cp.stderr.on('data', (b) => onOutput(b.toString()));
    cp.on('exit', () => {
      pane.status = 'Stopped';
      pane.attention = true;
      broadcastState();
    });
  }

  panes.set(id, pane);
  saveSessionState();

  if (opts.cmd) {
    setTimeout(() => pane.write(`${opts.cmd}\r`), 350);
  } else if (opts.autoAgy) {
    const convFlag = opts.conversationId
      ? ` --conversation ${opts.conversationId}`
      : (opts.continueAgy ? ' --continue' : '');
    const agyCmd = `agy${convFlag}${remoteControl ? ' --remote-control' : ''}`;
    setTimeout(() => pane.write(`${agyCmd}\r`), 350);
  }

  if (opts.prompt) {
    setTimeout(() => pane.write(`${opts.prompt}\r`), 1200);
  }

  broadcastState();
  return pane;
}

function sendGroupMessage({ fromId, toTarget, text, force = false }) {
  const sender = findPane(fromId);
  const receiver = findPane(toTarget);
  if (!receiver) return { ok: false, error: `No existe el panel o rol "${toTarget}"` };
  if (sender && receiver.id === sender.id) {
    return { ok: false, error: `Bloqueado: "${sender.role}" no puede enviarse un mensaje a sí mismo.` };
  }

  if (!force) {
    if (!sender) return { ok: false, error: 'Remitente no identificado' };
    if (sender.group === 'isolated' || receiver.group === 'isolated') {
      return { ok: false, error: 'Bloqueado: Uno o ambos paneles están en modo Aislado.' };
    }
    if (sender.group !== receiver.group) {
      return {
        ok: false,
        error: `Bloqueado: "${sender.role}" (${GROUPS[sender.group].label}) y "${receiver.role}" (${GROUPS[receiver.group].label}) no están en el mismo grupo.`
      };
    }
  }

  const fromName = sender ? sender.role : 'deck';
  receiver.attention = true;
  receiver.lastLine = `Mensaje de ${fromName}: ${text.slice(0, 80)}`;

  if (receiver.status === 'Running') {
    receiver.queue.push({ from: fromName, text, at: Date.now() });
    broadcastState();
    return { ok: true, queued: true, to: receiver.role, group: receiver.group };
  }

  const formatted = formatDeckMessage(receiver, fromName, text);
  receiver.write(`${formatted}\r`);
  broadcastState();
  return { ok: true, queued: false, to: receiver.role, group: receiver.group, formatted };
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const groupFilter = url.searchParams.get('group');
    let list = Array.from(panes.values()).map(serializePane);
    if (groupFilter) {
      list = groupFilter === 'isolated' ? [] : list.filter(p => p.group === groupFilter);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, groups: GROUPS, panes: list, agySessions: scanAntigravitySubagents() }));
  }

  if (url.pathname === '/api/panes' && req.method === 'POST') {
    const body = await readJson(req);
    const pane = createPane(body);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pane: serializePane(pane) }));
  }

  if (url.pathname.startsWith('/api/panes/') && req.method === 'PATCH') {
    const target = decodeURIComponent(url.pathname.replace('/api/panes/', ''));
    const pane = findPane(target);
    if (!pane) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Pane not found' }));
    }
    const body = await readJson(req);
    if (typeof body.role === 'string' && body.role.trim()) pane.role = body.role.trim();
    if (typeof body.group === 'string' && GROUPS[body.group]) pane.group = body.group;
    if (typeof body.attention === 'boolean') pane.attention = body.attention;
    if (typeof body.remoteControl === 'boolean') pane.remoteControl = body.remoteControl;
    if (Array.isArray(body.subagents)) pane.subagents = body.subagents;
    pane.branch = getGitBranch(pane.cwd);
    broadcastState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pane: serializePane(pane) }));
  }

  if (url.pathname.startsWith('/api/panes/') && req.method === 'DELETE') {
    const target = decodeURIComponent(url.pathname.replace('/api/panes/', ''));
    const pane = findPane(target);
    if (pane) {
      clearTimeout(pane.idleTimer);
      pane.kill();
      panes.delete(pane.id);
      broadcastState();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const body = await readJson(req);
    const result = sendGroupMessage(body);
    res.writeHead(result.ok ? 200 : 403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (url.pathname === '/api/remote-control' && req.method === 'POST') {
    const body = await readJson(req);
    const action = body.action === 'start' ? 'start' : body.action === 'stop' ? 'stop' : 'status';
    try {
      const out = execSync(`agy remote-control ${action}`, { timeout: 5000 }).toString().trim();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, output: out }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, output: (e.stdout || e.message || '').toString().trim() }));
    }
  }

  // Static files
  const filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    return fs.createReadStream(filePath).pipe(res);
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'state',
    groups: GROUPS,
    panes: Array.from(panes.values()).map(serializePane),
    agySessions: scanAntigravitySubagents()
  }));
  for (const p of panes.values()) {
    if (p.buffer) ws.send(JSON.stringify({ type: 'output', id: p.id, data: p.buffer }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        const p = panes.get(msg.id);
        if (p) {
          p.attention = false;
          p.status = 'Running';
          p.write(msg.data);
          broadcastState();
        }
      } else if (msg.type === 'focus') {
        const p = panes.get(msg.id);
        if (p && p.attention) {
          p.attention = false;
          broadcastState();
        }
      } else if (msg.type === 'resize') {
        const p = panes.get(msg.id);
        if (p) p.resize(msg.cols, msg.rows);
      }
    } catch {}
  });

  ws.on('close', () => clients.delete(ws));
});

function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (panes.size === 0 && process.env.DECK_NO_DEFAULT_PANE !== '1') {
        createPane({ role: 'Agente Principal', cwd: process.cwd(), group: 'isolated' });
      }
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().then(() => {
    console.log(`/deck daemon running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { startServer, createPane, sendGroupMessage, findPane, panes, GROUPS, events, saveSessionState, loadPreviousSession, restorePreviousSession, notifyWindows };
