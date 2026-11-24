const assert = require('assert');
process.env.DECK_NO_DEFAULT_PANE = '1';
const { createPane, sendGroupMessage, findPane, panes, GROUPS } = require('./server');

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

// 5. Same-group communication succeeds
pBack.status = 'Waiting';
const allowed = sendGroupMessage({ fromId: pFront.id, toTarget: 'back', text: 'Necesito endpoint /users' });
assert.strictEqual(allowed.ok, true, 'Same group panes must communicate');
assert.strictEqual(allowed.to, 'back');

// Cleanup processes
for (const p of panes.values()) p.kill();
console.log('ALL TESTS PASSED: isolation, roles, group colors, and same-group messaging verified.');
process.exit(0);
