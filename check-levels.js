// Checks every Shepherd level by playing its built-in solution with the real physics.
//
//   node check-levels.js          check all levels
//   node check-levels.js w1-3     check only levels whose id starts with "w1-3"
//
// A level passes when:
//   1. its layout is sensible (things inside the play area, the solution fits the tray,
//      no solution shepherd sits somewhere the player could not put it),
//   2. with no shepherds at all, the missile misses,
//   3. the built-in solution hits the target,
//   4. it still hits when each shepherd is nudged a little (so it is not a pixel-perfect fluke),
//   5. every shepherd in the solution is needed (taking any one away makes it miss).

const fs = require('fs');
const path = require('path');
const P = require('./physics.js');

const dir = path.join(__dirname, 'levels');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) require(path.join(dir, f));
const prefix = process.argv[2] || '';
const levels = (globalThis.LEVELS || []).filter(l => l.id.startsWith(prefix));

const NUDGE_POS = 3;        // pixels
const NUDGE_SPEED = 0.02;   // 2 %
const NUDGE_ANGLE = 1;      // degrees

// All the slightly-off versions of one shepherd.
function nudges(s) {
  const out = [];
  for (const [dx, dy] of [[NUDGE_POS, 0], [-NUDGE_POS, 0], [0, NUDGE_POS], [0, -NUDGE_POS]])
    out.push({ ...s, x: s.x + dx, y: s.y + dy });
  if (!P.TYPES[s.type].fixed && Math.hypot(s.vx || 0, s.vy || 0) > 0) {
    for (const k of [1 + NUDGE_SPEED, 1 - NUDGE_SPEED]) out.push({ ...s, vx: s.vx * k, vy: s.vy * k });
    for (const deg of [NUDGE_ANGLE, -NUDGE_ANGLE]) {
      const a = deg * Math.PI / 180, c = Math.cos(a), n = Math.sin(a);
      out.push({ ...s, vx: s.vx * c - s.vy * n, vy: s.vx * n + s.vy * c });
    }
  }
  return out;
}

function check(level) {
  const problems = [];
  const sol = level.solution || [];
  const inArea = (o, what) => {
    if (Math.abs(o.x) > P.AREA.x || Math.abs(o.y) > P.AREA.y) problems.push(what + ' is outside the play area');
  };
  inArea(level.silo, 'silo');
  inArea(level.target, 'target');
  (level.bodies || []).forEach((b, i) => { if (b.fixed) inArea(b, 'body ' + i); });

  // The solution must fit the tray and sit where the player may build.
  const used = {};
  sol.forEach((s, i) => {
    if (!P.TYPES[s.type]) { problems.push(`solution shepherd ${i} has unknown type "${s.type}"`); return; }
    used[s.type] = (used[s.type] || 0) + 1;
    const why = P.whyNotBuildable(level, s.type, s.x, s.y);
    if (why) problems.push(`solution shepherd ${i} is ${why}`);
    if (Math.hypot(s.vx || 0, s.vy || 0) > P.MAX_FLING + 0.01) problems.push(`solution shepherd ${i} is flung too fast`);
  });
  for (const t in used) if (used[t] > ((level.tray || {})[t] || 0)) problems.push(`solution uses more ${t}s than the tray has`);
  if (sol.length !== level.par) problems.push(`par is ${level.par} but the solution uses ${sol.length} shepherds`);
  if (!sol.length) problems.push('there is no solution');
  if (problems.length) return problems;

  const empty = P.runPass(level, []);
  if (empty.result === 'hit') problems.push('the missile hits the target with no shepherds at all');

  const main = P.runPass(level, sol);
  if (main.result !== 'hit') {
    problems.push(`the solution does not hit (${main.result}, closest ${main.closest.toFixed(1)})`);
    return problems;
  }
  if (main.time < 1.5) problems.push(`the flight is very short (${main.time.toFixed(1)} s)`);

  let bad = 0, total = 0;
  sol.forEach((s, i) => {
    for (const n of nudges(s)) {
      total++;
      const r = P.runPass(level, sol.map((o, j) => j === i ? n : o));
      if (r.result !== 'hit') bad++;
    }
  });
  if (bad) problems.push(`the solution is fragile: ${bad} of ${total} small nudges make it miss`);

  if (sol.length > 1) sol.forEach((s, i) => {
    if (P.runPass(level, sol.filter((o, j) => j !== i)).result === 'hit')
      problems.push(`solution shepherd ${i} (${s.type}) is not needed`);
  });
  return problems;
}

if (!levels.length) { console.log('No levels found.'); process.exit(1); }
let failed = 0;
for (const level of levels) {
  const problems = check(level);
  if (problems.length) {
    failed++;
    console.log(`FAIL  ${level.id}  ${level.name}`);
    for (const p of problems) console.log('        - ' + p);
  } else {
    const r = P.runPass(level, level.solution);
    console.log(`ok    ${level.id}  ${level.name}  (${r.time.toFixed(1)} s, ${level.solution.length} shepherds)`);
  }
}
console.log(failed ? `\n${failed} of ${levels.length} levels failed.` : `\nAll ${levels.length} levels pass.`);
process.exit(failed ? 1 : 0);
