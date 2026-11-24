#!/usr/bin/env node
const { Terminal } = require('@xterm/headless');
const { startServer, createPane, sendGroupMessage, panes, GROUPS, events, saveSessionState, loadPreviousSession, restorePreviousSession, notifyWindows } = require('./server');

const GROUP_ORDER = ['isolated', 'A', 'B', 'C', 'D'];
const RGB = {
  isolated: '82;82;91',
  A: '16;185;129',
  B: '245;158;11',
  C: '168;85;247',
  D: '244;63;94',
  blue: '59;130;246',
  green: '16;185;129',
  muted: '142;146;159',
  border: '52;56;68',
  focus: '203;213;225',
  bgCard: '23;26;33',
  bgActive: '27;34;52',
  bgTop: '17;19;24'
};

const fg = (rgb, s) => `\x1b[38;2;${rgb}m${s}\x1b[39m`;
const bg = (rgb, s) => `\x1b[48;2;${rgb}m${s}\x1b[49m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const moveTo = (r, c) => `\x1b[${r};${c}H`;
const trunc = (s, n) => {
  const str = String(s || '');
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str.padEnd(n, ' ');
};

const xterms = new Map(); // id -> Terminal
let focusedId = null;
let promptMode = null; // { kind: 'role'|'send', buffer: '', targetId }
let pendingRestore = null;
let statusBanner = '';
let renderTimer = null;
let lastGridBoxes = []; // [{ id, r, c, w, h }]
let lastSidebarCards = []; // [{ id, rStart, rEnd }]

function ensureXterm(pane) {
  if (xterms.has(pane.id)) return xterms.get(pane.id);
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 2000 });
  if (pane.buffer) term.write(pane.buffer);
  xterms.set(pane.id, term);
  return term;
}

events.on('output', ({ id, data }) => {
  const p = panes.get(id);
  if (!p) return;
  const term = ensureXterm(p);
  term.write(data, () => scheduleRender());
});

events.on('alert', () => {
  process.stdout.write('\x07');
});

events.on('state', () => {
  for (const id of xterms.keys()) {
    if (!panes.has(id)) {
      xterms.get(id).dispose();
      xterms.delete(id);
    }
  }
  if (!focusedId || !panes.has(focusedId)) {
    const first = panes.keys().next();
    focusedId = first.done ? null : first.value;
  }
  scheduleRender();
});

function computeGridLayout(paneList, x0, y0, totalW, totalH) {
  const visible = paneList.slice(0, 4);
  const n = visible.length;
  if (n === 0) return [];
  if (n === 1) return [{ pane: visible[0], r: y0, c: x0, w: totalW, h: totalH }];
  if (n === 2) {
    const w1 = Math.floor(totalW / 2);
    return [
      { pane: visible[0], r: y0, c: x0, w: w1, h: totalH },
      { pane: visible[1], r: y0, c: x0 + w1, w: totalW - w1, h: totalH }
    ];
  }
  if (n === 3) {
    const w1 = Math.floor(totalW * 0.52);
    const w2 = totalW - w1;
    const h1 = Math.floor(totalH / 2);
    return [
      { pane: visible[0], r: y0, c: x0, w: w1, h: totalH },
      { pane: visible[1], r: y0, c: x0 + w1, w: w2, h: h1 },
      { pane: visible[2], r: y0 + h1, c: x0 + w1, w: w2, h: totalH - h1 }
    ];
  }
  const w1 = Math.floor(totalW / 2);
  const h1 = Math.floor(totalH / 2);
  return [
    { pane: visible[0], r: y0, c: x0, w: w1, h: h1 },
    { pane: visible[1], r: y0, c: x0 + w1, w: totalW - w1, h: h1 },
    { pane: visible[2], r: y0 + h1, c: x0, w: w1, h: totalH - h1 },
    { pane: visible[3], r: y0 + h1, c: x0 + w1, w: totalW - w1, h: totalH - h1 }
  ];
}

function readTermLine(term, rowIdx, maxCols) {
  const buf = term.buffer.active;
  const line = buf.getLine(buf.viewportY + rowIdx);
  if (!line) return ' '.repeat(maxCols);
  let out = '';
  let lastSgr = '';
  let colUsed = 0;

  for (let i = 0; i < maxCols; i++) {
    const cell = line.getCell(i);
    if (!cell) {
      if (lastSgr !== '') { out += '\x1b[0m'; lastSgr = ''; }
      out += ' ';
      colUsed++;
      continue;
    }
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of wide char
    const ch = cell.getChars() || ' ';

    const parts = [];
    if (cell.isBold()) parts.push('1');
    if (cell.isDim()) parts.push('2');
    if (cell.isItalic()) parts.push('3');
    if (cell.isUnderline()) parts.push('4');
    if (cell.isInverse()) parts.push('7');

    if (cell.isFgRGB()) {
      const c = cell.getFgColor();
      parts.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    } else if (cell.isFgPalette()) {
      parts.push(`38;5;${cell.getFgColor()}`);
    }

    if (cell.isBgRGB()) {
      const c = cell.getBgColor();
      parts.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
    } else if (cell.isBgPalette()) {
      parts.push(`48;5;${cell.getBgColor()}`);
    }

    const sgr = parts.length ? `\x1b[${parts.join(';')}m` : '';
    if (sgr !== lastSgr) {
      out += '\x1b[0m' + sgr;
      lastSgr = sgr;
    }
    out += ch;
    colUsed += width;
  }
  if (lastSgr !== '') out += '\x1b[0m';
  if (colUsed < maxCols) out += ' '.repeat(maxCols - colUsed);
  return out;
}

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 32);
}

function render() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const sidebarW = Math.min(30, Math.max(24, Math.floor(cols * 0.24)));
  const gridX = sidebarW + 1;
  const gridW = Math.max(20, cols - sidebarW);
  const bodyH = Math.max(10, rows - 2);

  const paneList = Array.from(panes.values());
  const waitingCount = paneList.filter(p => p.attention).length;
  const doneCount = paneList.filter(p => p.done).length;

  let out = '\x1b[?25l'; // hide cursor during paint

  // 1. Topbar (Row 1)
  const alertTxt = (waitingCount > 0 ? bg(RGB.blue, bold(` ${waitingCount} esperando `)) + ' ' : '') +
                   (doneCount > 0 ? bg(RGB.green, bold(` ${doneCount} listo `)) + ' ' : '');
  const topLeft = ` ${bold('/deck')} ${alertTxt}${fg(RGB.muted, '[F1]+Term [F3]+agy [F4]+agy-RC [F5]Grupo [F6]Rol [F7]Msg [F8]Cerrar [Ctrl+Q]Salir')}`;
  out += moveTo(1, 1) + bg(RGB.bgTop, trunc(topLeft, cols + 40));

  // 2. Sidebar (Cols 1..sidebarW, Rows 2..rows-1)
  lastSidebarCards = [];
  let sRow = 2;
  for (const p of paneList) {
    if (sRow + 3 > rows) break;
    const gMeta = GROUPS[p.group] || GROUPS.isolated;
    const gColor = RGB[p.group] || RGB.isolated;
    const isFocus = p.id === focusedId;
    const cardBg = isFocus ? RGB.bgActive : RGB.bgCard;
    const highlightColor = p.done ? RGB.green : p.attention ? RGB.blue : null;
    const bar = highlightColor ? fg(highlightColor, '┃') : fg(gColor, '┃');
    const titleStr = `[${p.num}] ${p.role}`;
    const pill = bg(gColor, ` ${gMeta.label} `);
    const innerW = sidebarW - 2;
    const padTitle = Math.max(1, innerW - gMeta.label.length - 3);

    out += moveTo(sRow, 1) + bar + bg(cardBg, trunc(titleStr, padTitle) + pill) + fg(RGB.border, '│');
    const subTxt = p.subagents && p.subagents.length ? `↳ ${p.subagents.join(', ')}` : (p.lastLine || 'Listo');
    out += moveTo(sRow + 1, 1) + bar + bg(cardBg, fg(highlightColor || RGB.muted, trunc(subTxt, innerW))) + fg(RGB.border, '│');
    const metaTxt = `${p.status}${p.remoteControl ? '·RC' : ''} ${p.branch ? '· ' + p.branch : ''}`;
    out += moveTo(sRow + 2, 1) + bar + bg(cardBg, fg(RGB.muted, trunc(metaTxt, innerW))) + fg(RGB.border, '│');
    out += moveTo(sRow + 3, 1) + fg(highlightColor || RGB.border, '─'.repeat(sidebarW - 1) + '┤');

    lastSidebarCards.push({ id: p.id, rStart: sRow, rEnd: sRow + 3 });
    sRow += 4;
  }
  while (sRow < rows) {
    out += moveTo(sRow, 1) + ' '.repeat(sidebarW - 1) + fg(RGB.border, '│');
    sRow++;
  }

  // 3. Split Grid (Cols gridX..cols, Rows 2..rows-1)
  const boxes = computeGridLayout(paneList, gridX, 2, gridW, bodyH);
  lastGridBoxes = [];
  let cursorTarget = null;

  for (const b of boxes) {
    const { pane, r, c, w, h } = b;
    lastGridBoxes.push({ id: pane.id, r, c, w, h });
    const term = ensureXterm(pane);
    const innerW = Math.max(10, w - 2);
    const innerH = Math.max(3, h - 2);
    if (term.cols !== innerW || term.rows !== innerH) {
      term.resize(innerW, innerH);
      pane.resize(innerW, innerH);
    }

    const isFocus = pane.id === focusedId;
    const borderRgb = pane.done ? RGB.green : pane.attention ? RGB.blue : isFocus ? RGB.focus : RGB.border;
    const gColor = RGB[pane.group] || RGB.isolated;
    const gLabel = (GROUPS[pane.group] || GROUPS.isolated).label;
    const isScrolled = term.buffer.active.viewportY < term.buffer.active.baseY;

    const hdrTxt = ` [${pane.num}] ${pane.role} (${gLabel})${pane.remoteControl ? ' [RC]' : ''}${isScrolled ? ' [HISTORIAL]' : ''} `;
    const topLine = '┌' + hdrTxt.slice(0, innerW).padEnd(innerW, '─') + '┐';
    out += moveTo(r, c) + fg(borderRgb, topLine.replace(`(${gLabel})`, fg(gColor, `(${gLabel})`)));

    for (let i = 0; i < innerH; i++) {
      const lineStr = readTermLine(term, i, innerW);
      out += moveTo(r + 1 + i, c) + fg(borderRgb, '│') + lineStr + fg(borderRgb, '│');
    }
    out += moveTo(r + h - 1, c) + fg(borderRgb, '└' + '─'.repeat(innerW) + '┘');

    if (isFocus && !promptMode) {
      const curY = r + 1 + Math.min(innerH - 1, term.buffer.active.cursorY);
      const curX = c + 1 + Math.min(innerW - 1, term.buffer.active.cursorX);
      cursorTarget = { r: curY, c: curX };
    }
  }

  // 4. Bottom Status / Prompt Bar (Row rows)
  let bottomTxt = statusBanner || ' Aislado por defecto · Clic o Tab para cambiar foco · F5 cambia grupo';
  if (pendingRestore) {
    const names = pendingRestore.panes.map(p => p.role).slice(0, 4).join(', ');
    bottomTxt = ` ¿Restaurar sesión anterior (${pendingRestore.panes.length} paneles: ${names})? [S] Sí, restaurar  [N] No`;
  } else if (promptMode) {
    const label = promptMode.kind === 'role' ? 'Nuevo rol: ' : 'Enviar a compañero (rol:mensaje): ';
    bottomTxt = ' ' + bold(label) + promptMode.buffer;
  }
  out += moveTo(rows, 1) + (pendingRestore ? bg(RGB.blue, bold(trunc(bottomTxt, cols))) : bg(RGB.bgTop, trunc(bottomTxt, cols)));

  if (promptMode) {
    const pLen = (promptMode.kind === 'role' ? 12 : 36) + promptMode.buffer.length;
    out += moveTo(rows, Math.min(cols, pLen + 1)) + '\x1b[?25h';
  } else if (cursorTarget) {
    out += moveTo(cursorTarget.r, cursorTarget.c) + '\x1b[?25h';
  }

  process.stdout.write(out);
}

function handleMouse(str) {
  // SGR mouse: \x1b[<btn;col;rowM (may arrive batched)
  const regex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m;
  let handled = false;
  while ((m = regex.exec(str)) !== null) {
    handled = true;
    const btn = Number(m[1]), col = Number(m[2]), row = Number(m[3]), kind = m[4];
    if (kind !== 'M') continue;

    // Mouse wheel up (64) / down (65) -> scroll hovered pane
    if (btn === 64 || btn === 65) {
      const box = lastGridBoxes.find(b => col >= b.c && col < b.c + b.w && row >= b.r && row < b.r + b.h)
        || lastGridBoxes.find(b => b.id === focusedId);
      if (box) {
        const term = xterms.get(box.id);
        if (term) {
          term.scrollLines(btn === 64 ? -3 : 3);
          scheduleRender();
        }
      }
      continue;
    }

    if (btn !== 0) continue;

    for (const card of lastSidebarCards) {
      if (row >= card.rStart && row <= card.rEnd && col <= 30) {
        focusedId = card.id;
        const p = panes.get(focusedId);
        if (p) { p.attention = false; p.done = false; p.notified = false; }
        scheduleRender();
        break;
      }
    }
    for (const box of lastGridBoxes) {
      if (col >= box.c && col < box.c + box.w && row >= box.r && row < box.r + box.h) {
        focusedId = box.id;
        const p = panes.get(focusedId);
        if (p) { p.attention = false; p.done = false; p.notified = false; }
        scheduleRender();
        break;
      }
    }
  }
  return handled;
}

function handleKeyInput(buf) {
  const str = buf.toString('utf8');
  if (str.startsWith('\x1b[<') && handleMouse(str)) return;

  // Ctrl+Q exit
  if (str === '\x11') {
    cleanupAndExit();
    return;
  }

  // Restore previous session prompt ([S] / [N])
  if (pendingRestore) {
    if (/^[sy\r\n]$/i.test(str)) {
      const count = restorePreviousSession(pendingRestore);
      pendingRestore = null;
      statusBanner = ` Sesión anterior restaurada (${count} paneles).`;
      scheduleRender();
      return;
    }
    if (/^[n\x1b]$/i.test(str)) {
      pendingRestore = null;
      statusBanner = ' Sesión iniciada desde cero.';
      scheduleRender();
      return;
    }
  }

  // Prompt input mode (F6 rename or F7 send)
  if (promptMode) {
    if (str === '\r' || str === '\n') {
      const val = promptMode.buffer.trim();
      const target = panes.get(promptMode.targetId);
      if (val && target) {
        if (promptMode.kind === 'role') {
          target.role = val;
          statusBanner = ` Rol actualizado: ${val}`;
        } else if (promptMode.kind === 'send') {
          const idx = val.indexOf(':');
          if (idx > 0) {
            const toTarget = val.slice(0, idx).trim();
            const text = val.slice(idx + 1).trim();
            const res = sendGroupMessage({ fromId: target.id, toTarget, text });
            statusBanner = res.ok ? ` Enviado a ${res.to}` : ` ${res.error}`;
          } else {
            statusBanner = ' Formato: rol_destino:mensaje';
          }
        }
      }
      promptMode = null;
      scheduleRender();
      return;
    }
    if (str === '\x1b') { promptMode = null; scheduleRender(); return; }
    if (str === '\x7f' || str === '\b') { promptMode.buffer = promptMode.buffer.slice(0, -1); scheduleRender(); return; }
    if (str >= ' ') { promptMode.buffer += str; scheduleRender(); return; }
    return;
  }

  // Function keys
  if (str === '\x1bOP') { // F1: +Terminal
    const p = createPane({ role: `Terminal ${panes.size + 1}`, cwd: process.cwd(), group: 'isolated' });
    focusedId = p.id;
    return;
  }
  if (str === '\x1bOR') { // F3: +agy
    const p = createPane({ role: `agy ${panes.size + 1}`, cwd: process.cwd(), group: 'isolated', autoAgy: true });
    focusedId = p.id;
    return;
  }
  if (str === '\x1bOS') { // F4: +agy --remote-control
    const p = createPane({ role: `agy-RC ${panes.size + 1}`, cwd: process.cwd(), group: 'isolated', autoAgy: true, remoteControl: true });
    focusedId = p.id;
    return;
  }
  if (str === '\x1b[15~') { // F5: cycle group
    const p = panes.get(focusedId);
    if (p) {
      const next = GROUP_ORDER[(GROUP_ORDER.indexOf(p.group) + 1) % GROUP_ORDER.length];
      p.group = next;
      statusBanner = ` [${p.role}] -> ${GROUPS[next].label}`;
      scheduleRender();
    }
    return;
  }
  if (str === '\x1b[17~') { // F6: rename role
    if (focusedId) { promptMode = { kind: 'role', buffer: '', targetId: focusedId }; scheduleRender(); }
    return;
  }
  if (str === '\x1b[18~') { // F7: send group message
    if (focusedId) { promptMode = { kind: 'send', buffer: '', targetId: focusedId }; scheduleRender(); }
    return;
  }
  if (str === '\x1b[19~') { // F8: close pane
    const p = panes.get(focusedId);
    if (p) { p.kill(); panes.delete(p.id); events.emit('state'); }
    return;
  }
  if (str === '\x1b\t') { // Alt+Tab: switch focus
    const keys = Array.from(panes.keys());
    if (keys.length > 1) {
      focusedId = keys[(keys.indexOf(focusedId) + 1) % keys.length];
      const p = panes.get(focusedId);
      if (p) p.attention = false;
      scheduleRender();
    }
    return;
  }

  // Forward keystroke to focused PTY (and snap back to bottom if scrolled)
  const p = panes.get(focusedId);
  if (p) {
    const term = xterms.get(p.id);
    if (term && term.buffer.active.viewportY < term.buffer.active.baseY) {
      term.scrollToBottom();
    }
    p.attention = false;
    p.done = false;
    p.notified = false;
    p.status = 'Running';
    p.write(str);
  }
}

function cleanupAndExit() {
  saveSessionState();
  process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  for (const p of panes.values()) p.kill();
  process.exit(0);
}

async function main() {
  pendingRestore = loadPreviousSession();
  await startServer();
  if (pendingRestore) {
    const names = pendingRestore.panes.map(p => p.role).slice(0, 3).join(', ');
    notifyWindows('/deck · Sesión anterior encontrada', `¿Quieres restaurar ${pendingRestore.panes.length} paneles (${names})? Presiona [S] en /deck.`);
  }
  setInterval(saveSessionState, 15000).unref();
  process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h'); // alt screen + mouse SGR
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleKeyInput);
  process.stdout.on('resize', scheduleRender);
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGHUP', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  process.on('exit', saveSessionState);
  render();
}

main().catch((err) => {
  cleanupAndExit();
  console.error(err);
});
