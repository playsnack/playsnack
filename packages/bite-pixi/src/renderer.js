// Bite renderer: draws a laid-out instance tree with Pixi and turns pointer
// input into runtime taps. Layout and hit-testing come from @snack/bite-layout,
// so what you see, what you tap and what headless gates check all agree.
import { Application, BlurFilter, Container, FillGradient, Graphics, Sprite, Text, Texture } from "pixi.js";
import { computeScene, hitTest, initLayout, scrollTargetAt } from "@snack/bite-layout";
import { fontFamily, loadFonts } from "./fonts.js";

const TAP_SLOP = 10; // px of finger travel before a press becomes a drag
const PRESS_SCALE = 0.96;
const IMAGE_PLACEHOLDER = "#1e2127";

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const radiusOf = (r, w, h) => (r === "full" ? Math.min(w, h) / 2 : Math.max(0, Math.min(num(r, 0), Math.min(w, h) / 2)));
const isColor = (c) => typeof c === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c);

function shapePath(g, w, h, style) {
  if (style.clip === "circle") return g.circle(w / 2, h / 2, Math.min(w, h) / 2);
  const r = radiusOf(style.radius, w, h);
  return r > 0 ? g.roundRect(0, 0, w, h, r) : g.rect(0, 0, w, h);
}

// CSS linear-gradient geometry (0 = to top, 90 = to right, 180 = to bottom):
// the gradient line runs through the center and its length makes the corners
// land exactly on the first/last color. Coordinates are in the box's pixels.
//
// Pixi 8.19 FillGradient quirk: it reverses the color ramp whenever the line
// points left or up (dx < 0 || dy < 0), and in the default clamp mode it also
// swaps endpoints per axis, which breaks diagonals. With wrapMode "repeat" the
// geometry is left alone, so we pre-reverse the stops to cancel the reversal.
function gradientFill(gradient, w, h) {
  const a = (num(gradient.angle, 180) * Math.PI) / 180;
  const snap = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  const dx = snap(Math.sin(a));
  const dy = snap(-Math.cos(a));
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const colors = (gradient.colors ?? []).filter(isColor);
  const reversed = dx < 0 || dy < 0;
  const stops = colors.map((color, i) => {
    const t = colors.length === 1 ? 0 : i / (colors.length - 1);
    return { offset: reversed ? 1 - t : t, color };
  });
  if (reversed) stops.reverse();
  return new FillGradient({
    type: "linear",
    start: { x: w / 2 - dx * half, y: h / 2 - dy * half },
    end: { x: w / 2 + dx * half, y: h / 2 + dy * half },
    colorStops: stops,
    textureSpace: "global",
    wrapMode: "repeat",
  });
}

class Entry {
  constructor(kind) {
    this.kind = kind;
    this.root = new Container();
    this.shadow = null;
    this.bg = new Graphics();
    this.content = new Container(); // children / text lines / image
    this.mask = null;
    this.overlay = null;
    this.gradient = null;
    this.root.addChild(this.bg, this.content);
    this.lines = [];
    this.sprite = null;
    this.imageUrl = null;
    this.sig = "";
  }
  destroy() {
    this.gradient?.destroy();
    this.root.destroy({ children: true });
  }
}

/**
 * Mount a Bite app into `el`.
 * `interactive: false` ignores pointer input (editors handle it); `paused: true`
 * stops advancing the runtime (a frozen frame to edit on).
 * @param {{ el: HTMLElement, doc: object, app: import("@snack/bite").BiteApp, fontBase?: string, background?: string, debug?: boolean, interactive?: boolean, paused?: boolean }} opts
 */
export async function mountBite({ el, doc, app, fontBase = "/fonts", background = "#0b0c0e", debug = false, interactive = true, paused = false }) {
  await Promise.all([initLayout(), loadFonts(doc, fontBase)]);

  const [fw, fh] = doc.frame ?? [390, 844];
  const pixi = new Application();
  await pixi.init({
    resizeTo: el,
    background,
    antialias: true,
    resolution: Math.min(globalThis.devicePixelRatio || 1, 3),
    autoDensity: true,
  });
  const canvas = pixi.canvas;
  canvas.style.touchAction = "none";
  canvas.style.display = "block";
  el.appendChild(canvas);

  const frame = new Container();
  const frameMask = new Graphics().rect(0, 0, fw, fh).fill(0xffffff);
  frame.addChild(frameMask);
  frame.mask = frameMask;
  pixi.stage.addChild(frame);

  const entries = new Map();
  const scroll = new Map();
  const images = new Map(); // url → Promise<Texture | null>
  let scene = computeScene(doc, app);
  let scale = 1;
  let pressed = null;
  let destroyed = false;

  const fit = () => {
    const { width, height } = pixi.screen;
    scale = Math.min(width / fw, height / fh);
    frame.scale.set(scale);
    frame.position.set((width - fw * scale) / 2, (height - fh * scale) / 2);
    for (const e of entries.values()) e.sig = ""; // re-render text at the new resolution
    draw();
  };

  const loadImage = (url) => {
    if (!images.has(url)) {
      images.set(
        url,
        new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(Texture.from(img));
          img.onerror = () => resolve(null);
          img.src = url;
        }),
      );
    }
    return images.get(url);
  };

  // ── drawing ──────────────────────────────────────────────────────────────
  function strokePath(g, w, h, s) {
    const sw = num(s.stroke.width, 1);
    if (s.clip === "circle") g.circle(w / 2, h / 2, Math.min(w, h) / 2 - sw / 2);
    else {
      const r = Math.max(0, radiusOf(s.radius, w, h) - sw / 2);
      if (r > 0) g.roundRect(sw / 2, sw / 2, w - sw, h - sw, r);
      else g.rect(sw / 2, sw / 2, w - sw, h - sw);
    }
    g.stroke({ width: sw, color: s.stroke.color }); // drawn inside the box, like a CSS border
  }

  function drawBox(e, inst, { strokeOnTop = false } = {}) {
    const { w, h } = inst.box;
    const s = inst.style;
    if (s.shadow && isColor(s.shadow.color)) {
      if (!e.shadow) {
        e.shadow = new Graphics();
        e.root.addChildAt(e.shadow, 0);
      }
      e.shadow.clear();
      shapePath(e.shadow, w, h, s).fill(s.shadow.color);
      e.shadow.position.set(num(s.shadow.x, 0), num(s.shadow.y, 0));
      const blur = num(s.shadow.blur, 0);
      for (const f of e.shadow.filters ?? []) f.destroy();
      e.shadow.filters = blur > 0 ? [new BlurFilter({ strength: blur / 2, quality: 3 })] : [];
    } else if (e.shadow) {
      e.shadow.destroy();
      e.shadow = null;
    }

    e.bg.clear();
    e.gradient?.destroy();
    e.gradient = null;
    if (s.gradient?.colors?.length >= 2) shapePath(e.bg, w, h, s).fill((e.gradient = gradientFill(s.gradient, w, h)));
    else if (isColor(s.fill)) shapePath(e.bg, w, h, s).fill(s.fill);

    const stroked = s.stroke && isColor(s.stroke.color);
    if (stroked && !strokeOnTop) strokePath(e.bg, w, h, s);
    if (stroked && strokeOnTop) {
      if (!e.overlay) {
        e.overlay = new Graphics();
        e.root.addChild(e.overlay);
      }
      e.overlay.clear();
      strokePath(e.overlay, w, h, s);
    } else if (e.overlay) {
      e.overlay.destroy();
      e.overlay = null;
    }

    const clip = s.clip || s.scroll;
    if (clip) {
      if (!e.mask) {
        e.mask = new Graphics();
        e.root.addChild(e.mask);
        e.content.mask = e.mask;
      }
      e.mask.clear();
      shapePath(e.mask, w, h, s).fill(0xffffff);
    } else if (e.mask) {
      e.content.mask = null;
      e.mask.destroy();
      e.mask = null;
    }
  }

  function drawText(e, inst) {
    const s = inst.style;
    const { lines, lineHeight, weight } = inst.text;
    const resolution = Math.min(globalThis.devicePixelRatio || 1, 3) * scale;
    const style = {
      fontFamily: fontFamily(s.font),
      fontSize: num(s.size, 15),
      fontWeight: String(weight),
      fill: isColor(s.color) ? s.color : "#ffffff",
      lineHeight,
    };
    while (e.lines.length > lines.length) e.lines.pop().destroy();
    lines.forEach((line, i) => {
      let t = e.lines[i];
      if (!t) {
        t = new Text({ text: line.text, style });
        e.lines.push(t);
        e.content.addChild(t);
      } else {
        t.text = line.text;
        t.style = style;
      }
      t.resolution = resolution;
      const w = inst.box.w;
      t.x = s.align === "center" ? (w - line.width) / 2 : s.align === "right" ? w - line.width : 0;
      t.y = i * lineHeight;
    });
  }

  function drawImage(e, inst) {
    const { w, h } = inst.box;
    const s = inst.style;
    // Images always clip to their box; the placeholder shows until the texture arrives.
    drawBox(e, { box: inst.box, style: { ...s, fill: IMAGE_PLACEHOLDER, gradient: undefined, clip: s.clip ?? true } }, { strokeOnTop: true });

    const url = inst.content;
    e.imageUrl = url;
    if (!url) {
      if (e.sprite) e.sprite.visible = false;
      return;
    }
    loadImage(url).then((tex) => {
      if (destroyed || e.imageUrl !== url || !tex) return;
      if (!e.sprite) {
        e.sprite = new Sprite();
        e.content.addChild(e.sprite);
      }
      e.sprite.texture = tex;
      e.sprite.visible = true;
      const k = s.fit === "contain" ? Math.min(w / tex.width, h / tex.height) : Math.max(w / tex.width, h / tex.height);
      e.sprite.scale.set(k);
      e.sprite.x = (w - tex.width * k) / 2;
      e.sprite.y = s.focus === "top" ? 0 : (h - tex.height * k) / 2;
    });
  }

  function place(e, inst) {
    const s = inst.style;
    const { x, y, w, h } = inst.box;
    const [ox, oy] = Array.isArray(s.origin) ? s.origin : [0.5, 0.5];
    const px = num(ox, 0.5) * w;
    const py = num(oy, 0.5) * h;
    e.root.pivot.set(px, py);
    e.root.position.set(x + px, y + py);
    e.root.rotation = (num(s.rotate, 0) * Math.PI) / 180;
    const k = num(s.scale, 1) * (pressed === inst.key ? PRESS_SCALE : 1);
    e.root.scale.set(k);
    e.root.alpha = Math.max(0, Math.min(1, num(s.opacity, 1)));
    const off = scroll.get(inst.key);
    e.content.position.set(off ? -off.x : 0, off ? -off.y : 0);
  }

  function reconcile(inst, parent, seen) {
    let e = entries.get(inst.key);
    if (!e || e.kind !== inst.kind) {
      e?.destroy();
      e = new Entry(inst.kind);
      entries.set(inst.key, e);
    }
    seen.add(inst.key);
    parent.addChild(e.root); // re-adding keeps paint order equal to tree order
    place(e, inst);

    const sig = JSON.stringify([inst.box.w, inst.box.h, inst.style, inst.content, inst.text?.lines, scale]);
    if (sig !== e.sig) {
      e.sig = sig;
      if (inst.kind === "text") drawText(e, inst);
      else if (inst.kind === "image") drawImage(e, inst);
      else drawBox(e, inst);
    }
    if (inst.kind === "box") for (const c of inst.children) reconcile(c, e.content, seen);
  }

  function draw() {
    if (destroyed) return;
    const seen = new Set();
    reconcile(scene.root, frame, seen);
    for (const [key, e] of entries) {
      if (!seen.has(key)) {
        e.destroy();
        entries.delete(key);
        scroll.delete(key);
      }
    }
  }

  const refresh = () => {
    scene = computeScene(doc, app);
    draw();
  };

  // ── input ────────────────────────────────────────────────────────────────
  const toFrame = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - frame.x) / scale, y: (ev.clientY - r.top - frame.y) / scale };
  };
  let gesture = null;
  const onDown = (ev) => {
    const p = toFrame(ev);
    const hit = hitTest(scene.root, p.x, p.y, scroll);
    const scroller = scrollTargetAt(scene.root, p.x, p.y, scroll);
    gesture = { id: ev.pointerId, start: p, hit, scroller, from: scroll.get(scroller?.key)?.y ?? 0, dragging: false };
    if (hit) {
      pressed = hit.key; // instant press feedback
      draw();
    }
    canvas.setPointerCapture?.(ev.pointerId);
  };
  const onMove = (ev) => {
    if (!gesture || ev.pointerId !== gesture.id) return;
    const p = toFrame(ev);
    const dy = p.y - gesture.start.y;
    if (!gesture.dragging && Math.hypot(p.x - gesture.start.x, dy) * scale > TAP_SLOP) {
      gesture.dragging = true;
      if (pressed) {
        pressed = null;
        draw();
      }
    }
    const sc = gesture.scroller;
    if (gesture.dragging && sc?.contentSize) {
      const max = Math.max(0, sc.contentSize.h - sc.box.h);
      scroll.set(sc.key, { x: 0, y: Math.max(0, Math.min(max, gesture.from - dy)) });
      draw();
    }
  };
  const onUp = (ev) => {
    if (!gesture || ev.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    pressed = null;
    if (ev.type === "pointerup" && !g.dragging && g.hit?.tap) {
      const p = toFrame(ev);
      const again = hitTest(scene.root, p.x, p.y, scroll);
      if (again?.key === g.hit.key) app.tap(g.hit.tap.node, g.hit.tap.scope);
    }
    refresh(); // show the tap's result in this frame, not the next
  };
  if (interactive) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
  }

  // ── frame loop ───────────────────────────────────────────────────────────
  const onTick = () => {
    if (paused) return;
    const changed = app.tick();
    if (changed.some((name) => scene.deps.has(name))) refresh();
  };
  pixi.ticker.add(onTick);
  pixi.renderer.on("resize", fit);
  fit();

  const handle = {
    pixi,
    get scene() {
      return scene;
    },
    get scale() {
      return scale;
    },
    scroll,
    /** Frame point → client (CSS) point, for tests that tap by coordinates. */
    toClient(x, y) {
      const r = canvas.getBoundingClientRect();
      return { x: r.left + frame.x + x * scale, y: r.top + frame.y + y * scale };
    },
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      pixi.ticker.remove(onTick);
      for (const e of entries.values()) e.destroy();
      entries.clear();
      pixi.destroy({ removeView: true }, { children: true });
      if (debug && globalThis.__bite === handle) delete globalThis.__bite;
    },
  };
  if (debug) globalThis.__bite = Object.assign(handle, { app, doc });
  return handle;
}
