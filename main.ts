// Push-optimal Sokoban solver for generated hallway-and-rooms levels.
//
// Approach, in plain words:
//   * A level is a one-wide hallway with independent rooms off it. A box
//     pushed out of its room can never return, and the level's optimal push
//     count is the sum of the rooms' optima, so each room is solved on its
//     own and the player simply walks the hallway between rooms.
//   * Each room (and, as a fallback, a whole level) is solved with an A*
//     search over pushes, not steps: a state is the set of box cells plus
//     the region the player can reach without pushing. The cost so far is
//     the push count, which is exactly what the score rewards.
//   * The estimate is a minimum-cost matching between boxes and goals over
//     precomputed box-to-goal push distances (a relaxation that ignores the
//     other boxes), which is admissible, so the first solution A* settles
//     on is push-optimal.
//   * Hopeless pushes are pruned with static dead squares (cells no box
//     can ever leave toward a goal), a freeze-deadlock fixpoint, and a
//     2x2-block check.
//   * The search is budgeted by expanded states, never by the clock, so
//     two runs always produce byte-identical answers. If the optimal
//     search ever exhausts its budget, a greedier weighted search still
//     returns a complete (if longer) solution rather than none.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in a fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const DL = ['u', 'd', 'l', 'r'];
const INF = 1e9;

// One deterministic work budget shared by every search of the run.
let workLeft = 2600000;

function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  const goals = [];
  for (let i = 0; i < w * h; i++) if (goal[i]) goals.push(i);
  return { w, h, wall, goal, boxes, goals, player };
}

// Minimum pushes that bring one box from every cell to goalCell, ignoring
// the other boxes: reverse breadth-first search over box cells. A forward
// push moves a box from c to c + d with the player standing at c - d, so a
// predecessor of b is b - d whenever both b - d and the stand cell b - 2d
// are open floor.
function pushDistances(w, h, effWall, goalCell) {
  const dist = new Int32Array(w * h).fill(-1);
  dist[goalCell] = 0;
  const queue = [goalCell];
  for (let qi = 0; qi < queue.length; qi++) {
    const b = queue[qi];
    const bx = b % w;
    const by = (b / w) | 0;
    const next = dist[b] + 1;
    for (let dir = 0; dir < 4; dir++) {
      const px = bx - DX[dir];
      const py = by - DY[dir];
      const sx = bx - 2 * DX[dir];
      const sy = by - 2 * DY[dir];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const prev = py * w + px;
      if (effWall[prev] || effWall[sy * w + sx]) continue;
      if (dist[prev] !== -1) continue;
      dist[prev] = next;
      queue.push(prev);
    }
  }
  return dist;
}

// A problem: a set of boxes and goals on the grid, an active mask of cells
// the player and boxes may use, and a noBox mask of cells a box may never
// be pushed onto (the hallway, for a room solved on its own).
function buildProblem(grid, boxes0, goalCells, active, noBox) {
  const { w, h, wall, goal } = grid;
  const effWall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) effWall[i] = wall[i] || !active[i] ? 1 : 0;
  const dists = goalCells.map((g) => pushDistances(w, h, effWall, g));
  const dead = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (effWall[i] || goal[i]) continue;
    let reachable = false;
    for (const d of dists) {
      if (d[i] !== -1) {
        reachable = true;
        break;
      }
    }
    if (!reachable) dead[i] = 1;
  }
  return { w, h, effWall, goal, dists, dead, noBox, boxes0, goalCells };
}

// Admissible estimate: minimum-cost matching of boxes to goals over the
// push distances, by DP over goal subsets for up to 8 boxes; for more
// boxes, the sum of each box's nearest-goal distance (still admissible).
function heuristic(prob, boxes) {
  const n = boxes.length;
  const m = prob.goalCells.length;
  if (n <= 8 && m <= 8) {
    const size = 1 << m;
    const dp = new Array(size).fill(INF);
    dp[0] = 0;
    for (let mask = 0; mask < size; mask++) {
      const cur = dp[mask];
      if (cur >= INF) continue;
      let k = 0;
      for (let t = mask; t; t &= t - 1) k++;
      if (k >= n) continue;
      const b = boxes[k];
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const d = prob.dists[j][b];
        if (d === -1) continue;
        const nm = mask | (1 << j);
        if (cur + d < dp[nm]) dp[nm] = cur + d;
      }
    }
    return dp[size - 1];
  }
  let sum = 0;
  for (const b of boxes) {
    let best = INF;
    for (let j = 0; j < m; j++) {
      const d = prob.dists[j][b];
      if (d !== -1 && d < best) best = d;
    }
    if (best >= INF) return INF;
    sum += best;
  }
  return sum;
}

// Deadlock test for a box set. `moved` is the box cell the last push
// created, or -1 to check every 2x2 block (used for the initial state).
// A position is dead when a 2x2 block of walls and boxes holds a box off
// its goal (no box of a solid block can ever be the first to move), or
// when the freeze fixpoint marks a box off its goal: a box is frozen when
// one neighbour on each axis is a wall or an already frozen box, since a
// push along an axis needs both sides of that axis usable in turn.
function deadlocked(prob, boxSet, moved) {
  const { w, h, effWall, goal } = prob;
  const tops = [];
  if (moved >= 0) {
    const mx = moved % w;
    const my = (moved / w) | 0;
    const offs = [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ];
    for (const [ox, oy] of offs) {
      const tx = mx + ox;
      const ty = my + oy;
      if (tx >= 0 && ty >= 0 && tx + 1 < w && ty + 1 < h) tops.push([tx, ty]);
    }
  } else {
    for (let y = 0; y + 1 < h; y++) {
      for (let x = 0; x + 1 < w; x++) tops.push([x, y]);
    }
  }
  for (const [tx, ty] of tops) {
    const cells = [ty * w + tx, ty * w + tx + 1, (ty + 1) * w + tx, (ty + 1) * w + tx + 1];
    let solid = true;
    let badBox = false;
    for (const c of cells) {
      if (effWall[c]) continue;
      if (boxSet.has(c)) {
        if (!goal[c]) badBox = true;
        continue;
      }
      solid = false;
      break;
    }
    if (solid && badBox) return true;
  }
  const frozen = new Set();
  const blocked = (c) => effWall[c] === 1 || (boxSet.has(c) && frozen.has(c));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxSet) {
      if (frozen.has(b)) continue;
      const immX = blocked(b - 1) || blocked(b + 1);
      const immY = blocked(b - w) || blocked(b + w);
      if (immX && immY) {
        frozen.add(b);
        changed = true;
      }
    }
  }
  for (const b of frozen) if (!goal[b]) return true;
  return false;
}

// The region the player can reach from `start` without pushing: a flood
// over open cells that are not walls and hold no box. Also returns the
// flood's parent tree (for spelling out a walk) and its smallest cell,
// which names the region canonically in a search state.
function flood(prob, boxSet, start) {
  const { w, h, effWall } = prob;
  const seen = new Uint8Array(w * h);
  const parent = new Int32Array(w * h).fill(-1);
  const queue = [start];
  seen[start] = 1;
  let min = start;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    if (c < min) min = c;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DX[dir];
      const ny = cy + DY[dir];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nc = ny * w + nx;
      if (seen[nc] || effWall[nc] || boxSet.has(nc)) continue;
      seen[nc] = 1;
      parent[nc] = c;
      queue.push(nc);
    }
  }
  return { seen, parent, min };
}

// The walk from `from` to `to` along a flood parent tree, as move letters.
function pathLetters(parent, w, from, to) {
  const letters = [];
  let c = to;
  while (c !== from) {
    const p = parent[c];
    const d = c - p;
    letters.push(d === 1 ? 'r' : d === -1 ? 'l' : d === w ? 'd' : 'u');
    c = p;
  }
  letters.reverse();
  return letters.join('');
}

// A* over pushes. With weight 1 the first goal state settled is
// push-optimal; a larger weight trades optimality for speed and is only
// used as a fallback. `cap` bounds expanded states; the shared workLeft
// budget bounds the whole run. Returns the move string, the push count,
// the player's final cell and the final box cells, or null.
function search(prob, playerStart, cap, weight) {
  const { w, h, effWall, goal, dead, noBox } = prob;
  const startBoxes = prob.boxes0.slice().sort((a, b) => a - b);
  const startSet = new Set(startBoxes);
  if (startBoxes.every((b) => goal[b])) {
    return { moves: '', pushes: 0, endPlayer: playerStart, endBoxes: startBoxes };
  }
  if (startBoxes.some((b) => dead[b])) return null;
  if (deadlocked(prob, startSet, -1)) return null;
  const h0 = heuristic(prob, startBoxes);
  if (h0 >= INF) return null;
  const budget = Math.min(cap, workLeft);
  if (budget <= 0) return null;

  const nodes = [];
  const hf = [];
  const hg = [];
  const hc = [];
  const best = new Map();
  const heap = [];
  let counter = 0;
  const less = (a, b) =>
    hf[a] < hf[b] || (hf[a] === hf[b] && (hg[a] > hg[b] || (hg[a] === hg[b] && hc[a] < hc[b])));
  const hpush = (idx) => {
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i];
        heap[i] = heap[c];
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const startRegion = flood(prob, startSet, playerStart);
  const startKey = startRegion.min + '|' + startBoxes.join(',');
  nodes.push({ boxes: startBoxes, player: playerStart, g: 0, parent: -1, seg: '', key: startKey });
  hf.push(weight * h0);
  hg.push(0);
  hc.push(counter++);
  best.set(startKey, 0);
  hpush(0);

  let expanded = 0;
  let found = null;
  while (heap.length > 0) {
    const idx = hpop();
    const node = nodes[idx];
    if (best.get(node.key) < node.g) continue;
    if (node.boxes.every((b) => goal[b])) {
      found = node;
      break;
    }
    if (expanded >= budget) break;
    expanded++;
    const boxSet = new Set(node.boxes);
    const region = flood(prob, boxSet, node.player);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const sx = bx - DX[dir];
        const sy = by - DY[dir];
        const tx = bx + DX[dir];
        const ty = by + DY[dir];
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const stand = sy * w + sx;
        const dest = ty * w + tx;
        if (!region.seen[stand]) continue;
        if (effWall[dest] || boxSet.has(dest) || dead[dest] || noBox[dest]) continue;
        const nboxes = node.boxes.slice();
        nboxes[bi] = dest;
        nboxes.sort((a, b2) => a - b2);
        const nset = new Set(nboxes);
        if (deadlocked(prob, nset, dest)) continue;
        const hv = heuristic(prob, nboxes);
        if (hv >= INF) continue;
        const ng = node.g + 1;
        // After the push the player stands where the box was.
        const nregion = flood(prob, nset, b);
        const key = nregion.min + '|' + nboxes.join(',');
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        best.set(key, ng);
        const seg = pathLetters(region.parent, w, node.player, stand) + DL[dir].toUpperCase();
        const nidx = nodes.length;
        nodes.push({ boxes: nboxes, player: b, g: ng, parent: idx, seg, key });
        hf.push(ng + weight * hv);
        hg.push(ng);
        hc.push(counter++);
        hpush(nidx);
      }
    }
  }
  workLeft -= expanded;
  if (!found) return null;
  const segs = [];
  for (let t = found; t.parent !== -1; t = nodes[t.parent]) segs.push(t.seg);
  segs.reverse();
  return { moves: segs.join(''), pushes: found.g, endPlayer: found.player, endBoxes: found.boxes };
}

// Split a level into its hallway (the player's row) and the rooms off it:
// the connected components of the remaining open cells. Each component
// with boxes must hold exactly as many goals, and must touch the hallway
// at a door. Returns null when the shape is anything else, in which case
// the caller solves the level whole.
function decompose(grid) {
  const { w, h, wall, goal, boxes, goals, player } = grid;
  const prow = (player / w) | 0;
  const hall = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = prow * w + x;
    if (!wall[i]) hall[i] = 1;
  }
  const comp = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || hall[i] || comp[i] !== -1) continue;
    const id = comps.length;
    const cells = [];
    const queue = [i];
    comp[i] = id;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      cells.push(c);
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + DX[dir];
        const ny = cy + DY[dir];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nc = ny * w + nx;
        if (wall[nc] || hall[nc] || comp[nc] !== -1) continue;
        comp[nc] = id;
        queue.push(nc);
      }
    }
    comps.push(cells);
  }
  const boxSet = new Set(boxes);
  const rooms = [];
  for (const cells of comps) {
    const cb = cells.filter((c) => boxSet.has(c));
    const cg = cells.filter((c) => goal[c]);
    if (cb.length === 0 && cg.length === 0) continue;
    if (cb.length === 0 || cb.length !== cg.length) return null;
    let door = -1;
    for (const c of cells) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + DX[dir];
        const ny = cy + DY[dir];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nc = ny * w + nx;
        if (hall[nc]) {
          door = nc;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) return null;
    let min = cells[0];
    for (const c of cells) if (c < min) min = c;
    cb.sort((a, b) => a - b);
    rooms.push({ cells, boxes: cb, goals: cg, door, min });
  }
  if (rooms.length === 0) return null;
  let nb = 0;
  let ng = 0;
  for (const r of rooms) {
    nb += r.boxes.length;
    ng += r.goals.length;
  }
  if (nb !== boxes.length || ng !== goals.length) return null;
  rooms.sort((a, b) => a.min - b.min);
  return { rooms, hall };
}

// A plain walk (no pushes) from one cell to another, avoiding walls and
// boxes, spelled out as move letters; null when no such walk exists.
function bfsWalk(grid, boxSet, from, to) {
  if (from === to) return '';
  const { w, h, wall } = grid;
  const prob = { w, h, effWall: wall };
  const region = flood(prob, boxSet, from);
  if (!region.seen[to]) return null;
  return pathLetters(region.parent, w, from, to);
}

// Replay a move string on the level; true when every step is legal and
// the replay ends with every box on a goal. Used as a self-check on the
// assembled per-room answers before they are trusted.
function replay(grid, moves) {
  const { w, h, wall, goal } = grid;
  const boxSet = new Set(grid.boxes);
  let p = grid.player;
  for (const ch of moves) {
    const dir = DL.indexOf(ch.toLowerCase());
    if (dir === -1) return false;
    const px = p % w;
    const py = (p / w) | 0;
    const nx = px + DX[dir];
    const ny = py + DY[dir];
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
    const nc = ny * w + nx;
    if (wall[nc]) return false;
    if (boxSet.has(nc)) {
      const bx = nx + DX[dir];
      const by = ny + DY[dir];
      if (bx < 0 || by < 0 || bx >= w || by >= h) return false;
      const bc = by * w + bx;
      if (wall[bc] || boxSet.has(bc)) return false;
      boxSet.delete(nc);
      boxSet.add(bc);
    }
    p = nc;
  }
  for (const b of boxSet) if (!goal[b]) return false;
  return true;
}

const ROOM_CAP = 500000;
const LEVEL_CAP = 900000;

function solveLevel(text) {
  const grid = parseLevel(text);
  if (grid.boxes.every((b) => grid.goal[b])) return '';
  const dec = decompose(grid);
  if (dec) {
    const boxSet = new Set(grid.boxes);
    let player = grid.player;
    let moves = '';
    let ok = true;
    for (const room of dec.rooms) {
      const walk = bfsWalk(grid, boxSet, player, room.door);
      if (walk === null) {
        ok = false;
        break;
      }
      const active = new Uint8Array(grid.w * grid.h);
      for (const c of room.cells) active[c] = 1;
      for (let i = 0; i < active.length; i++) if (dec.hall[i]) active[i] = 1;
      const prob = buildProblem(grid, room.boxes, room.goals, active, dec.hall);
      let res = search(prob, room.door, ROOM_CAP, 1);
      if (!res) res = search(prob, room.door, ROOM_CAP, 3);
      if (!res) {
        ok = false;
        break;
      }
      moves += walk + res.moves;
      for (const b of room.boxes) boxSet.delete(b);
      for (const b of res.endBoxes) boxSet.add(b);
      player = res.endPlayer;
    }
    if (ok && replay(grid, moves)) return moves;
  }
  // Fallback: the whole level as one problem, boxes allowed anywhere.
  const activeAll = new Uint8Array(grid.w * grid.h).fill(1);
  const noBoxNone = new Uint8Array(grid.w * grid.h);
  const prob = buildProblem(grid, grid.boxes, grid.goals, activeAll, noBoxNone);
  let res = search(prob, grid.player, LEVEL_CAP, 1);
  if (!res) res = search(prob, grid.player, LEVEL_CAP, 3);
  if (!res) res = search(prob, grid.player, LEVEL_CAP, 10);
  return res ? res.moves : '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
