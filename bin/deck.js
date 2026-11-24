#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.DECK_PORT || 4777);
const BASE = `http://127.0.0.1:${PORT}`;

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureDaemon() {
  try {
    await apiRequest('GET', '/api/state');
    return true;
  } catch {
    const serverPath = path.join(__dirname, '..', 'server.js');
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 150));
      try {
        await apiRequest('GET', '/api/state');
        return true;
      } catch {}
    }
    return false;
  }
}

function openUI() {
  const url = `${BASE}`;
  // Try fast Edge/Chrome app-mode window (0 bloat, instant startup, native look)
  const cmd = `
    $edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    if (-not (Test-Path $edge)) { $edge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" }
    if (Test-Path $edge) {
      Start-Process $edge -ArgumentList "--app=${url} --window-size=1420,860"
    } else {
      Start-Process "${url}"
    }
  `;
  spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'open';

  await ensureDaemon();

  if (cmd === 'open' || cmd === 'ui') {
    openUI();
    console.log(`/deck abierto en ${BASE}`);
    return;
  }

  if (cmd === 'list' || cmd === 'peers') {
    const groupFilter = cmd === 'peers' ? (process.env.DECK_GROUP || 'isolated') : '';
    const res = await apiRequest('GET', `/api/state${groupFilter ? '?group=' + encodeURIComponent(groupFilter) : ''}`);
    if (!res.panes || !res.panes.length) {
      console.log(cmd === 'peers' ? 'Sin compañeros en este grupo (terminal en modo Aislado o sin pares).' : 'No hay paneles activos.');
      return;
    }
    for (const p of res.panes) {
      if (cmd === 'peers' && p.id === process.env.DECK_PANE_ID) continue;
      console.log(`[${p.num}] ${p.role} (${p.groupMeta.label}) - ${p.status}${p.attention ? ' [ATENCION]' : ''} - ${p.cwd}`);
    }
    return;
  }

  if (cmd === 'spawn' || cmd === 'split') {
    const roleIdx = args.indexOf('--role');
    const groupIdx = args.indexOf('--group');
    const cwdIdx = args.indexOf('--cwd');
    const promptIdx = args.indexOf('--prompt');
    const rc = args.includes('--remote-control');
    const agy = args.includes('--agy');

    const role = roleIdx !== -1 ? args[roleIdx + 1] : (args[1] && !args[1].startsWith('--') ? args[1] : undefined);
    const group = groupIdx !== -1 ? args[groupIdx + 1] : (process.env.DECK_GROUP || 'isolated');
    const cwd = cwdIdx !== -1 ? path.resolve(args[cwdIdx + 1]) : process.cwd();
    const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;

    const res = await apiRequest('POST', '/api/panes', { role, group, cwd, prompt, autoAgy: agy || rc, remoteControl: rc });
    console.log(`Panel creado: [${res.pane.num}] ${res.pane.role} (${res.pane.groupMeta.label})`);
    return;
  }

  if (cmd === 'role') {
    const target = args.length > 2 ? args[1] : (process.env.DECK_PANE_ID || '1');
    const newRole = args.length > 2 ? args[2] : args[1];
    if (!newRole) { console.error('Uso: deck role [panel] <nuevo-rol>'); process.exit(1); }
    const res = await apiRequest('PATCH', `/api/panes/${encodeURIComponent(target)}`, { role: newRole });
    if (!res.ok) { console.error(res.error); process.exit(1); }
    console.log(`Rol actualizado: [${res.pane.num}] -> ${res.pane.role}`);
    return;
  }

  if (cmd === 'group' || cmd === 'link' || cmd === 'isolate') {
    if (cmd === 'isolate') {
      const target = args[1] || process.env.DECK_PANE_ID || '1';
      const res = await apiRequest('PATCH', `/api/panes/${encodeURIComponent(target)}`, { group: 'isolated' });
      console.log(`Panel [${res.pane?.role || target}] puesto en modo Aislado.`);
      return;
    }
    // deck link <pane1> <pane2> [group=A]
    if (cmd === 'link' && args.length >= 3) {
      const p1 = args[1];
      const p2 = args[2];
      const grp = (args[3] || 'A').toUpperCase();
      await apiRequest('PATCH', `/api/panes/${encodeURIComponent(p1)}`, { group: grp });
      await apiRequest('PATCH', `/api/panes/${encodeURIComponent(p2)}`, { group: grp });
      console.log(`Vinculados "${p1}" y "${p2}" en Grupo ${grp}.`);
      return;
    }
    const target = args.length > 2 ? args[1] : (process.env.DECK_PANE_ID || '1');
    const grp = (args.length > 2 ? args[2] : args[1] || 'isolated');
    const normGroup = grp.toLowerCase() === 'isolated' || grp.toLowerCase() === 'aislado' ? 'isolated' : grp.toUpperCase();
    const res = await apiRequest('PATCH', `/api/panes/${encodeURIComponent(target)}`, { group: normGroup });
    console.log(`Grupo actualizado: [${res.pane?.role}] -> ${res.pane?.groupMeta?.label}`);
    return;
  }

  if (cmd === 'send') {
    const toTarget = args[1];
    const text = args.slice(2).join(' ');
    const fromId = process.env.DECK_PANE_ID;
    const force = !fromId || args.includes('--force');
    if (!toTarget || !text) { console.error('Uso: deck send <rol-destino> "<mensaje>"'); process.exit(1); }
    const res = await apiRequest('POST', '/api/send', { fromId, toTarget, text, force });
    if (!res.ok) {
      console.error(res.error);
      process.exit(1);
    }
    console.log(res.queued ? `Mensaje encolado para ${res.to} (${res.group})` : `Mensaje enviado a ${res.to}`);
    return;
  }

  console.log(`Comandos de /deck:
  deck open                          Abre la ventana visual de /deck
  deck list                          Lista todos los paneles y sus estados
  deck peers                         Lista solo los compañeros de tu mismo grupo
  deck spawn <rol> [--group A..D]    Crea un nuevo panel (aislado por defecto)
  deck role [panel] <nuevo-rol>      Asigna o cambia el rol/etiqueta de una terminal
  deck link <rol1> <rol2> [A|B|C|D]  Vincula dos paneles en un grupo de color
  deck isolate <rol>                 Vuelve a aislar un panel
  deck send <rol-destino> "mensaje"  Envía un mensaje a otro panel de tu mismo grupo`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
