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
const BRAIN_DIRS = [
  path.join(AGY_DIR, 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity', 'brain')
];
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
const commLog = [];
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

const usageFileCache = new Map();
let cachedUsageResult = null;
let lastUsageScanAt = 0;

function formatCompactTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(num);
}

function formatModelName(rawModel) {
  const id = String(rawModel || '').trim();
  if (!id) return { label: 'Desconocido', family: 'other' };
  const tierMap = { low: 'L', medium: 'M', high: 'H', xhigh: 'XH' };
  let family = 'other';
  if (/hydrogen/i.test(id)) family = 'hydrogen';
  else if (/carbon/i.test(id)) family = 'carbon';
  else if (/argon/i.test(id)) family = 'argon';
  else if (/neon/i.test(id)) family = 'neon';
  else if (/claude|sonnet|opus/i.test(id)) family = 'claude';
  else if (/flash/i.test(id)) family = 'flash';

  const g4 = id.match(/^gemini-4-([a-z]+)-(low|medium|high|xhigh)$/i);
  if (g4) {
    const name = g4[1].charAt(0).toUpperCase() + g4[1].slice(1);
    return { label: `G4 ${name} (${tierMap[g4[2].toLowerCase()]})`, family };
  }
  const gFlash = id.match(/^gemini-([\d.]+)-flash-(low|medium|high|xhigh)$/i);
  if (gFlash) {
    return { label: `G${gFlash[1]} Flash (${tierMap[gFlash[2].toLowerCase()]})`, family: 'flash' };
  }
  const claude = id.match(/^claude-(opus|sonnet)-(\d+)-(\d+)-(low|medium|high)$/i);
  if (claude) {
    const name = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return { label: `${name} ${claude[2]}.${claude[3]} (${tierMap[claude[4].toLowerCase()]})`, family: 'claude' };
  }
  if (/orchestrator/i.test(id)) {
    const sub = id.match(/orchestrator-([a-z]+)/i);
    return { label: sub ? `Orch (${sub[1].charAt(0).toUpperCase() + sub[1].slice(1)})` : 'Orchestrator', family };
  }
  return { label: id.replace(/^gemini-/i, 'G-').slice(0, 20), family };
}

function scanModelUsage(opts = {}) {
  const now = Date.now();
  const customDirs = Array.isArray(opts.brainDirs) ? opts.brainDirs : null;
  if (!customDirs && !opts.force && cachedUsageResult && now - lastUsageScanAt < 3000) {
    return cachedUsageResult;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = opts.sinceMs !== undefined ? opts.sinceMs : startOfDay.getTime();
  const dayKey = `${startOfDay.getFullYear()}-${startOfDay.getMonth()}-${startOfDay.getDate()}`;
  const dirs = customDirs || BRAIN_DIRS;
  const totals = new Map();

  for (const brainDir of dirs) {
    if (!fs.existsSync(brainDir)) continue;
    let convDirs = [];
    try { convDirs = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { continue; }

    for (const d of convDirs) {
      if (!d.isDirectory()) continue;
      const tPath = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(tPath).mtimeMs; } catch { continue; }
      if (mtimeMs < startMs) continue;

      let fileSummary = !customDirs ? usageFileCache.get(tPath) : null;
      if (!fileSummary || fileSummary.mtimeMs !== mtimeMs || fileSummary.dayKey !== dayKey) {
        const perModel = {};
        try {
          const lines = fs.readFileSync(tPath, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.includes('"model"')) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || !entry.model) continue;
            if (entry.created_at) {
              const ts = Date.parse(entry.created_at);
              if (!Number.isNaN(ts) && ts < startMs) continue;
            }
            const m = entry.model;
            if (!perModel[m]) perModel[m] = { turns: 0, in: 0, out: 0, cache: 0 };
            perModel[m].turns += 1;
            perModel[m].in += Number(entry.input_tokens || 0);
            perModel[m].out += Number(entry.output_tokens || 0);
            perModel[m].cache += Number(entry.cache_read_tokens || 0);
          }
        } catch { continue; }
        fileSummary = { mtimeMs, dayKey, perModel };
        if (!customDirs) usageFileCache.set(tPath, fileSummary);
      }

      for (const [m, s] of Object.entries(fileSummary.perModel)) {
        const cur = totals.get(m) || { turns: 0, in: 0, out: 0, cache: 0 };
        cur.turns += s.turns;
        cur.in += s.in;
        cur.out += s.out;
        cur.cache += s.cache;
        totals.set(m, cur);
      }
    }
  }

  let totalIn = 0, totalOut = 0, totalCache = 0, totalTurns = 0;
  const models = [];
  for (const [id, s] of totals.entries()) {
    const activeTokens = s.in + s.out;
    totalIn += s.in;
    totalOut += s.out;
    totalCache += s.cache;
    totalTurns += s.turns;
    const { label, family } = formatModelName(id);
    models.push({
      id,
      label,
      family,
      turns: s.turns,
      inputTokens: s.in,
      outputTokens: s.out,
      cacheTokens: s.cache,
      activeTokens,
      totalTokens: activeTokens + s.cache
    });
  }

  models.sort((a, b) => b.activeTokens - a.activeTokens || b.turns - a.turns);
  const maxActive = models.length ? Math.max(1, models[0].activeTokens) : 1;
  for (const m of models) {
    m.share = Math.min(1, m.activeTokens / maxActive);
  }

  const res = {
    totalIn,
    totalOut,
    totalCache,
    totalActive: totalIn + totalOut,
    totalTurns,
    models
  };
  if (!customDirs) {
    cachedUsageResult = res;
    lastUsageScanAt = now;
  }
  return res;
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const AGY_LOGO_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'agy', 'img', 'logo.png'
);

const NOTIFY_SCRIPT = path.join(__dirname, 'notify.ps1');

function notifyWindows(summary, message, kind = 'done') {
  if (process.env.DECK_NO_NOTIFY === '1') return;
  const safeSummary = String(summary || 'Tarea finalizada').slice(0, 80);
  const safeMsg = String(message || '').slice(0, 140);
  const logoArg = fs.existsSync(AGY_LOGO_PATH) ? AGY_LOGO_PATH : '';
  try {
    spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', NOTIFY_SCRIPT,
      '-Title', 'Antigravity',
      '-Summary', safeSummary,
      '-Detail', safeMsg,
      '-LogoPath', logoArg,
      '-Kind', kind === 'waiting' ? 'waiting' : 'done'
    ], {
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
      conversationId: item.conversationId || null,
      skipSave: true
    });
  }
  saveSessionState();
  return saved.panes.length;
}

function broadcastState() {
  broadcast({
    type: 'state',
    groups: GROUPS,
    panes: Array.from(panes.values()).map(serializePane),
    agySessions: scanAntigravitySubagents(),
    modelUsage: scanModelUsage()
  });
}

function swapPanes(idA, idB) {
  if (!idA || !idB || idA === idB || !panes.has(idA) || !panes.has(idB)) return false;
  const entries = Array.from(panes.entries());
  const idxA = entries.findIndex(([k]) => k === idA);
  const idxB = entries.findIndex(([k]) => k === idB);
  if (idxA === -1 || idxB === -1) return false;
  [entries[idxA], entries[idxB]] = [entries[idxB], entries[idxA]];
  panes.clear();
  for (const [k, v] of entries) panes.set(k, v);
  saveSessionState();
  broadcastState();
  return true;
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

const DECK_CLI = path.join(__dirname, 'bin', 'deck.js');

function formatDeckMessage(receiver, fromName, text, opts = {}) {
  const isAgy = Boolean(receiver.wasAgy || receiver.remoteControl || /Antigravity CLI/i.test(receiver.buffer));
  const grp = GROUPS[receiver.group]?.label || receiver.group;
  if (isAgy) {
    const canReply = !opts.reply && fromName && fromName !== 'deck';
    const replyHint = canReply
      ? ` [Al terminar, confirma o responde ejecutando: node "${DECK_CLI}" send "${fromName}" "<tu respuesta o confirmación>" --reply]`
      : '';
    return `[DECK de ${fromName} (${grp})]: ${text}${replyHint}`;
  }
  return `# [DECK MSG from ${fromName} (${grp})]: ${text}`;
}

function flushQueue(pane) {
  if (!pane.queue.length || !pane.proc) return;
  const next = pane.queue.shift();
  const formatted = formatDeckMessage(pane, next.from, next.text, { reply: next.reply });
  pane.markCommandStart();
  pane.write(`\r\n${formatted}\r\n`);
  const queuedEntry = commLog.find(e => e.to === pane.role && e.from === next.from && e.queued);
  if (queuedEntry) queuedEntry.queued = false;
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
    hasCommand: false,
    turnOutputBytes: 0,
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
    markCommandStart: () => {
      pane.hasCommand = true;
      pane.turnOutputBytes = 0;
      pane.done = false;
      pane.attention = false;
      pane.notified = false;
    },
    clearAlerts: () => {
      pane.attention = false;
      pane.done = false;
      pane.notified = false;
      pane.hasCommand = false;
      pane.turnOutputBytes = 0;
    },
    write: () => {},
    resize: () => {},
    kill: () => {}
  };

  let startupCmd = null;
  if (opts.cmd) {
    startupCmd = opts.cmd;
  } else if (opts.autoAgy) {
    const convFlag = opts.conversationId
      ? ` --conversation ${opts.conversationId}`
      : (opts.continueAgy ? ' --continue' : '');
    startupCmd = `agy${convFlag}${remoteControl ? ' --remote-control' : ''}`;
  }

  let startupSent = false;
  let startupFallback = null;
  const sendStartupCmd = () => {
    if (startupSent || !startupCmd) return;
    startupSent = true;
    if (startupFallback) clearTimeout(startupFallback);
    pane.write(`${startupCmd}\r`);
    if (opts.prompt) {
      setTimeout(() => {
        pane.markCommandStart();
        pane.write(`${opts.prompt}\r`);
      }, 1200);
    }
  };

  const onOutput = (raw) => {
    pane.buffer = (pane.buffer + raw).slice(-40000);
    pane.outputBytes += raw.length;
    const clean = stripAnsi(raw);
    if (pane.hasCommand) {
      pane.turnOutputBytes += clean.trim().length;
      pane.status = 'Running';
    }
    pane.done = false;
    if (!pane.wasAgy && /Antigravity CLI/i.test(clean)) pane.wasAgy = true;
    if (startupCmd && !startupSent && /PS [^\r\n]*>\s*$/.test(clean)) {
      setTimeout(sendStartupCmd, 80);
    }
    const det = detectAttention(clean);
    if (det && det.lastLine) {
      pane.lastLine = det.lastLine;
      if (det.needsAttention && !/^[A-Z]:\\.*>$/i.test(det.lastLine)) {
        pane.attention = true;
        pane.status = 'Waiting';
        if (!pane.notified) {
          pane.notified = true;
          events.emit('alert', { id: pane.id, kind: 'waiting' });
          notifyWindows(`${pane.role} (${GROUPS[pane.group]?.label || 'Aislado'}) espera confirmación`, pane.lastLine, 'waiting');
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
      const completedCommand = pane.hasCommand && pane.turnOutputBytes > 120;
      pane.status = completedCommand ? 'Done' : 'Ready';
      pane.done = completedCommand;
      pane.attention = false;
      if (completedCommand && !pane.notified) {
        pane.notified = true;
        events.emit('alert', { id: pane.id, kind: 'done' });
        notifyWindows(`${pane.role} (${GROUPS[pane.group]?.label || 'Aislado'}) terminó la tarea`, pane.lastLine || 'CLI listo para revisar', 'done');
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
  if (!opts.skipSave) saveSessionState();

  if (startupCmd) {
    startupFallback = setTimeout(sendStartupCmd, 2000);
  } else if (opts.prompt) {
    setTimeout(() => {
      pane.markCommandStart();
      pane.write(`${opts.prompt}\r`);
    }, 1200);
  }

  broadcastState();
  return pane;
}

function sendGroupMessage({ fromId, toTarget, text, force = false, reply = false }) {
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
  const isQueued = receiver.status === 'Running';
  commLog.push({ from: fromName, to: receiver.role, group: receiver.group, text: text.slice(0, 80), queued: isQueued, at: Date.now() });
  if (commLog.length > 12) commLog.shift();

  receiver.attention = true;
  receiver.lastLine = `Mensaje de ${fromName}: ${text.slice(0, 80)}`;

  if (isQueued) {
    receiver.queue.push({ from: fromName, text, reply: Boolean(reply), at: Date.now() });
    broadcastState();
    return { ok: true, queued: true, to: receiver.role, group: receiver.group };
  }

  const formatted = formatDeckMessage(receiver, fromName, text, { reply: Boolean(reply) });
  receiver.markCommandStart();
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
    return res.end(JSON.stringify({ ok: true, groups: GROUPS, panes: list, agySessions: scanAntigravitySubagents(), modelUsage: scanModelUsage() }));
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
    saveSessionState();
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
      saveSessionState();
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
    agySessions: scanAntigravitySubagents(),
    modelUsage: scanModelUsage()
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
          if (String(msg.data || '').includes('\r') || String(msg.data || '').includes('\n')) {
            p.markCommandStart();
            p.status = 'Running';
          } else {
            p.clearAlerts();
          }
          p.write(msg.data);
          broadcastState();
        }
      } else if (msg.type === 'focus') {
        const p = panes.get(msg.id);
        if (p && (p.attention || p.done)) {
          p.clearAlerts();
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

function startServer(port = PORT, opts = {}) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (panes.size === 0 && !opts.noDefaultPane && process.env.DECK_NO_DEFAULT_PANE !== '1') {
        createPane({ role: 'Agente Principal', cwd: process.cwd(), group: 'isolated', autoAgy: true });
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

module.exports = { startServer, createPane, sendGroupMessage, findPane, swapPanes, panes, GROUPS, events, commLog, saveSessionState, loadPreviousSession, restorePreviousSession, notifyWindows, scanModelUsage, formatModelName, formatCompactTokens };
