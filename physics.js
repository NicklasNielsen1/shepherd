// Shepherd: the gravity maths, shared by the game (index.html) and the level checker
// (check-levels.js). It has no drawing code, so it runs in the browser and in Node.
// Adapted from Slingshot's physics.js.
//
// ---------------------------------------------------------------------------------
// LEVEL FORMAT
// ---------------------------------------------------------------------------------
// The play area is 1200 wide and 800 tall, with (0, 0) in the middle:
//   x runs from -600 (left) to 600 (right), y from -400 (top) to 400 (bottom).
// A missile that goes past x = +/-750 or y = +/-500 is lost.
//
// {
//   id: 'w1-1',
//   name: 'First Nudge',
//   hint: 'One short sentence shown to the player.',
//   silo: { x: -500, y: 0, vx: 120, vy: 0 },   // where the missile starts, and how it flies off
//   target: { x: 450, y: -200, r: 30 },        // ring to reach; r is its radius
//   bodies: [                                  // the level's own stars and planets
//     { x: 0, y: 100, m: 400000, fixed: true, color: '#ffe28a' },   // stays still
//     { x: 0, y: -50, m: 2000, vx: 50, vy: 0 },                     // moves under gravity
//   ],
//   walls: [ { x1: 100, y1: -400, x2: 100, y2: 50 } ],   // the missile explodes on these
//   zones: [ { x: 300, y: -400, w: 300, h: 400 } ],      // no-build areas: x, y is the top-left corner
//   tray: { anchor: 2, runner: 1, pusher: 0 },           // how many of each shepherd the player gets
//   par: 1,                                              // shepherds allowed for 3 stars
//   solution: [                                          // a set-up that wins; used for testing
//     { type: 'anchor', x: 200, y: -250 },
//     { type: 'runner', x: -100, y: 300, vx: 80, vy: -40 },
//   ],
//
//   // Optional extras, each introduced by a later world:
//   dust: [ { x: 100, y: -80 } ],              // world 2: stardust. Every speck must be collected
//                                              //   before the ring counts.
//   silos: [                                   // world 3: use this INSTEAD of "silo" for two missiles.
//     { x: -500, y: -100, vx: 120, vy: 0 },    //   All of them must reach the ring.
//     { x: -500, y: 100, vx: 120, vy: 0, delay: 1.5 },   // delay: fires this many seconds late
//   ],
// }
//
// Shepherds are the gravity objects the player puts down (see TYPES below):
// - anchor: heavy and fixed in place.
// - runner: moves. The player flings it, up to MAX_FLING fast.
// - pusher: pushes things away instead of pulling. It can be flung too.
//
// Rules of the physics:
// - The missile has no mass: everything pulls (or pushes) it, it affects nothing.
// - All bodies and shepherds act on each other, except fixed ones, which never move.
// - A moving shepherd is destroyed if it touches a body, another shepherd or a wall.
// - The missile explodes if it touches a body, a shepherd or a wall.
// - With several missiles, the pass fails as soon as one of them is destroyed or lost.
// - Time moves in fixed steps of DT, so the same set-up always gives the same result.
// ---------------------------------------------------------------------------------

(function (root) {
  const DT = 1 / 120;          // seconds per physics step
  const MAX_TIME = 15;         // seconds before a pass is called off
  const MAX_FLING = 200;       // fastest a shepherd can be flung
  const SOFT = 4;              // stops gravity becoming infinite at zero distance
  const BOUNDS = { x: 750, y: 500 };
  const AREA = { x: 600, y: 400 };
  const MISSILE_R = 3;
  const DUST_R = 14;           // how close the missile must pass to collect a speck of stardust

  const TYPES = {
    anchor: { name: 'Anchor', m: 500000, fixed: true, color: '#ffe28a' },
    runner: { name: 'Runner', m: 250000, fixed: false, color: '#5fd0ff' },
    pusher: { name: 'Pusher', m: -400000, fixed: false, color: '#b44dff' },
  };

  // Size on screen grows slowly with mass.
  const radiusFor = m => Math.max(1.5, 0.4 * Math.pow(Math.abs(m), 0.28));

  function clampFling(vx, vy) {
    const s = Math.hypot(vx, vy);
    if (s > MAX_FLING) { vx *= MAX_FLING / s; vy *= MAX_FLING / s; }
    return { vx, vy };
  }

  // A level has either one "silo" or a list of "silos". This always gives a list.
  const silosOf = level => level.silos || [level.silo];

  // Shortest distance from point (px, py) to the wall w.
  function wallDist(px, py, w) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / l2));
    return Math.hypot(w.x1 + t * dx - px, w.y1 + t * dy - py);
  }

  // Did something moving from (x0, y0) to (x1, y1) cross the wall w?
  function crossesWall(x0, y0, x1, y1, w) {
    const rx = x1 - x0, ry = y1 - y0, sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((w.x1 - x0) * sy - (w.y1 - y0) * sx) / den;
    const u = ((w.x1 - x0) * ry - (w.y1 - y0) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  // May a shepherd of this type be put at (x, y)? Returns '' if yes, or the reason why not.
  function whyNotBuildable(level, type, x, y) {
    const r = radiusFor(TYPES[type].m);
    if (Math.abs(x) > AREA.x - r || Math.abs(y) > AREA.y - r) return 'outside the play area';
    for (const z of level.zones || [])
      if (x > z.x - r && x < z.x + z.w + r && y > z.y - r && y < z.y + z.h + r) return 'inside a no-build zone';
    for (const s of silosOf(level)) if (Math.hypot(x - s.x, y - s.y) < r + 45) return 'too close to the silo';
    for (const d of level.dust || []) if (Math.hypot(x - d.x, y - d.y) < r + DUST_R + 4) return 'too close to the stardust';
    if (Math.hypot(x - level.target.x, y - level.target.y) < r + level.target.r + 10) return 'too close to the target';
    for (const b of level.bodies || [])
      if (Math.hypot(x - b.x, y - b.y) < r + radiusFor(b.m) + 10) return 'too close to a planet or star';
    for (const w of level.walls || []) if (wallDist(x, y, w) < r + 6) return 'too close to a wall';
    return '';
  }

  // A fresh pass: the level's bodies, the player's shepherds, and the missile on its way.
  function createPass(level, shepherds) {
    const things = [];
    for (const b of level.bodies || [])
      things.push({ x: b.x, y: b.y, vx: b.vx || 0, vy: b.vy || 0, m: b.m, fixed: !!b.fixed,
        r: radiusFor(b.m), color: b.color || null, shepherd: null, dead: false, ax: 0, ay: 0 });
    (shepherds || []).forEach((s, i) => {
      const t = TYPES[s.type], v = t.fixed ? { vx: 0, vy: 0 } : clampFling(s.vx || 0, s.vy || 0);
      things.push({ x: s.x, y: s.y, vx: v.vx, vy: v.vy, m: t.m, fixed: t.fixed,
        r: radiusFor(t.m), color: t.color, shepherd: s.type, index: i, dead: false, ax: 0, ay: 0 });
    });
    // done: 'hit' once that missile has reached the ring. delay: seconds before it fires.
    const missiles = silosOf(level).map(s => ({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, ax: 0, ay: 0, delay: s.delay || 0, done: null }));
    return {
      level, things, missiles,
      missile: missiles[0],    // handy when there is only one
      dust: (level.dust || []).map(d => ({ x: d.x, y: d.y, got: false })),
      t: 0, result: null,      // 'hit' | 'crash' | 'lost' | 'timeout' once the pass ends
      failed: null,            // the missile that ended the pass by crashing or getting lost
      events: [],              // things that just happened, for the game to draw sparks
    };
  }

  // Work out the pull (or push) on everything that moves.
  function accelerations(state, flying) {
    const live = state.things.filter(b => !b.dead);
    for (const b of live) { b.ax = 0; b.ay = 0; }
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + SOFT * SOFT;
        const inv = 1 / (d2 * Math.sqrt(d2));
        a.ax += b.m * dx * inv; a.ay += b.m * dy * inv;      // a negative mass pushes
        b.ax -= a.m * dx * inv; b.ay -= a.m * dy * inv;
      }
    }
    for (const p of flying) {
      p.ax = 0; p.ay = 0;
      for (const b of live) {
        const dx = b.x - p.x, dy = b.y - p.y;
        const d2 = dx * dx + dy * dy + SOFT * SOFT;
        const inv = b.m / (d2 * Math.sqrt(d2));
        p.ax += dx * inv; p.ay += dy * inv;
      }
    }
  }

  // Move time forward by one step of DT ("leapfrog": half-kick, move, half-kick).
  function stepPass(state) {
    if (state.result) return state.result;
    const walls = state.level.walls || [];
    const bodies = state.things.filter(b => !b.dead && !b.fixed);
    const before = bodies.map(b => [b.x, b.y]);
    // state.noMissile is set by the game when it only wants to know where the shepherds go.
    const flying = state.noMissile ? [] : state.missiles.filter(m => !m.done && state.t >= m.delay);
    const from = flying.map(m => [m.x, m.y]);
    const movers = bodies.concat(flying);

    accelerations(state, flying);
    for (const o of movers) {
      o.vx += o.ax * DT / 2; o.vy += o.ay * DT / 2;
      o.x += o.vx * DT; o.y += o.vy * DT;
    }
    accelerations(state, flying);
    for (const o of movers) { o.vx += o.ax * DT / 2; o.vy += o.ay * DT / 2; }
    state.t += DT;

    // Moving shepherds are destroyed by walls, by leaving space, and by touching anything.
    const live = state.things.filter(b => !b.dead);
    bodies.forEach((b, i) => {
      if (!b.shepherd) return;
      const hitWall = walls.some(w => crossesWall(before[i][0], before[i][1], b.x, b.y, w));
      const gone = Math.abs(b.x) > BOUNDS.x || Math.abs(b.y) > BOUNDS.y;
      const bump = live.some(c => c !== b && !c.dead && Math.hypot(c.x - b.x, c.y - b.y) < c.r + b.r);
      if (hitWall || gone || bump) { b.dead = true; if (!gone) state.events.push({ type: 'shepherd', x: b.x, y: b.y }); }
    });

    // Each missile in flight: collect stardust, then see whether it crashed, arrived or got lost.
    const tg = state.level.target;
    flying.forEach((p, i) => {
      for (const d of state.dust)
        if (!d.got && Math.hypot(d.x - p.x, d.y - p.y) < DUST_R) { d.got = true; state.events.push({ type: 'dust', x: d.x, y: d.y }); }
      let end = null;
      if (state.things.some(b => !b.dead && Math.hypot(b.x - p.x, b.y - p.y) < b.r + MISSILE_R)) end = 'crash';
      else if (walls.some(w => crossesWall(from[i][0], from[i][1], p.x, p.y, w))) end = 'crash';
      else if (Math.hypot(tg.x - p.x, tg.y - p.y) < tg.r && state.dust.every(d => d.got)) { p.done = 'hit'; state.events.push({ type: 'hit', x: p.x, y: p.y }); }
      else if (Math.abs(p.x) > BOUNDS.x || Math.abs(p.y) > BOUNDS.y) end = 'lost';
      if (end && !state.result) { state.result = end; state.failed = p; }
    });
    if (!state.result) {
      if (!state.noMissile && state.missiles.every(m => m.done)) state.result = 'hit';
      else if (state.t >= MAX_TIME) state.result = 'timeout';
    }
    return state.result;
  }

  // Play one whole pass and say how it ended. Used for testing and searching.
  // "closest" is a rough "how far from winning" number: 0 for a hit, smaller is nearer.
  function runPass(level, shepherds) {
    const state = createPass(level, shepherds);
    const tg = level.target;
    const toTarget = state.missiles.map(() => Infinity), toDust = state.dust.map(() => Infinity);
    const look = () => {
      state.missiles.forEach((m, i) => { if (!m.done) toTarget[i] = Math.min(toTarget[i], Math.hypot(tg.x - m.x, tg.y - m.y)); });
      state.dust.forEach((d, j) => { if (!d.got) for (const m of state.missiles) toDust[j] = Math.min(toDust[j], Math.hypot(d.x - m.x, d.y - m.y)); });
    };
    look();
    while (!stepPass(state)) look();
    let closest = 0;
    state.missiles.forEach((m, i) => { if (!m.done) closest += toTarget[i]; });
    state.dust.forEach((d, j) => { if (!d.got) closest += 300 + toDust[j]; });
    return { result: state.result, time: state.t, closest, dust: state.dust.filter(d => d.got).length };
  }

  const api = { DT, MAX_TIME, MAX_FLING, SOFT, BOUNDS, AREA, MISSILE_R, DUST_R, TYPES,
    radiusFor, clampFling, wallDist, silosOf, whyNotBuildable, createPass, stepPass, runPass };
  root.ShepherdPhysics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
