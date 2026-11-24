const assert = require('assert');
process.env.DECK_NO_DEFAULT_PANE = '1';
process.env.DECK_NO_STATE = '1';
const { createPane, sendGroupMessage, findPane, restorePreviousSession, startServer, panes, GROUPS, commLog } = require('./server');

// 1. Default isolation check
const pUsb = createPane({ role: 'Resetear USB', group: 'isolated' });
const pResearch = createPane({ role: 'Investigar Paper', group: 'isolated' });
assert.strictEqual(pUsb.group, 'isolated');
assert.strictEqual(pResearch.group, 'isolated');

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

// 7. startServer with noDefaultPane leaves panes empty until user chooses [S] or [N]
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
