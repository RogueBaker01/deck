#!/usr/bin/env node
const { Terminal } = require('@xterm/headless');
const { startServer, createPane, sendGroupMessage, swapPanes, panes, GROUPS, events, commLog, saveSessionState, loadPreviousSession, restorePreviousSession, notifyWindows, scanModelUsage, formatCompactTokens, refreshModelQuota, getModelQuota, formatResetEta } = require('./server');

const GROUP_ORDER = ['isolated', 'A', 'B', 'C', 'D'];
const RGB = {
  isolated: '82;82;91',
  A: '16;185;129',
  B: '245;158;11',
  C: '168;85;247',
  D: '244;63;94',
  blue: '59;130;246',
  green: '16;185;129',
  cyan: '56;189;248',
  amber: '251;191;36',
  violet: '192;132;252',
  coral: '251;113;133',
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
let pulseTimer = null;
let lastGridBoxes = []; // [{ id, r, c, w, h }]
let lastSidebarCards = []; // [{ id, rStart, rEnd }]
let customSidebarW = null;
let splitRatioX = 0.5;
let splitRatioY = 0.5;
let lastLayout = { cols: 120, rows: 32, sidebarW: 28, gridX: 29, gridW: 91, bodyH: 30 };
let dragState = null; // { kind: 'resize-sidebar'|'resize-grid-x'|'resize-grid-y'|'move-pane', ... }

const MODEL_FAMILY_RGB = {
  hydrogen: RGB.cyan,
  carbon: RGB.green,
  argon: RGB.amber,
  neon: RGB.violet,
  claude: RGB.coral,
  flash: RGB.blue,
  other: RGB.focus
};

function lerpRgb(c1, c2, t) {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `${r};${g};${b}`;
}

function syncPulseTimer() {
  const active = Array.from(panes.values()).some(p => p.done);
  if (active && !pulseTimer) {
    pulseTimer = setInterval(() => {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      render();
    }, 40);
    pulseTimer.unref();
  } else if (!active && pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

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
    const w1 = Math.max(12, Math.min(totalW - 12, Math.floor(totalW * splitRatioX)));
    return [
      { pane: visible[0], r: y0, c: x0, w: w1, h: totalH },
      { pane: visible[1], r: y0, c: x0 + w1, w: totalW - w1, h: totalH }
    ];
  }
  if (n === 3) {
    const w1 = Math.max(12, Math.min(totalW - 12, Math.floor(totalW * splitRatioX)));
    const w2 = totalW - w1;
    const h1 = Math.max(5, Math.min(totalH - 5, Math.floor(totalH * splitRatioY)));
    return [
      { pane: visible[0], r: y0, c: x0, w: w1, h: totalH },
      { pane: visible[1], r: y0, c: x0 + w1, w: w2, h: h1 },
      { pane: visible[2], r: y0 + h1, c: x0 + w1, w: w2, h: totalH - h1 }
    ];
  }
  const w1 = Math.max(12, Math.min(totalW - 12, Math.floor(totalW * splitRatioX)));
  const h1 = Math.max(5, Math.min(totalH - 5, Math.floor(totalH * splitRatioY)));
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
  }, 16);
}

function render() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const defaultSidebarW = Math.min(30, Math.max(24, Math.floor(cols * 0.24)));
  const sidebarW = Math.min(Math.max(16, cols - 24), Math.max(16, customSidebarW ?? defaultSidebarW));
  const gridX = sidebarW + 1;
  const gridW = Math.max(20, cols - sidebarW);
  const bodyH = Math.max(10, rows - 2);
  lastLayout = { cols, rows, sidebarW, gridX, gridW, bodyH };

  const paneList = Array.from(panes.values());
  syncPulseTimer();
  const pulseT = (Math.sin(Date.now() / 240) + 1) / 2;
  const donePulseRgb = lerpRgb([14, 54, 38], [74, 255, 178], pulseT);
  const doneCardBg = lerpRgb([23, 26, 33], [18, 60, 42], pulseT);
  const doneBorderBg = lerpRgb([17, 19, 24], [14, 48, 34], pulseT);
  const waitingCount = paneList.filter(p => p.attention).length;
  const doneCount = paneList.filter(p => p.done).length;

  let out = '\x1b[?25l'; // hide cursor during paint

  // 1. Topbar (Row 1)
  const alertTxt = (waitingCount > 0 ? bg(RGB.blue, bold(` ${waitingCount} esperando `)) + ' ' : '') +
                   (doneCount > 0 ? bg(RGB.green, bold(` ${doneCount} listo `)) + ' ' : '');
  const topLeft = ` ${bold('/deck')} ${alertTxt}${fg(RGB.muted, '[F1]+Term [F3]+agy [F4]+agy-RC [F5]Grupo [F6]Rol [F7]Cerrar [Ctrl+Q]Salir')}`;
  out += moveTo(1, 1) + bg(RGB.bgTop, trunc(topLeft, cols + 40));

  // 2. Sidebar (Cols 1..sidebarW, Rows 2..rows-1)
  lastSidebarCards = [];
  let sRow = 2;
  for (const p of paneList) {
    if (sRow + 3 > rows) break;
    const gMeta = GROUPS[p.group] || GROUPS.isolated;
    const gColor = RGB[p.group] || RGB.isolated;
    const isFocus = p.id === focusedId;
    const cardBg = p.done ? doneCardBg : isFocus ? RGB.bgActive : RGB.bgCard;
    const highlightColor = p.done ? donePulseRgb : p.attention ? RGB.blue : null;
    const bar = highlightColor ? fg(highlightColor, '┃') : fg(gColor, '┃');
    const titleStr = `[${p.num}] ${p.role}`;
    const pillText = ` ${gMeta.label} `;
    const pill = bg(gColor, pillText);
    const innerW = sidebarW - 2;
    const padTitle = Math.max(1, innerW - gMeta.label.length - 3);
    const pillColStart = 2 + padTitle;
    const pillColEnd = pillColStart + pillText.length - 1;

    out += moveTo(sRow, 1) + bar + bg(cardBg, trunc(titleStr, padTitle) + pill) + fg(RGB.border, '│');
    const subTxt = p.subagents && p.subagents.length ? `↳ ${p.subagents.join(', ')}` : (p.lastLine || 'Listo');
    out += moveTo(sRow + 1, 1) + bar + bg(cardBg, fg(highlightColor || RGB.muted, trunc(subTxt, innerW))) + fg(RGB.border, '│');
    const qTxt = p.queue && p.queue.length ? ` · ${p.queue.length} cola` : '';
    const metaTxt = `${p.status}${p.remoteControl ? '·RC' : ''}${qTxt} ${p.branch ? '· ' + p.branch : ''}`;
    out += moveTo(sRow + 2, 1) + bar + bg(cardBg, fg(RGB.muted, trunc(metaTxt, innerW))) + fg(RGB.border, '│');
    out += moveTo(sRow + 3, 1) + fg(highlightColor || RGB.border, '─'.repeat(sidebarW - 1) + '┤');

    lastSidebarCards.push({ id: p.id, rStart: sRow, rEnd: sRow + 3, pillRow: sRow, pillColStart, pillColEnd });
    sRow += 4;
  }
  if (sRow + 2 < rows) {
    const quota = getModelQuota();
    if (quota && quota.pools && quota.pools.length) {
      const planTag = quota.planName ? ` · ${quota.planName}` : '';
      out += moveTo(sRow, 1) + fg(RGB.focus, bold(trunc(` Cuota Restante${planTag}`, sidebarW - 1))) + fg(RGB.border, '│');
      sRow++;
      for (const pool of quota.pools) {
        if (sRow + 1 >= rows) break;
        const pct = pool.remainingPct;
        const qCol = pct > 50 ? RGB.green : pct > 20 ? RGB.amber : RGB.coral;
        const rightTxt = `${pct}%`;
        const barW = 5;
        const filled = Math.max(0, Math.min(barW, Math.round((pct / 100) * barW)));
        const barStr = fg(qCol, '█'.repeat(filled)) + fg(RGB.border, '░'.repeat(barW - filled));
        const eta = formatResetEta(pool.resetTime);
        const nameW = Math.max(4, sidebarW - 4 - rightTxt.length - 1);
        const nameStr = trunc(pool.label, nameW);
        const padMid = ' '.repeat(Math.max(1, (sidebarW - 4) - nameStr.length - rightTxt.length));
        out += moveTo(sRow, 1) + ' ' + fg(qCol, '•') + ' ' + fg(RGB.focus, nameStr) + padMid + fg(qCol, bold(rightTxt)) + fg(RGB.border, '│');
        const etaTxt = eta ? ` reset ${eta}` : '';
        out += moveTo(sRow + 1, 1) + '  ' + barStr + fg(RGB.muted, trunc(etaTxt, Math.max(1, sidebarW - 8))) + fg(RGB.border, '│');
        sRow += 2;
      }
      if (sRow < rows && quota.promptCredits != null) {
        out += moveTo(sRow, 1) + fg(RGB.muted, trunc(` Créditos: ${quota.promptCredits}P · ${quota.flowCredits ?? 0}F`, sidebarW - 1)) + fg(RGB.border, '│');
        sRow++;
      }
      if (sRow < rows) {
        out += moveTo(sRow, 1) + fg(RGB.border, '─'.repeat(sidebarW - 1) + '┤');
        sRow++;
      }
    }
  }
  if (sRow + 2 < rows) {
    const usage = scanModelUsage();
    const renderUsageBlock = (title, summary, maxItems) => {
      if (sRow + 1 >= rows) return;
      out += moveTo(sRow, 1) + fg(RGB.focus, bold(trunc(` ${title} · ${formatCompactTokens(summary.totalActive)} tok`, sidebarW - 1))) + fg(RGB.border, '│');
      sRow++;
      if (!summary.models.length) {
        out += moveTo(sRow, 1) + fg(RGB.muted, trunc(' Sin actividad', sidebarW - 1)) + fg(RGB.border, '│');
        sRow++;
        return;
      }
      for (const m of summary.models.slice(0, maxItems)) {
        if (sRow >= rows) break;
        const mCol = MODEL_FAMILY_RGB[m.family] || RGB.focus;
        const rightTxt = `${formatCompactTokens(m.activeTokens)}·${m.turns}t`;
        if (sidebarW - 4 > rightTxt.length + 4) {
          const nameW = (sidebarW - 4) - rightTxt.length - 1;
          const nameStr = trunc(m.label, nameW);
          const padMid = ' '.repeat(Math.max(1, (sidebarW - 4) - nameStr.length - rightTxt.length));
          out += moveTo(sRow, 1) + ' ' + fg(mCol, '•') + ' ' + fg(RGB.focus, nameStr) + padMid + fg(mCol, rightTxt) + fg(RGB.border, '│');
        } else {
          out += moveTo(sRow, 1) + ' ' + fg(mCol, '•') + fg(RGB.focus, trunc(` ${m.label} ${rightTxt}`, sidebarW - 3)) + fg(RGB.border, '│');
        }
        sRow++;
        if (sRow < rows && maxItems <= 3) {
          const barW = 5;
          const filled = Math.max(1, Math.min(barW, Math.round(m.share * barW)));
          const barStr = fg(mCol, '█'.repeat(filled)) + fg(RGB.border, '░'.repeat(barW - filled));
          const detailRaw = sidebarW >= 34
            ? ` in:${formatCompactTokens(m.inputTokens)} out:${formatCompactTokens(m.outputTokens)} ca:${formatCompactTokens(m.cacheTokens)}`
            : ` in:${formatCompactTokens(m.inputTokens)} out:${formatCompactTokens(m.outputTokens)}`;
          out += moveTo(sRow, 1) + '  ' + barStr + fg(RGB.muted, trunc(detailRaw, Math.max(1, sidebarW - 8))) + fg(RGB.border, '│');
          sRow++;
        }
      }
    };

    renderUsageBlock('Consumo Hoy', usage, Math.min(3, Math.max(1, Math.floor((rows - sRow) / 4))));
    if (sRow + 2 < rows && usage.week) {
      renderUsageBlock('Semana (7d)', usage.week, Math.min(3, Math.max(1, Math.floor((rows - sRow) / 3))));
    }
    if (sRow + 1 < rows) {
      out += moveTo(sRow, 1) + fg(RGB.border, '─'.repeat(sidebarW - 1) + '┤');
      sRow++;
    }
  }
  if (sRow + 2 < rows) {
    const innerW = sidebarW - 2;
    out += moveTo(sRow, 1) + fg(RGB.muted, trunc(' Comunicación entre IAs', sidebarW - 1)) + fg(RGB.border, '│');
    sRow++;
    const recent = commLog.slice(-Math.max(1, Math.floor((rows - sRow) / 2))).reverse();
    if (!recent.length) {
      out += moveTo(sRow, 1) + fg(RGB.muted, trunc(' Sin mensajes aún', sidebarW - 1)) + fg(RGB.border, '│');
      sRow++;
    } else {
      for (const m of recent) {
        if (sRow + 1 >= rows) break;
        const gCol = RGB[m.group] || RGB.muted;
        const hdr = `${m.from} → ${m.to}${m.queued ? ' [cola]' : ''}`;
        out += moveTo(sRow, 1) + fg(gCol, '•') + fg(RGB.focus, trunc(' ' + hdr, innerW)) + fg(RGB.border, '│');
        out += moveTo(sRow + 1, 1) + ' ' + fg(RGB.muted, trunc(m.text, innerW)) + fg(RGB.border, '│');
        sRow += 2;
      }
    }
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
    const borderRgb = pane.done ? donePulseRgb : pane.attention ? RGB.blue : isFocus ? RGB.focus : RGB.border;
    const paintBorder = (s) => pane.done ? bg(doneBorderBg, fg(borderRgb, s)) : fg(borderRgb, s);
    const ch = pane.done
      ? { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }
      : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
    const gColor = RGB[pane.group] || RGB.isolated;
    const gLabel = (GROUPS[pane.group] || GROUPS.isolated).label;
    const isScrolled = term.buffer.active.viewportY < term.buffer.active.baseY;

    const hdrPrefix = ` [${pane.num}] ${pane.role} `;
    const hdrGroup = `(${gLabel})`;
    const doneTag = pane.done ? ' [LISTO]' : '';
    const hdrTxt = `${hdrPrefix}${hdrGroup}${pane.remoteControl ? ' [RC]' : ''}${doneTag}${isScrolled ? ' [HISTORIAL]' : ''} `;
    const topLine = ch.tl + hdrTxt.slice(0, innerW).padEnd(innerW, ch.h) + ch.tr;
    const restoreBorder = pane.done ? `\x1b[48;2;${doneBorderBg}m\x1b[38;2;${borderRgb}m` : `\x1b[38;2;${borderRgb}m`;
    let paintedTop = paintBorder(topLine)
      .replace(hdrGroup, fg(gColor, hdrGroup) + restoreBorder);
    if (doneTag) {
      paintedTop = paintedTop.replace(doneTag, bg(donePulseRgb, bold(' LISTO ')) + restoreBorder);
    }
    out += moveTo(r, c) + paintedTop;

    lastGridBoxes[lastGridBoxes.length - 1].hdrGroupStart = c + 1 + hdrPrefix.length;
    lastGridBoxes[lastGridBoxes.length - 1].hdrGroupEnd = c + 1 + hdrPrefix.length + hdrGroup.length - 1;

    for (let i = 0; i < innerH; i++) {
      const lineStr = readTermLine(term, i, innerW);
      out += moveTo(r + 1 + i, c) + paintBorder(ch.v) + lineStr + paintBorder(ch.v);
    }
    out += moveTo(r + h - 1, c) + paintBorder(ch.bl + ch.h.repeat(innerW) + ch.br);

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

    if (kind === 'm') {
      dragState = null;
      continue;
    }

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

    // Mouse drag while left button held (btn === 32)
    if (btn === 32 && dragState) {
      if (dragState.kind === 'resize-sidebar') {
        customSidebarW = Math.max(16, Math.min(lastLayout.cols - 24, col));
        statusBanner = ` Ancho panel lateral: ${customSidebarW}`;
        scheduleRender();
      } else if (dragState.kind === 'resize-grid-x') {
        splitRatioX = Math.max(0.2, Math.min(0.8, (col - lastLayout.gridX) / lastLayout.gridW));
        scheduleRender();
      } else if (dragState.kind === 'resize-grid-y') {
        splitRatioY = Math.max(0.2, Math.min(0.8, (row - 2) / lastLayout.bodyH));
        scheduleRender();
      } else if (dragState.kind === 'move-pane') {
        if (Math.abs(col - dragState.startCol) > 1 || Math.abs(row - dragState.startRow) > 0) {
          dragState.moved = true;
        }
        if (dragState.moved) {
          const targetCard = col < lastLayout.sidebarW && lastSidebarCards.find(c => row >= c.rStart && row <= c.rEnd);
          const targetBox = col >= lastLayout.gridX && lastGridBoxes.find(b => col >= b.c && col < b.c + b.w && row >= b.r && row < b.r + b.h);
          const targetId = targetCard ? targetCard.id : (targetBox ? targetBox.id : null);
          if (targetId && targetId !== dragState.paneId && swapPanes(dragState.paneId, targetId)) {
            focusedId = dragState.paneId;
            statusBanner = ' Panel reordenado';
            scheduleRender();
          }
        }
      }
      continue;
    }

    if (btn !== 0) continue;

    // 1. Check divider hits for resizing sections
    if (row >= 2 && row < lastLayout.rows) {
      if (Math.abs(col - lastLayout.sidebarW) <= 1) {
        dragState = { kind: 'resize-sidebar' };
        continue;
      }
      if (lastGridBoxes.length >= 2 && Math.abs(col - lastGridBoxes[1].c) <= 1) {
        dragState = { kind: 'resize-grid-x' };
        continue;
      }
      if (lastGridBoxes.length >= 3) {
        const hSplitRow = lastGridBoxes[2].r;
        const hMinCol = lastGridBoxes.length === 3 ? lastGridBoxes[1].c : lastLayout.gridX;
        if (Math.abs(row - hSplitRow) <= 1 && col >= hMinCol) {
          dragState = { kind: 'resize-grid-y' };
          continue;
        }
      }
    }

    for (const card of lastSidebarCards) {
      if (row >= card.rStart && row <= card.rEnd && col < lastLayout.sidebarW) {
        focusedId = card.id;
        dragState = { kind: 'move-pane', paneId: card.id, startCol: col, startRow: row, moved: false };
        const p = panes.get(focusedId);
        if (p) {
          p.clearAlerts();
          if (row === card.pillRow && col >= card.pillColStart && col <= card.pillColEnd) {
            const next = GROUP_ORDER[(GROUP_ORDER.indexOf(p.group) + 1) % GROUP_ORDER.length];
            p.group = next;
            statusBanner = ` [${p.role}] -> ${GROUPS[next].label}`;
            saveSessionState();
          }
        }
        scheduleRender();
        break;
      }
    }
    for (const box of lastGridBoxes) {
      if (col >= box.c && col < box.c + box.w && row >= box.r && row < box.r + box.h) {
        focusedId = box.id;
        if (row === box.r && !(col >= box.hdrGroupStart && col <= box.hdrGroupEnd)) {
          dragState = { kind: 'move-pane', paneId: box.id, startCol: col, startRow: row, moved: false };
        }
        const p = panes.get(focusedId);
        if (p) {
          p.clearAlerts();
          if (row === box.r && col >= box.hdrGroupStart && col <= box.hdrGroupEnd) {
            const next = GROUP_ORDER[(GROUP_ORDER.indexOf(p.group) + 1) % GROUP_ORDER.length];
            p.group = next;
            statusBanner = ` [${p.role}] -> ${GROUPS[next].label}`;
            saveSessionState();
          }
        }
        scheduleRender();
        break;
      }
    }
  }
  return handled;
}

function handleKeyInput(buf) {
  const str = buf.toString('utf8');
  if (str.includes('\x1b[<') && handleMouse(str)) return;

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
      if (panes.size === 0) {
        createPane({ role: 'Agente Principal', cwd: process.cwd(), group: 'isolated', autoAgy: true });
      }
      statusBanner = ' Sesión iniciada desde cero con agy.';
      scheduleRender();
      return;
    }
    return;
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
  if (str === '\x1b[18~') { // F7: close pane
    const p = panes.get(focusedId);
    if (p) { clearTimeout(p.idleTimer); p.kill(); panes.delete(p.id); saveSessionState(); events.emit('state'); }
    return;
  }
  if (str === '\t' || str === '\x1b\t' || str === '\x1b[Z') { // Tab / Alt+Tab / Shift+Tab: switch focus
    const keys = Array.from(panes.keys());
    if (keys.length > 1) {
      const step = str === '\x1b[Z' ? -1 : 1;
      focusedId = keys[(keys.indexOf(focusedId) + step + keys.length) % keys.length];
      const p = panes.get(focusedId);
      if (p) p.clearAlerts();
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
    if (str.includes('\r') || str.includes('\n')) {
      p.markCommandStart();
      p.status = 'Running';
    } else {
      p.clearAlerts();
    }
    p.write(str);
  }
}

function cleanupAndExit() {
  saveSessionState();
  process.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  for (const p of panes.values()) p.kill();
  process.exit(0);
}

async function main() {
  pendingRestore = loadPreviousSession();
  await startServer(undefined, { noDefaultPane: Boolean(pendingRestore) });
  if (pendingRestore) {
    const names = pendingRestore.panes.map(p => p.role).slice(0, 3).join(', ');
    notifyWindows('/deck · Sesión anterior encontrada', `¿Quieres restaurar ${pendingRestore.panes.length} paneles (${names})? Presiona [S] en /deck.`);
  }
  setInterval(saveSessionState, 15000).unref();
  setInterval(scheduleRender, 5000).unref();
  refreshModelQuota({ force: true });
  setInterval(() => refreshModelQuota(), 45000).unref();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleKeyInput);
  // Enable alt-screen and SGR button-event mouse tracking AFTER setRawMode(true) so libuv doesn't reset console flags on Windows
  process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  setTimeout(() => process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h'), 300);
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
