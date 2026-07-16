import type { AnmFrame } from '../formats/anm';

export const SCREEN_W = 640;
export const SCREEN_H = 480;
// Playfield rectangle inside the 640×480 frame (same as the original layout).
export const PLAYFIELD = { x: 32, y: 16, width: 384, height: 448 } as const;

export interface DrawOptions {
  scaleMultiplier?: number;
  scaleX?: number;
  scaleY?: number;
  offsetX?: number;
  offsetY?: number;
  alpha?: number;
  color?: number;
  rotation?: number;
  blend?: GlobalCompositeOperation;
  sourceOffsetX?: number;
  sourceOffsetY?: number;
  project3d?: boolean;
}

export interface RendererOptions {
  desynchronized?: boolean;
  // Test-only: allocate the backbuffer + present() path even when the
  // browser did not grant `desynchronized` (Firefox/WebKit never do).
  // Lets cross-engine smokes exercise the exact presentation code Chrome
  // players run, on rasterizers that would otherwise skip it.
  forceBackbuffer?: boolean;
}

function colorParts(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private readonly displayCtx: CanvasRenderingContext2D;
  private readonly backbuffer: HTMLCanvasElement | null;
  assets: Record<string, HTMLImageElement | HTMLCanvasElement> = {};
  private tintCache = new Map<string, HTMLCanvasElement>();
  private tintCacheOrder: string[] = [];
  private tintImageIds = new WeakMap<HTMLImageElement, number>();
  private tintNextImageId = 1;
  private readonly tintCacheLimit = 384;
  private tintScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  // Whole-image patterns for the clip-free textured-triangle fill.
  private trianglePatterns = new WeakMap<CanvasImageSource, CanvasPattern>();
  readonly requestedDesynchronized: boolean;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    // desynchronized ON by default: on granting browsers (Chromium) it
    // pipelines the canvas past the display compositor, cutting
    // input-to-photon latency by 1-2 vsyncs. It is safe by construction
    // now: a granted context is NEVER drawn incrementally — frames finish
    // on an offscreen backbuffer and present() copies them in one op (the
    // 8552afe-era spell-card flicker came from incremental front-buffer
    // draws, before the backbuffer existed). Non-granting browsers
    // (Firefox/Safari) feature-detect below and keep the direct path,
    // byte-identical to the old default. Player kill switch: ?desync=0.
    // alpha:false stays — the playfield is fully redrawn each frame
    // (clear + draw), so the page alpha channel is unused and skipping it
    // saves the per-pixel page blend.
    this.requestedDesynchronized = options.desynchronized ?? true;
    const displayCtx = canvas.getContext('2d', {
      desynchronized: this.requestedDesynchronized,
      alpha: false
    });
    if (!displayCtx) throw new Error('Canvas 2D context unavailable');
    this.displayCtx = displayCtx;
    displayCtx.imageSmoothingEnabled = false;
    const actualDesynchronized = displayCtx.getContextAttributes?.().desynchronized ?? false;
    if (actualDesynchronized || options.forceBackbuffer === true) {
      // Chrome's low-latency path may expose the front buffer while drawing.
      // Its own guidance says not to clear that visible context incrementally:
      // finish the frame offscreen, then copy it in one operation to avoid
      // flicker/blank scans. Browsers that ignore the hint keep rendering
      // direct and pay no extra full-canvas copy.
      const backbuffer = document.createElement('canvas');
      backbuffer.width = SCREEN_W;
      backbuffer.height = SCREEN_H;
      const ctx = backbuffer.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas 2D backbuffer unavailable');
      ctx.imageSmoothingEnabled = false;
      this.backbuffer = backbuffer;
      this.ctx = ctx;
    } else {
      this.backbuffer = null;
      this.ctx = displayCtx;
    }
    // GPU-reset resilience (UNVERIFIED-BY-AUTOMATION: real device resets
    // can't be triggered from the harness). After a reset the browser
    // restores contexts BLANK — the per-frame scene redraw recovers on its
    // own, but the tint cache holds now-blank canvases that would keep
    // serving invisible sprites from cache hits forever. Drop every raster
    // cache when the display context comes back. No-op on browsers that
    // never fire the event.
    canvas.addEventListener('contextrestored', () => {
      this.tintCache.clear();
      this.tintCacheOrder.length = 0;
      this.tintScratch = null;
      this.trianglePatterns = new WeakMap();
      this.present();
    });
  }

  contextAttributes(): {
    requestedDesynchronized: boolean;
    backBuffered: boolean;
    actual: CanvasRenderingContext2DSettings | null;
  } {
    return {
      requestedDesynchronized: this.requestedDesynchronized,
      backBuffered: this.backbuffer != null,
      actual: this.displayCtx.getContextAttributes?.() ?? null
    };
  }

  // Test-only readback of the PRESENTED canvas (post-present() pixels),
  // as opposed to pixelAt/this.ctx which read the backbuffer when one is
  // active. Probes use it to assert present() actually delivered a frame.
  displayPixel(x: number, y: number): number[] {
    return Array.from(this.displayCtx.getImageData(x, y, 1, 1).data);
  }

  present(): void {
    if (!this.backbuffer) return;
    // Plain source-over drawImage: both canvases are opaque (alpha:false),
    // so it produces the same pixels as a 'copy' blit while staying on the
    // rasterizer's fastest path ('copy' was measured 2.6× slower at p99 on
    // headless SwiftShader: perf:smoke draw p99 17.2ms vs 6.5ms control).
    // present() is the sole writer to displayCtx and never changes its
    // transform/alpha/composite state, so no save/restore is needed.
    this.displayCtx.drawImage(this.backbuffer, 0, 0);
  }

  clear(color = '#000'): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  }

  image(key: string): HTMLImageElement | HTMLCanvasElement | null {
    return this.assets[key] ?? null;
  }

  drawImage(key: string, x: number, y: number, w?: number, h?: number): void {
    const img = this.assets[key];
    if (!img) return;
    this.ctx.drawImage(img, x, y, w ?? img.width, h ?? img.height);
  }

  // Draws an AnmFrame produced by AnmRunner.spriteFrame() at (x, y).
  drawAnmFrame(frame: AnmFrame | null, x: number, y: number, options: DrawOptions = {}): boolean {
    if (!frame) return false;
    const img = this.assets[frame.imageKey];
    if (!img) return false;
    const ctx = this.ctx;
    const scaleMul = options.scaleMultiplier ?? 1;
    const scaleX = (options.scaleX ?? frame.scaleX) * scaleMul;
    const scaleY = (options.scaleY ?? frame.scaleY) * scaleMul;
    const w = Math.max(0.001, Math.abs(frame.w * scaleX));
    const h = Math.max(0.001, Math.abs(frame.h * scaleY));
    const drawX = x + frame.vmX + frame.posOffsetX + (options.offsetX ?? 0);
    const drawY = y + frame.vmY + frame.posOffsetY + (options.offsetY ?? 0);
    const anchorX = frame.anchorTopLeft ? 0 : w / 2;
    const anchorY = frame.anchorTopLeft ? 0 : h / 2;
    const alpha = (options.alpha ?? 1) * (frame.alpha / 255);
    if (alpha <= 0) return false;
    const color = (options.color ?? frame.color) >>> 0;
    const tint = (color & 0x00ffffff) !== 0x00ffffff;
    const sourceX = frame.x + (options.sourceOffsetX ?? 0);
    const sourceY = frame.y + (options.sourceOffsetY ?? 0);
    if (options.project3d && (frame.rotationX !== 0 || frame.rotationY !== 0)) {
      return this.drawProjectedAnmFrame(
        img, frame, sourceX, sourceY, drawX, drawY, w, h,
        options.rotation ?? frame.rotation, alpha, color, tint,
        options.blend ?? (frame.blendAdd ? 'lighter' : 'source-over')
      );
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = options.blend ?? (frame.blendAdd ? 'lighter' : 'source-over');
    ctx.translate(drawX, drawY);
    ctx.rotate(options.rotation ?? frame.rotation);
    if (scaleX < 0 || frame.flipX) ctx.scale(-1, 1);
    if (scaleY < 0 || frame.flipY) ctx.scale(1, -1);
    if (tint) this.tintedSprite(img, sourceX, sourceY, frame.w, frame.h, -anchorX, -anchorY, w, h, color);
    else ctx.drawImage(img, sourceX, sourceY, frame.w, frame.h, -anchorX, -anchorY, w, h);
    ctx.restore();
    return true;
  }

  private drawProjectedAnmFrame(
    img: HTMLImageElement | HTMLCanvasElement,
    frame: AnmFrame,
    sourceX: number,
    sourceY: number,
    drawX: number,
    drawY: number,
    width: number,
    height: number,
    rotationZ: number,
    alpha: number,
    color: number,
    tint: boolean,
    blend: GlobalCompositeOperation
  ): boolean {
    let source: CanvasImageSource = img;
    let sx = sourceX;
    let sy = sourceY;
    let sw = frame.w;
    let sh = frame.h;
    if (tint) {
      const tinted = this.tintedSpriteCanvas(img, sourceX, sourceY, frame.w, frame.h, color);
      if (!tinted) return false;
      source = tinted;
      sx = 0;
      sy = 0;
      sw = tinted.width;
      sh = tinted.height;
    }

    // Th07.exe v1.00b FUN_00449e60 @ 0x449e60 multiplies Scale * RotX *
    // RotY * RotZ before FUN_0044a170 projects the quad. The default camera
    // setup @ 0x4330ed uses a 30-degree vertical FOV and positions the target
    // plane at focal distance 240/tan(15deg), making z=0 exactly 1px:1px.
    const focal = 240 / Math.tan(Math.PI / 12);
    const cx = Math.cos(frame.rotationX);
    const sxRot = Math.sin(frame.rotationX);
    const cy = Math.cos(frame.rotationY);
    const syRot = Math.sin(frame.rotationY);
    const cz = Math.cos(rotationZ);
    const sz = Math.sin(rotationZ);
    const project = (x: number, y: number): [number, number] => {
      // Row-vector rotations in the same X -> Y -> Z order as D3D's matrices.
      const y1 = y * cx;
      const z1 = y * sxRot;
      const x2 = x * cy + z1 * syRot;
      const z2 = -x * syRot + z1 * cy;
      const x3 = x2 * cz - y1 * sz;
      const y3 = x2 * sz + y1 * cz;
      const perspective = focal / (focal + z2);
      return [drawX + x3 * perspective, drawY + y3 * perspective];
    };

    const left = frame.anchorTopLeft ? 0 : -width / 2;
    const top = frame.anchorTopLeft ? 0 : -height / 2;
    const right = left + width;
    const bottom = top + height;
    const tl = project(left, top);
    const tr = project(right, top);
    const bl = project(left, bottom);
    const br = project(right, bottom);

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    this.drawAffineTriangle(source, sx, sy, tl[0], tl[1], sx + sw, sy, tr[0], tr[1], sx, sy + sh, bl[0], bl[1]);
    this.drawAffineTriangle(source, sx, sy + sh, bl[0], bl[1], sx + sw, sy, tr[0], tr[1], sx + sw, sy + sh, br[0], br[1]);
    ctx.restore();
    return true;
  }

  // Draws a raw sprite rect (for cases not driven by a script runner).
  drawSprite(imageKey: string, sx: number, sy: number, sw: number, sh: number, x: number, y: number, options: DrawOptions = {}): void {
    const img = this.assets[imageKey];
    if (!img) return;
    const ctx = this.ctx;
    const scaleX = (options.scaleX ?? 1) * (options.scaleMultiplier ?? 1);
    const scaleY = (options.scaleY ?? 1) * (options.scaleMultiplier ?? 1);
    const w = Math.abs(sw * scaleX);
    const h = Math.abs(sh * scaleY);
    ctx.save();
    ctx.globalAlpha = options.alpha ?? 1;
    ctx.globalCompositeOperation = options.blend ?? 'source-over';
    ctx.translate(x, y);
    if (options.rotation) ctx.rotate(options.rotation);
    if (scaleX < 0) ctx.scale(-1, 1);
    if (scaleY < 0) ctx.scale(1, -1);
    const color = options.color;
    if (color != null && (color & 0x00ffffff) !== 0x00ffffff) {
      this.tintedSprite(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h, color);
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // Fast path for many untinted entity sprites. The caller must bracket a
  // batch with one ctx.save()/restore(); every mutable state used here is
  // assigned per sprite, so adjacent bullets cannot leak state to each other.
  drawSpriteInBatch(
    imageKey: string,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    x: number,
    y: number,
    rotation: number,
    scaleMultiplier: number,
    alpha: number,
    blend: GlobalCompositeOperation,
    color?: number
  ): void {
    const img = this.assets[imageKey];
    if (!img || alpha <= 0) return;
    const ctx = this.ctx;
    // Redundant canvas state writes are not free — a 1100-item sweep frame
    // otherwise pays for 1100 alpha/blend sets (PERF-001). Assign only on
    // change; values persist across batch calls and the comparison reads
    // live state, so interleaved non-batch draws stay correct.
    if (ctx.globalAlpha !== alpha) ctx.globalAlpha = alpha;
    if (ctx.globalCompositeOperation !== blend) ctx.globalCompositeOperation = blend;
    const w = Math.max(0.001, Math.abs(sw * scaleMultiplier));
    const h = Math.max(0.001, Math.abs(sh * scaleMultiplier));
    const tinted = color != null && (color & 0x00ffffff) !== 0x00ffffff
      ? this.tintedSpriteCanvas(img, sx, sy, sw, sh, color)
      : null;
    if (rotation === 0) {
      // Unrotated fast path (items, glyphs): translate(x,y)+draw(-w/2,-h/2)
      // and draw(x-w/2, y-h/2) are the same affine map — two matrix ops
      // cheaper per call, pixel-identical.
      ctx.resetTransform();
      if (tinted) ctx.drawImage(tinted, 0, 0, tinted.width, tinted.height, x - w / 2, y - h / 2, w, h);
      else ctx.drawImage(img, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
      return;
    }
    // Keep Canvas' own rotation path so rasterization stays pixel-identical
    // to drawSprite(); hand-built sin/cos matrices differ in their last bits.
    ctx.resetTransform();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    if (tinted) {
      // Tints resolve through the same cached-canvas path as drawSprite, so
      // a batch of colored glyphs stays one drawImage per sprite.
      ctx.drawImage(tinted, 0, 0, tinted.width, tinted.height, -w / 2, -h / 2, w, h);
      return;
    }
    ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  }

  private tintedSprite(img: HTMLImageElement | HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, color: number): void {
    const cached = this.tintedSpriteCanvas(img, sx, sy, sw, sh, color);
    if (cached) this.ctx.drawImage(cached, 0, 0, cached.width, cached.height, dx, dy, dw, dh);
  }

  private tintedSpriteCanvas(img: HTMLImageElement | HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, color: number): HTMLCanvasElement | null {
    // Runtime capture canvases are rewritten in-place. Caching their tinted
    // pixels would show stale stage frames, while capture script 1's 60-frame
    // color tween would also churn a large entry every frame.
    const cacheable = img instanceof HTMLImageElement;
    let key: string | null = null;
    if (cacheable) {
      let imageId = this.tintImageIds.get(img);
      if (!imageId) {
        imageId = this.tintNextImageId++;
        this.tintImageIds.set(img, imageId);
      }
      key = `${imageId}:${sx}:${sy}:${sw}:${sh}:${color >>> 0}`;
      const hit = this.tintCache.get(key);
      if (hit) return hit;
    }
    const width = Math.max(1, Math.ceil(sw));
    const height = Math.max(1, Math.ceil(sh));
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null;
    if (cacheable) {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext('2d');
    } else {
      if (!this.tintScratch) {
        const scratch = document.createElement('canvas');
        const scratchCtx = scratch.getContext('2d');
        if (!scratchCtx) return null;
        this.tintScratch = { canvas: scratch, ctx: scratchCtx };
      }
      canvas = this.tintScratch.canvas;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx = this.tintScratch.ctx;
      ctx.clearRect(0, 0, width, height);
    }
    if (!ctx) return null;
    const c = colorParts(color);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    if (key) {
      this.tintCache.set(key, canvas);
      this.tintCacheOrder.push(key);
      while (this.tintCacheOrder.length > this.tintCacheLimit) {
        const oldKey = this.tintCacheOrder.shift();
        if (oldKey) this.tintCache.delete(oldKey);
      }
    }
    return canvas;
  }

  // Th07.exe FUN_00432320 @ 0x432320 -> FUN_0044ead0 @ 0x44ead0:
  // stage-clear capture copies the previous backbuffer's playfield 1:1 into
  // capture.anm sprite 1's runtime "@" texture rect (128,0,384,448).
  capturePlayfield(key = 'capture:@'): void {
    let surface = this.assets[key];
    if (!(surface instanceof HTMLCanvasElement)) {
      surface = document.createElement('canvas');
      surface.width = 512;
      surface.height = 512;
      this.assets[key] = surface;
    }
    const ctx = surface.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, surface.width, surface.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.backbuffer ?? this.canvas,
      PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height,
      128, 0, PLAYFIELD.width, PLAYFIELD.height
    );
  }

  text(str: string, x: number, y: number, options: { size?: number; color?: string; align?: CanvasTextAlign; stroke?: boolean; font?: string } = {}): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${options.size ?? 14}px ${options.font ?? '"MS Gothic", "Yu Gothic", monospace'}`;
    ctx.textAlign = options.align ?? 'left';
    ctx.textBaseline = 'top';
    if (options.stroke !== false) {
      ctx.strokeStyle = 'rgba(0, 0, 20, 0.9)';
      ctx.lineWidth = 3;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = options.color ?? '#fff';
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  // Draws one texture-mapped triangle by solving the general 3-point affine
  // fit (source (u,v) -> destination (x,y)) and using it as the canvas
  // transform for an unclipped `drawImage(img, 0, 0)`, clipped to the
  // triangle path. Works for any non-degenerate triangle, not just ones
  // axis-aligned in UV space.
  private drawAffineTriangle(
    img: CanvasImageSource,
    u0: number, v0: number, x0: number, y0: number,
    u1: number, v1: number, x1: number, y1: number,
    u2: number, v2: number, x2: number, y2: number
  ): void {
    const denom = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return;
    const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / denom;
    const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / denom;
    const c = ((u1 - u0) * (x2 - x0) - (u2 - u0) * (x1 - x0)) / denom;
    const d = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / denom;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;
    if (![a, b, c, d, e, f].every(Number.isFinite)) return;
    const ctx = this.ctx;
    // Fill the triangle with a cached whole-image pattern under the uv->
    // screen transform instead of save/clip/transform/drawImage/restore:
    // dense 3D sections (stage 5's bamboo grove runs hundreds of quads)
    // made the per-triangle clip+restore pair the single largest frame
    // cost — canvas clip stacks are expensive to unwind in software and
    // force pipeline flushes on GPU backends. The pattern samples the same
    // texels (the path is authored in atlas space), with the same edge
    // antialiasing behavior as the clipped drawImage.
    let pattern = this.trianglePatterns.get(img);
    if (!pattern) {
      const created = ctx.createPattern(img, 'no-repeat');
      if (!created) return;
      pattern = created;
      this.trianglePatterns.set(img, pattern);
    }
    const prev = ctx.getTransform();
    ctx.transform(a, b, c, d, e, f);
    ctx.beginPath();
    ctx.moveTo(u0, v0);
    ctx.lineTo(u1, v1);
    ctx.lineTo(u2, v2);
    ctx.closePath();
    ctx.fillStyle = pattern;
    ctx.fill();
    ctx.setTransform(prev);
  }

  // Returns a tinted copy of an atlas sub-rect (cached), for use as the
  // source image of a textured-quad draw. Public wrapper around the same
  // tint cache drawAnmFrame uses.
  tintedRect(imageKey: string, sx: number, sy: number, sw: number, sh: number, color: number): HTMLCanvasElement | null {
    const img = this.assets[imageKey];
    if (!img) return null;
    return this.tintedSpriteCanvas(img, sx, sy, sw, sh, color);
  }

  // Perspective-correct-enough textured quad: two affine triangles sharing
  // the tl/br diagonal. `corners` and `src` must already be in the same
  // coordinate space (src in atlas pixels if `img` is the full atlas, or in
  // 0..w/0..h local pixels if `img` is a pre-tinted sub-canvas).
  drawTexturedQuadCell(
    img: CanvasImageSource,
    src: { u0: number; v0: number; u1: number; v1: number },
    corners: { tl: { x: number; y: number }; tr: { x: number; y: number }; bl: { x: number; y: number }; br: { x: number; y: number } }
  ): void {
    this.drawAffineTriangle(
      img,
      src.u0, src.v0, corners.tl.x, corners.tl.y,
      src.u1, src.v0, corners.tr.x, corners.tr.y,
      src.u0, src.v1, corners.bl.x, corners.bl.y
    );
    this.drawAffineTriangle(
      img,
      src.u1, src.v0, corners.tr.x, corners.tr.y,
      src.u1, src.v1, corners.br.x, corners.br.y,
      src.u0, src.v1, corners.bl.x, corners.bl.y
    );
  }

  // Flat-fills a projected quad with a translucent fog color (distance fog).
  fillFogQuad(
    corners: { tl: { x: number; y: number }; tr: { x: number; y: number }; bl: { x: number; y: number }; br: { x: number; y: number } },
    color: string,
    alpha: number
  ): void {
    if (alpha <= 0.003) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(corners.tl.x, corners.tl.y);
    ctx.lineTo(corners.tr.x, corners.tr.y);
    ctx.lineTo(corners.br.x, corners.br.y);
    ctx.lineTo(corners.bl.x, corners.bl.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  clipPlayfield(fn: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(PLAYFIELD.x, PLAYFIELD.y, PLAYFIELD.width, PLAYFIELD.height);
    ctx.clip();
    fn();
    ctx.restore();
  }
}
