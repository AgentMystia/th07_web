import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// PLAYER-002: the deathbomb meter (Th07.exe player+0x23f8) is persistent —
// seeded from SHT.deathbombWindow at spawn and at the materialize->invuln
// handoff, NOT reloaded by a hit, decremented once per WALL-CLOCK frame in
// the hit state (death commits the frame it reaches 0), gating every bomb
// on meter!=0, and bumped min(N, meter+6) on every successful bomb.
// Legal deathbomb offsets are 1..N after the hit frame; N+1 fails.
// See recon exe-player-hit.md (0x43dcd9/0x43db08/0x43dc4f/0x43e237/0x43e2c7).

const outDir = 'tests/.build/deathbomb';
mkdirSync(outDir, { recursive: true });
execSync(`npx esbuild src/game/player.ts src/game/stage-scene.ts src/formats/anm.ts src/data/th07-data.ts --bundle --format=esm --outdir=${outDir} --out-extension:.js=.mjs --log-level=silent`);
const { Player } = await import(`../${outDir}/game/player.mjs`);
const { StageScene } = await import(`../${outDir}/game/stage-scene.mjs`);
const { Anm } = await import(`../${outDir}/formats/anm.mjs`);
const { TH07_DATA } = await import(`../${outDir}/data/th07-data.mjs`);

const anms = {
  player00: new Anm(TH07_DATA.anm.player00, 'player00'),
  player01: new Anm(TH07_DATA.anm.player01, 'player01'),
  player02: new Anm(TH07_DATA.anm.player02, 'player02')
};

const FAMILIES = [
  { shots: ['reimuA', 'reimuB'], n: 15, bombs: 3 },
  { shots: ['marisaA', 'marisaB'], n: 8, bombs: 2 },
  { shots: ['sakuyaA', 'sakuyaB'], n: 6, bombs: 4 }
];

// One stage-scene-ordered frame: bomb gate first (held bit), then the
// wall-clock death tick — mirrors StageScene.update()'s 1141 -> 1162 order.
function frame(p, { bomb = false, rate = 1 } = {}) {
  let bombed = false;
  if (bomb && (p.controllable || p.hitState) && p.tryBomb()) bombed = true;
  const death = p.tickDeath(rate);
  return { bombed, death };
}

for (const fam of FAMILIES) {
  for (const shot of fam.shots) {
    for (const focused of [false, true]) {
      const tag = `${shot}${focused ? ' focused' : ''}`;
      test(`${tag}: meter seeds ${fam.n}/${fam.bombs} bombs; offsets 1..${fam.n} rescue, ${fam.n + 1} fails`, () => {
        const mk = () => {
          const p = new Player(shot, anms);
          p.focusHeld = focused;
          p.invulnFrames = 0;
          return p;
        };
        const fresh = mk();
        assert.equal(fresh.deathbombMeter, fam.n, 'meter seeded from SHT');
        assert.equal(fresh.bombs, fam.bombs, 'bombsPerLife from SHT');

        // offset 1 and offset N rescue; offset N+1 is dead.
        for (const offset of [1, fam.n]) {
          const p = mk();
          assert.equal(p.hit(), 'deathbomb-window');
          assert.equal(p.alive, false, 'not hittable during the window');
          for (let k = 1; k < offset; k++) {
            const r = frame(p);
            assert.equal(r.death, 'pending', `window still open at ${k}`);
          }
          const r = frame(p, { bomb: true });
          assert.equal(r.bombed, true, `offset ${offset} rescues`);
          assert.equal(p.hitState, false);
          assert.equal(p.bombs, fam.bombs - 1, 'exactly one bomb spent');
          assert.equal(p.lives, 2, 'no life lost');
          assert.equal(p.deathbombMeter, Math.min(fam.n, fam.n - offset + 1 + 6), 'meter = min(N, remaining+6)');
          assert.ok(p.bombInvuln > 0, 'bomb invulnerability started');
          assert.equal(p.bombFocused, focused, 'bomb form latched at cast focus');
        }

        // offset N+1: the death committed on frame N — bomb blocked.
        const p = mk();
        p.hit();
        let effects = 0;
        for (let k = 1; k <= fam.n; k++) {
          const r = frame(p);
          if (r.death === 'effects') effects++;
        }
        assert.equal(effects, 1, `death committed exactly once, on frame ${fam.n}`);
        assert.ok(p.dyingFrame >= 0, 'squish running');
        const late = frame(p, { bomb: true });
        assert.equal(late.bombed, false, `offset ${fam.n + 1} cannot bomb`);
        assert.equal(p.bombs, fam.bombs, 'no bomb consumed by the failed press');
      });
    }
  }
}

test('a hit never reloads the meter: consecutive late deathbombs shorten the window (Reimu 15 -> 7)', () => {
  const p = new Player('reimuA', anms);
  p.invulnFrames = 0;
  p.hit();
  for (let k = 1; k < 15; k++) frame(p);
  assert.equal(frame(p, { bomb: true }).bombed, true, 'latest-possible deathbomb');
  assert.equal(p.deathbombMeter, 7, 'meter = min(15, 1+6)');
  // Survive the bomb, get hit again: the next window is only 7 frames.
  p.bombTimer = 0;
  p.bombInvuln = 0;
  assert.equal(p.hit(), 'deathbomb-window');
  for (let k = 1; k < 7; k++) {
    assert.equal(frame(p).death, 'pending', `short window frame ${k}`);
  }
  const r = frame(p);
  assert.equal(r.death, 'effects', 'short window commits on frame 7');
});

test('Sakuya late deathbomb caps at the 6-frame window: min(6, 1+6) = 6', () => {
  const p = new Player('sakuyaA', anms);
  p.invulnFrames = 0;
  p.hit();
  for (let k = 1; k < 6; k++) frame(p);
  assert.equal(frame(p, { bomb: true }).bombed, true);
  assert.equal(p.deathbombMeter, 6);
});

test('zero bombs: the window runs its course into the miss', () => {
  const p = new Player('reimuA', anms);
  p.invulnFrames = 0;
  p.bombs = 0;
  p.hit();
  let committed = false;
  for (let k = 1; k <= 15; k++) {
    const r = frame(p, { bomb: true });
    assert.equal(r.bombed, false);
    if (r.death === 'effects') committed = true;
  }
  assert.ok(committed);
});

test('meter is wall-clock under slowmo; squish and materialize ride the split counter', () => {
  const p = new Player('reimuA', anms);
  p.invulnFrames = 0;
  p.hit();
  // rate 0.5: the window must still be exactly 15 tickDeath calls.
  let effects = 0;
  for (let k = 1; k <= 15; k++) {
    if (frame(p, { rate: 0.5 }).death === 'effects') effects++;
  }
  assert.equal(effects, 1, 'window length unaffected by slowRate');
  // Squish: 30 simulation ticks -> 60 wall frames at rate 0.5.
  let respawnAt = -1;
  for (let k = 1; k <= 61; k++) {
    if (p.tickDeath(0.5) === 'respawn') { respawnAt = k; break; }
  }
  assert.equal(respawnAt, 60, '30-tick squish takes 60 wall frames at rate 0.5');
  // Materialize: die() teleports + starts materialize; meter pinned at 0
  // until the handoff, then reseeds to N with the 240-tick invuln.
  p.die();
  assert.equal(p.deathbombMeter, 0);
  const held = new Set();
  const input = { held, pressed: new Set() };
  for (let k = 0; k < 59; k++) {
    p.update(input, 0.5);
    assert.equal(p.deathbombMeter, 0, `meter pinned during materialize (${k})`);
    assert.equal(p.tryBomb(), false, 'meter gate blocks bombing while materializing');
  }
  p.update(input, 0.5); // 60th half-tick -> 30 ticks: handoff
  assert.equal(p.materializeFrame, -1, 'materialize completed');
  assert.equal(p.deathbombMeter, 15, 'meter reseeded at the state-1 -> state-3 handoff');
  assert.equal(p.invulnFrames, 240, '240-tick invuln window armed');
});

test('failure path bookkeeping: life-- and bomb reset land at the respawn, drops at the commit', () => {
  const p = new Player('marisaA', anms);
  p.invulnFrames = 0;
  p.bombs = 1;
  p.hit();
  for (let k = 1; k <= 8; k++) frame(p);
  assert.equal(p.lives, 2, 'life not yet lost at the commit');
  for (let k = 0; k < 30; k++) p.tickDeath(1);
  p.die();
  assert.equal(p.lives, 1, 'life lost at the respawn teleport');
  assert.equal(p.bombs, 2, 'bombs reset to bombsPerLife');
  assert.equal(p.x, 192);
  assert.equal(p.y, 384);
  assert.ok(p.materializeFrame >= 0, 'materialize started');
});

// --- StageScene-level: gate ordering, Held semantics, Border interplay ----

function gateScene(borderEngaged = false) {
  const scene = Object.create(StageScene.prototype);
  const p = new Player('reimuA', anms);
  p.invulnFrames = 0;
  scene.playerObj = p;
  scene.items = [
    { id: 1, x: 10, y: 10, vx: 0, vy: 0, type: 'point', age: 0, state: 0 }
  ];
  scene.cherry = {
    borderEngaged,
    breakBorder: (includePending) => borderEngaged && includePending,
    retryBorderStart: () => {}
  };
  scene.frame = 100;
  scene.borderCalls = [];
  scene.voidSpellCapture = () => {};
  scene.playSfx = () => {};
  scene.spawnEffectParticles = () => {};
  scene.sweepBorderClearWave = () => {};
  scene.onBombUsed = () => { scene.bombUsedFired = true; };
  scene.spellcard = null;
  scene.gameOver = false;
  return scene;
}

test('bomb during the window with a pending Border: free break, no bomb spent, death state cleared, 40f invuln, items latched', () => {
  const scene = gateScene(true);
  const p = scene.playerObj;
  p.hit();
  assert.equal(p.hitState, true);
  // Reproduce the update() bomb block for the borderEngaged branch.
  if (p.bombTimer <= 0 && scene.breakBorder(null, true, true)) {
    for (const it of scene.items) if (!it.dead) it.state = 1;
  }
  assert.equal(p.hitState, false, 'death state cleared by the free break');
  assert.equal(p.bombs, 3, 'no bomb spent');
  assert.ok(p.invulnFrames >= 40, '40-frame invuln');
  assert.equal(scene.items[0].state, 1, 'items flagged for collection');
  assert.equal(p.lives, 2, 'no miss');
});

test('a hit-triggered border break does NOT rescue-clear anything extra (regression)', () => {
  const scene = gateScene(true);
  const p = scene.playerObj;
  // onPlayerHit's breakBorder(sourceBullet) passes rescue=false.
  const bullet = { dead: false };
  scene.breakBorder(bullet, false, false);
  assert.equal(bullet.dead, false, 'pending-only border: hit break fails, bullet untouched here');
});
