const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECK_NO_DEFAULT_PANE = '1';
process.env.DECK_NO_STATE = '1';
const { createPane, sendGroupMessage, findPane, swapPanes, restorePreviousSession, startServer, panes, GROUPS, commLog, scanModelUsage, formatModelName, formatCompactTokens, summarizeQuotaPayload } = require('./server');

// 1. Default isolation check
const pUsb = createPane({ role: 'Resetear USB', group: 'isolated' });
const pResearch = createPane({ role: 'Investigar Paper', group: 'isolated' });
assert.strictEqual(pUsb.group, 'isolated');
assert.strictEqual(pResearch.group, 'isolated');
assert.strictEqual(pUsb.done, false, 'Fresh pane must not be marked done');
assert.strictEqual(pUsb.hasCommand, false, 'Fresh pane must not have an active command');
pUsb.markCommandStart();
assert.strictEqual(pUsb.hasCommand, true);
pUsb.clearAlerts();
assert.strictEqual(pUsb.hasCommand, false);
assert.strictEqual(pUsb.done, false);

// 2. Blocked message between isolated panes
const blocked1 = sendGroupMessage({ fromId: pUsb.id, toTarget: 'Investigar Paper', text: 'hola' });
assert.strictEqual(blocked1.ok, false, 'Isolated panes must NEVER communicate');

// 3. Group color linking (Grupo A vs Grupo B)
const pFront = createPane({ role: 'front', group: 'A' });
const pBack = createPane({ role: 'back', group: 'A' });
const pOther = createPane({ role: 'otro', group: 'B' });

assert.strictEqual(GROUPS[pFront.group].color, '#10b981');
assert.strictEqual(GROUPS[pOther.group].color, '#f59e0b');

// 4. Cross-group communication blocked
const blockedCross = sendGroupMessage({ fromId: pFront.id, toTarget: 'otro', text: 'leak' });
assert.strictEqual(blockedCross.ok, false, 'Different groups must not communicate');

// 5. Same-group communication succeeds without /btw and includes autonomous reply hint
pBack.status = 'Waiting';
pBack.wasAgy = true;
const allowed = sendGroupMessage({ fromId: pFront.id, toTarget: 'back', text: 'Necesito endpoint /users' });
assert.strictEqual(allowed.ok, true, 'Same group panes must communicate');
assert.strictEqual(allowed.to, 'back');
assert.ok(!allowed.formatted.startsWith('/btw'), 'agy panes must NOT receive /btw prefix');
assert.ok(allowed.formatted.startsWith('[DECK de front (Grupo A)]: '), 'agy panes must receive direct DECK prompt');
assert.ok(allowed.formatted.includes('send "front"') && allowed.formatted.includes('--reply'), 'agy panes must receive autonomous reply instruction');
assert.ok(commLog.some(e => e.from === 'front' && e.to === 'back'), 'commLog must record peer messages');

// 5a. Reply messages omit the reply hint to avoid infinite ping-pong
pFront.status = 'Waiting';
pFront.wasAgy = true;
const replyMsg = sendGroupMessage({ fromId: pBack.id, toTarget: 'front', text: 'Listo, endpoint creado', reply: true });
assert.strictEqual(replyMsg.ok, true);
assert.ok(!replyMsg.formatted.includes('--reply'), 'Reply messages must not ask for another reply');

// 5b. Self-send is blocked
const selfBlocked = sendGroupMessage({ fromId: pFront.id, toTarget: 'front', text: 'eco' });
assert.strictEqual(selfBlocked.ok, false, 'Self-send must be blocked');

// 5c. Swapping panes updates order in-place
const swapped = swapPanes(pFront.id, pBack.id);
assert.strictEqual(swapped, true);
const idsAfterSwap = Array.from(panes.keys());
assert.ok(idsAfterSwap.indexOf(pBack.id) < idsAfterSwap.indexOf(pFront.id), 'swapPanes must reorder panes');

// 6. Restore preserves conversationId per pane without duplicating --continue
const restoredCount = restorePreviousSession({
  panes: [
    { role: 'A1', cwd: process.cwd(), group: 'A', wasAgy: true, conversationId: 'conv-111' },
    { role: 'A2', cwd: process.cwd(), group: 'A', wasAgy: true, conversationId: 'conv-222', remoteControl: true }
  ]
});
assert.strictEqual(restoredCount, 2);
const restoredList = Array.from(panes.values());
assert.strictEqual(restoredList[0].conversationId, 'conv-111');
assert.strictEqual(restoredList[1].conversationId, 'conv-222');
assert.strictEqual(restoredList[1].remoteControl, true);

// 7. Model usage scanner aggregates today's and 7-day weekly tokens per model accurately
const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-brain-'));
const convLogDir = path.join(tmpBrain, 'conv-test-1', '.system_generated', 'logs');
fs.mkdirSync(convLogDir, { recursive: true });
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const threeDaysAgoIso = new Date(nowMs - 3 * 86400000).toISOString();
const tenDaysAgoIso = new Date(nowMs - 10 * 86400000).toISOString();
fs.writeFileSync(path.join(convLogDir, 'transcript.jsonl'), [
  JSON.stringify({ model: 'gemini-4-carbon-medium', input_tokens: 12000, output_tokens: 3000, cache_read_tokens: 50000, created_at: nowIso }),
  JSON.stringify({ model: 'gemini-4-carbon-medium', input_tokens: 8000, output_tokens: 2000, cache_read_tokens: 60000, created_at: nowIso }),
  JSON.stringify({ model: 'gemini-4-hydrogen-high', input_tokens: 4000, output_tokens: 1000, cache_read_tokens: 0, created_at: nowIso }),
  JSON.stringify({ model: 'gemini-4-hydrogen-high', input_tokens: 9000, output_tokens: 1000, cache_read_tokens: 0, created_at: threeDaysAgoIso }),
  JSON.stringify({ model: 'gemini-4-argon-medium', input_tokens: 50000, output_tokens: 5000, cache_read_tokens: 0, created_at: tenDaysAgoIso })
].join('\n'));
const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
const usage = scanModelUsage({ brainDirs: [tmpBrain], sinceMs: startOfToday.getTime(), weekSinceMs: nowMs - 7 * 86400000 });
assert.strictEqual(usage.models.length, 2, 'Today should detect 2 distinct models');
assert.strictEqual(usage.models[0].label, 'G4 Carbon (M)');
assert.strictEqual(usage.models[0].turns, 2);
assert.strictEqual(usage.models[0].activeTokens, 25000);
assert.strictEqual(usage.models[1].label, 'G4 Hydrogen (H)');
assert.strictEqual(usage.models[1].activeTokens, 5000);
assert.strictEqual(usage.week.models.length, 2, '7-day week should exclude 10-day-old entries');
assert.strictEqual(usage.week.totalActive, 40000, '7-day week should total 40k active tokens');
assert.strictEqual(formatCompactTokens(25000), '25k');
assert.strictEqual(formatModelName('claude-sonnet-5-5-medium').label, 'Sonnet 5.5 (M)');
fs.rmSync(tmpBrain, { recursive: true, force: true });

// 7b. Quota summarizer computes remaining percentages and pools accurately
const quotaSummary = summarizeQuotaPayload({
  userStatus: {
    planStatus: { planInfo: { planName: 'Pro' }, availablePromptCredits: 500, availableFlowCredits: 100 },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 4 Neon (High)', quotaInfo: { remainingFraction: 0.3899, resetTime: '2026-11-25T02:55:47Z' } },
        { label: 'Claude Sonnet 5.5 (Medium)', quotaInfo: { remainingFraction: 0.3408, resetTime: '2026-11-30T19:35:34Z' } }
      ]
    }
  }
});
assert.strictEqual(quotaSummary.planName, 'Pro');
assert.strictEqual(quotaSummary.promptCredits, 500);
assert.strictEqual(quotaSummary.pools[0].label, 'Gemini 4 / Flash');
assert.strictEqual(quotaSummary.pools[0].remainingPct, 39);
assert.strictEqual(quotaSummary.pools[1].label, 'Claude / GPT');
assert.strictEqual(quotaSummary.pools[1].remainingPct, 34);

// 8. startServer with noDefaultPane leaves panes empty until user chooses [S] or [N]
(async () => {
  for (const p of panes.values()) p.kill();
  panes.clear();
  delete process.env.DECK_NO_DEFAULT_PANE;
  const srv = await startServer(0, { noDefaultPane: true });
  assert.strictEqual(panes.size, 0, 'noDefaultPane must not spawn a default pane');
  srv.close();
  console.log('ALL TESTS PASSED: isolation, roles, group colors, same-group messaging, and session restore verified.');
  process.exit(0);
})();
