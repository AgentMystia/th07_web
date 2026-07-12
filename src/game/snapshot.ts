import type { StageScene } from './stage-scene';

// Rich simulation-state snapshot shared by the browser test hook
// (window.__TH07_TEST__.snapshot()) and the headless replay harness
// (--dump-frame forensics). Shape is load-bearing: scripts/dev-shot.mjs and
// the probe family depend on it — extend, don't rename.
export function stageSnapshot(scene: StageScene): Record<string, unknown> {
  return {
    scene: 'stage',
    stageNumber: scene.stageNumber,
    mode: scene.mode,
    frame: scene.frame,
    stageFrame: scene.stageFrame,
    difficulty: scene.difficulty,
    character: scene.playerObj.character,
    score: scene.score,
    hiScore: scene.hiScore,
    enemies: scene.enemies.length,
    bullets: scene.enemyBullets.length,
    items: scene.items.length,
    itemDump: scene.items.slice(0, 12).map((it) => ({
      type: it.type, x: Math.round(it.x), y: Math.round(it.y), state: it.state
    })),
    timelines: scene.runtime.timelineCursors.map((c) => ({ ...c })),
    bossActive: !!scene.bossActive,
    bossHp: scene.bossActive?.hp ?? null,
    // PLAN.md Phase 0: explicit boss ownership — the primary boss entity and
    // the full op99 slot table (UI-001 / LIFE-001 evidence).
    bossOwner: scene.bossActive
      ? { id: scene.bossActive.id, sub: scene.bossActive.ecl.subId, slot: scene.bossActive.ecl.bossSlot }
      : null,
    bossSlots: scene.runtime.bossSlots.map((b) => (b ? { id: b.id, sub: b.ecl.subId } : null)),
    lasers: scene.enemyLasers.filter((l) => l.inUse).length,
    laserDump: scene.enemyLasers.filter((l) => l.inUse).slice(0, 6).map((l) => ({
      x: Math.round(l.x), y: Math.round(l.y), angle: Number(l.angle.toFixed(2)),
      near: Math.round(l.nearDist), far: Math.round(l.farDist), w: Number(l.displayWidth.toFixed(1)), state: l.state,
      owner: l.ownerId, flags: l.flags, color: l.color, width: Number(l.width.toFixed(1))
    })),
    stageClear: scene.stageClear,
    pause: scene.pauseState
      ? { cursor: scene.pauseState.cursor, confirm: scene.pauseState.confirm, confirmCursor: scene.pauseState.confirmCursor }
      : null,
    stageClearTimer: scene.stageClearTimer,
    clearPresentation: {
      loadingKey: scene.clearLoadingKey,
      loading: scene.clearLoadingRunner ? {
        id: scene.clearLoadingRunner.scriptId,
        frame: Math.round(scene.clearLoadingRunner.frame),
        removed: scene.clearLoadingRunner.removed,
        visible: scene.clearLoadingRunner.visible
      } : null,
      capture: scene.clearCaptureRunner ? {
        id: scene.clearCaptureRunner.scriptId,
        frame: Math.round(scene.clearCaptureRunner.frame),
        removed: scene.clearCaptureRunner.removed,
        visible: scene.clearCaptureRunner.visible,
        waiting: scene.clearCaptureRunner.waiting
      } : null
    },
    stageTransition: {
      timer: scene.stageTransitionTimer,
      total: scene.stageTransitionTiles.length,
      live: scene.stageTransitionTiles.filter((tile) => !tile.runner.removed).length,
      first: scene.stageTransitionTiles[0] ? {
        script: scene.stageTransitionTiles[0].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[0].runner.frame),
        delay: scene.stageTransitionTiles[0].delay
      } : null,
      last: scene.stageTransitionTiles.length ? {
        script: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.scriptId,
        frame: Math.round(scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].runner.frame),
        delay: scene.stageTransitionTiles[scene.stageTransitionTiles.length - 1].delay
      } : null
    },
    gameOver: scene.gameOver,
    continueActive: !!scene.continueScreen,
    spellName: scene.spellName,
    spell: scene.spellcard ? { id: scene.spellcard.id, capturing: scene.spellcard.capturing, declAge: scene.spellcard.declAge } : null,
    rngSeed: scene.rng.seed,
    player: {
      x: scene.playerObj.x,
      y: scene.playerObj.y,
      lives: scene.playerObj.lives,
      bombs: scene.playerObj.bombs,
      power: scene.playerObj.power,
      invuln: scene.playerObj.invulnFrames,
      bombInvuln: scene.playerObj.bombInvuln,
      // Compat view of the old one-shot countdown: remaining window frames
      // while in the hit state, -1 otherwise.
      deathTimer: scene.playerObj.hitState ? scene.playerObj.deathbombMeter : -1,
      deathbombMeter: scene.playerObj.deathbombMeter,
      hitState: scene.playerObj.hitState,
      dyingFrame: scene.playerObj.dyingFrame,
      materializeFrame: scene.playerObj.materializeFrame,
      alive: scene.playerObj.alive
    },
    // PLAN.md Phase 0: COMBAT-001 evidence — this frame's ReimuA homing
    // target (enemy id) and the total settled damage applied this frame.
    homingTarget: scene.homingTargetId,
    settledDamage: scene.settledDamageThisFrame,
    bomb: { timer: scene.playerObj.bombTimer },
    graze: scene.graze,
    pointItems: scene.pointItems,
    spellsCaptured: scene.cherry.spellsCaptured,
    playerBullets: scene.playerBullets.length,
    playerBulletDump: scene.playerBullets.slice(0, 8).map((b) => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      shotType: b.shotType,
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2))
    })),
    cherry: {
      c: scene.cherry.cherry,
      max: scene.cherry.cherryMax,
      plus: scene.cherry.cherryPlus,
      border: scene.cherry.borderTimer,
      pending: scene.cherry.borderPending,
      message: scene.borderMessage ? { ...scene.borderMessage } : null,
      clearWave: scene.borderClearWave ? { ...scene.borderClearWave } : null
    },
    std: {
      frame: scene.runtime.std.frame,
      animationFrame: scene.runtime.std.animationFrame,
      paused: scene.runtime.std.paused,
      primary: scene.runtime.std.primaryAnm ? { ...scene.runtime.std.primaryAnm } : null,
      secondary: scene.runtime.std.secondaryAnm ? { ...scene.runtime.std.secondaryAnm } : null
    },
    // PLAN.md Phase 0: full-pool bullet type histogram keyed `sprite:offset`
    // (RENDER-001/VM-001 evidence) — the capped bulletDump under-samples
    // dense boss patterns.
    bulletHistogram: scene.enemyBullets.reduce<Record<string, number>>((h, b) => {
      if (!b.dead) {
        const key = `${b.sprite}:${b.spriteOffset}`;
        h[key] = (h[key] ?? 0) + 1;
      }
      return h;
    }, {}),
    bulletDump: scene.enemyBullets.slice(0, 64).map((b) => ({
      id: b.id,
      x: Math.round(b.x),
      y: Math.round(b.y),
      flags: b.flags,
      dead: !!b.dead,
      sprite: b.sprite,
      off: b.spriteOffset,
      rect: [b.rect.x, b.rect.y, b.rect.w, b.rect.h],
      img: b.rect.imageKey,
      vx: Number(b.vx.toFixed(2)),
      vy: Number(b.vy.toFixed(2)),
      ex: b.exFlags,
      grace: b.graceFrames ?? 0
    })),
    enemyDump: scene.enemies.slice(0, 8).map((e) => ({
      id: e.id,
      sub: e.ecl.subId,
      ctxSub: e.ecl.ctx.subId,
      ctxTime: e.ecl.ctx.time,
      ctxIndex: e.ecl.ctx.index,
      waitTimer: e.ecl.ctx.waitTimer,
      x: Math.round(e.x),
      y: Math.round(e.y),
      hp: e.hp,
      boss: e.ecl.isBoss,
      bossSlot: e.ecl.bossSlot,
      canTakeDamage: e.ecl.canTakeDamage,
      shotCollision: e.ecl.shotCollision,
      shield: e.ecl.damageShield,
      dmg: e.damageThisFrame ?? 0,
      lastFire: e.ecl.lastFireFrame ?? -1,
      deathCallbackSub: e.ecl.deathCallbackSub,
      pendingInterrupt: e.ecl.pendingInterrupt,
      interactable: e.ecl.interactable,
      invisible: e.ecl.invisible,
      deathMode: e.ecl.deathMode,
      timer: e.ecl.bossTimer
    }))
  };
}
