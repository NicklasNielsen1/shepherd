// Shepherd: the gravity maths, shared by the game (index.html) and the level checker
// (check-levels.js). It has no drawing code, so it runs in the browser and in Node.
// Adapted from Slingshot's physics.js.
//
// ---------------------------------------------------------------------------------
// HOW THE GAME RUNS
// ---------------------------------------------------------------------------------
// Each silo fires a steady stream of missiles (one every FIRE_EVERY seconds). The player's
// shepherds bend the stream. Every missile that reaches the ring adds 1 charge; the charge
// leaks away at LEAK per second. The level is won when the charge reaches the level's goal.
// Every BEAT seconds all moving things (Runners, flung Pushers, moving planets) jump back
// to where they started: the "heartbeat". Missiles are never reset.
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
//   silo: { x: -500, y: 0, vx: 120, vy: 0 },   // where missiles start, and how they fly off
//   target: { x: 450, y: -200, r: 30 },        // ring to reach; r is its radius
//   bodies: [                                  // the level's own stars and planets
//     { x: 0, y: 100, m: 400000, fixed: true, color: '#ffe28a' },   // stays still
//     { x: 0, y: -50, m: 2000, vx: 50, vy: 0 },                     // moves under gravity
//   ],
//   walls: [ { x1: 100, y1: -400, x2: 100, y2: 50 } ],   // missiles explode on these
//   zones: [ { x: 300, y: -400, w: 300, h: 400 } ],      // no-build areas: x, y is the top-left corner
//   tray: { anchor: 2, runner: 1, pusher: 0 },           // how many of each shepherd the player gets
//   par: 1,                                              // shepherds allowed for 3 stars
//   solution: [                                          // a set-up that wins; used for testing
//     { type: 'anchor', x: 200, y: -250 },
//     { type: 'runner', x: -100, y: 300, vx: 80, vy: -40 },
//   ],
//
//   // Optional extras:
//   goal: 8,                                   // charge needed to win (GOAL if left out)
//   dust: [ { x: 100, y: -80 } ],              // world 2: stardust. A missile only counts in the
//                                              //   ring if it flew through every speck itself.
//   silos: [                                   // world 3: use this INSTEAD of "silo" for two streams.
//     { x: -500, y: -100, vx: 120, vy: 0 },    //   Each silo has its own charge meter, and all
//     { x: -500, y: 100, vx: 120, vy: 0 },     //   meters must be full at the same time.
//   ],
// }
//
// Shepherds are the gravity objects the player puts down (see TYPES below):
// - anchor: heavy and fixed in place.
// - runner: moves. The player flings it, up to MAX_FLING fast.
// - pusher: pushes things away instead of pulling. It can be flung too.
//
// Rules of the physics:
// - Missiles have no mass: everything pulls (or pushes) them, they affect nothing.
// - All bodies and shepherds act on each other, except fixed ones, which never move.
// - A moving shepherd is destroyed if it touches a body, another shepherd or a wall.
//   It comes back at the next heartbeat.
// - A missile explodes if it touches a body, a shepherd or a wall.
// - Time moves in fixed steps of DT, so the same set-up always gives the same result.
// ---------------------------------------------------------------------------------

(function (root) {
  const DT = 1 / 120;          // seconds per physics step
  const FIRE_EVERY = 0.25;     // seconds between missiles from one silo
  const BEAT = 6;              // seconds between heartbeats
  const GOAL = 12;             // charge needed to win, unless the level says otherwise
  const LEAK = 0.5;            // charge lost per second
  const MAX_AGE = 15;          // a missile that flies this long without getting anywhere fizzles out
  const MAX_FLING = 200;       // fastest a shepherd can be flung
  const SOFT = 4;              // stops gravity becoming infinite at zero distance
  const BOUNDS = { x: 750, y: 500 };
  const AREA = { x: 600, y: 400 };
  const MISSILE_R = 3;
  const DUST_R = 14;           // how close a missile must pass to collect a speck of stardust

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
  const goalOf = level => level.goal || GOAL;

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

  // The level's bodies plus the player's shepherds, each remembering where it starts (x0, y0, ...)
  // so the heartbeat can put it back.
  function buildThings(level, shepherds) {
    const things = [];
    const add = o => things.push({ ...o, x0: o.x, y0: o.y, vx0: o.vx, vy0: o.vy, dead: false, ax: 0, ay: 0 });
    for (const b of level.bodies || [])
      add({ x: b.x, y: b.y, vx: b.vx || 0, vy: b.vy || 0, m: b.m, fixed: !!b.fixed, r: radiusFor(b.m), color: b.color || null, shepherd: null });
    (shepherds || []).forEach((s, i) => {
      const t = TYPES[s.type], v = t.fixed ? { vx: 0, vy: 0 } : clampFling(s.vx || 0, s.vy || 0);
      add({ x: s.x, y: s.y, vx: v.vx, vy: v.vy, m: t.m, fixed: t.fixed, r: radiusFor(t.m), color: t.color, shepherd: s.type, index: i });
    });
    return things;
  }

  // A fresh stream: nothing in the air yet, no charge.
  function createStream(level, shepherds) {
    const silos = silosOf(level);
    return {
      level, things: buildThings(level, shepherds),
      missiles: [],              // in the air: {x, y, vx, vy, silo, born, got: [true/false per speck]}
      t: 0, nextFire: 0, beatStart: 0,
      charge: silos.map(() => 0), goal: goalOf(level),
      hits: silos.map(() => 0), fired: 0,
      won: false, wonAt: null,
      noMissiles: false,         // the game sets this to see only where the shepherds go
      events: [],                // things that just happened, for the game to draw sparks and play sounds
    };
  }

  // The player changed the shepherds while the stream is running. Missiles in the air stay.
  // If only still shepherds were moved, the moving ones carry on undisturbed; otherwise
  // everything that moves starts its beat again.
  function setShepherds(state, shepherds) {
    const old = state.things.filter(t => t.shepherd);
    const fresh = buildThings(state.level, shepherds);
    const mine = fresh.filter(t => t.shepherd);
    const sameMovers = old.length === mine.length && mine.every((n, i) => {
      const o = old[i];
      return o.shepherd === n.shepherd && (n.fixed || (o.x0 === n.x && o.y0 === n.y && o.vx0 === n.vx && o.vy0 === n.vy));
    });
    if (sameMovers) { mine.forEach((n, i) => { if (n.fixed) { old[i].x = old[i].x0 = n.x; old[i].y = old[i].y0 = n.y; } }); return; }
    state.things = fresh;
    state.beatStart = state.t;
  }

  // Work out the pull (or push) on everything that moves.
  function accelerations(state) {
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
    for (const p of state.missiles) {
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
  function stepStream(state) {
    const level = state.level, walls = level.walls || [], tg = level.target;

    // Heartbeat: everything that moves goes back to its start.
    if (state.t - state.beatStart >= BEAT - 1e-9) {
      state.beatStart = state.t;
      for (const b of state.things) if (!b.fixed) { b.x = b.x0; b.y = b.y0; b.vx = b.vx0; b.vy = b.vy0; b.dead = false; }
      state.events.push({ type: 'beat' });
    }
    // Fire the next missile from every silo.
    if (!state.noMissiles && state.t >= state.nextFire - 1e-9) {
      state.nextFire += FIRE_EVERY;
      silosOf(level).forEach((s, i) => {
        state.missiles.push({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, ax: 0, ay: 0, silo: i, born: state.t, got: (level.dust || []).map(() => false) });
        state.fired++;
      });
      state.events.push({ type: 'fire' });
    }

    const bodies = state.things.filter(b => !b.dead && !b.fixed);
    const before = bodies.map(b => [b.x, b.y]);
    const from = state.missiles.map(m => [m.x, m.y]);
    const movers = bodies.concat(state.missiles);
    accelerations(state);
    for (const o of movers) {
      o.vx += o.ax * DT / 2; o.vy += o.ay * DT / 2;
      o.x += o.vx * DT; o.y += o.vy * DT;
    }
    accelerations(state);
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

    // Each missile: collect stardust, then see whether it crashed, arrived or got lost.
    const dust = level.dust || [], alive = state.things.filter(b => !b.dead);
    const keep = [];
    state.missiles.forEach((p, i) => {
      dust.forEach((d, j) => {
        if (!p.got[j] && Math.hypot(d.x - p.x, d.y - p.y) < DUST_R) { p.got[j] = true; state.events.push({ type: 'dust', x: d.x, y: d.y, index: j }); }
      });
      if (alive.some(b => Math.hypot(b.x - p.x, b.y - p.y) < b.r + MISSILE_R) || walls.some(w => crossesWall(from[i][0], from[i][1], p.x, p.y, w)))
        state.events.push({ type: 'crash', x: p.x, y: p.y });
      else if (Math.hypot(tg.x - p.x, tg.y - p.y) < tg.r && p.got.every(Boolean)) {
        state.charge[p.silo] = Math.min(state.goal, state.charge[p.silo] + 1);
        state.hits[p.silo]++;
        state.events.push({ type: 'hit', x: p.x, y: p.y, silo: p.silo });
      }
      else if (Math.abs(p.x) > BOUNDS.x || Math.abs(p.y) > BOUNDS.y || state.t - p.born > MAX_AGE) { /* lost: just gone */ }
      else keep.push(p);
    });
    state.missiles = keep;

    // Win when every meter is full; otherwise the charge leaks a little. A meter still counts
    // as full for a second after its last hit, so two meters can be full "at the same time".
    if (!state.won) {
      if (state.charge.every(c => c >= state.goal - LEAK)) { state.won = true; state.wonAt = state.t; }
      else state.charge = state.charge.map(c => Math.max(0, c - LEAK * DT));
    }
    return state.won;
  }

  // Run the stream for a while and say whether the level was won. Used for testing and searching.
  // "score" is a rough "how far from winning" number: 0 for a win, smaller is nearer.
  function runStream(level, shepherds, seconds) {
    const state = createStream(level, shepherds), tg = level.target, dust = level.dust || [];
    const n = state.charge.length;
    const toTarget = state.charge.map(() => Infinity), toDust = state.charge.map(() => dust.map(() => Infinity));
    let best = 0;
    const steps = Math.round((seconds || 30) / DT);
    for (let k = 0; k < steps && !state.won; k++) {
      stepStream(state);
      best = Math.max(best, Math.min(...state.charge) / state.goal);
      if (k % 4 === 0) for (const m of state.missiles) {
        let ready = true;
        dust.forEach((d, j) => { if (!m.got[j]) { ready = false; toDust[m.silo][j] = Math.min(toDust[m.silo][j], Math.hypot(d.x - m.x, d.y - m.y)); } else toDust[m.silo][j] = 0; });
        if (ready) toTarget[m.silo] = Math.min(toTarget[m.silo], Math.hypot(tg.x - m.x, tg.y - m.y));
      }
    }
    let miss = 0;
    for (let i = 0; i < n; i++) {
      if (state.hits[i]) continue;
      const lacking = toDust[i].filter(d => d > 0);
      miss += lacking.length ? lacking.reduce((a, d) => a + 300 + Math.min(d, 900), 0) + 400 : Math.min(toTarget[i], 900);
    }
    const score = state.won ? 0 : 1000 * (1 - best) + miss;
    return { won: state.won, time: state.wonAt, hits: state.hits, fired: state.fired, best, score };
  }

  const api = { DT, FIRE_EVERY, BEAT, GOAL, LEAK, MAX_FLING, SOFT, BOUNDS, AREA, MISSILE_R, DUST_R, TYPES,
    radiusFor, clampFling, wallDist, silosOf, goalOf, whyNotBuildable, createStream, setShepherds, stepStream, runStream };
  root.ShepherdPhysics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
