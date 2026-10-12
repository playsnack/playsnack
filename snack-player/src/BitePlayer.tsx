import { useEffect, useRef } from "react";
import { createBite, type BiteApp, type BiteDoc } from "@snack/bite";
import { absBoxes, type Instance } from "@snack/bite-layout";
import { mountBite, type BiteView } from "@snack/bite-pixi";
import { loadAppData } from "./backend";

export type TextSelection = { layerId: string; rect: DOMRect; text: string; editable: boolean } | null;
export type EditableRect = { layerId: string; editable: boolean; rect: { left: number; top: number; width: number; height: number } };

type Props = {
  doc: BiteDoc;
  /** Outbound social actions: the app's `emit` actions. */
  onHostEvent?: (e: { name: string; payload?: unknown }) => void;
  /** Called once the app is running; the host feeds server state via setVar. */
  onReady?: (app: BiteApp) => void;
  /** Edit mode: the app is frozen and taps select text instead of playing. */
  editable?: boolean;
  /** Phase shown while editing (default: the document's start phase). */
  editPhase?: string;
  onSelectText?: (sel: TextSelection) => void;
  /** Visible text nodes (editable = plain authored text, not data-driven). */
  onEditableRects?: (items: EditableRect[]) => void;
};

// Text nodes the editor can offer: they have an id, sit outside `each` lists and
// components, and are visible in the shown phase. Editable only when the text is
// plain authored copy — anything with a `{…}` template is driven by data.
function editableTexts(root: Instance) {
  const out: { inst: Instance; editable: boolean; text: string }[] = [];
  const walk = (inst: Instance, inComponent: boolean) => {
    const comp = inComponent || Boolean(inst.source);
    if (inst.kind === "text" && !comp && inst.node.id && !inst.key.includes("#")) {
      const text = String(inst.node.text ?? "");
      out.push({ inst, editable: !text.includes("{"), text });
    }
    inst.children.forEach((c) => walk(c, comp));
  };
  walk(root, false);
  return out;
}

/** Plays a Bite document: runtime + Pixi renderer, sized to the parent. */
export function BitePlayer({ doc, onHostEvent, onReady, editable = false, editPhase, onSelectText, onEditableRects }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const hostEventRef = useRef(onHostEvent);
  hostEventRef.current = onHostEvent;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const selectRef = useRef(onSelectText);
  selectRef.current = onSelectText;
  const rectsRef = useRef(onEditableRects);
  rectsRef.current = onEditableRects;

  useEffect(() => {
    const el = ref.current!;
    let disposed = false;
    let view: BiteView | null = null;
    const runDoc = editable && editPhase && doc.phases?.[editPhase] ? { ...doc, start: editPhase } : doc;
    const app = createBite(runDoc);
    app.on("emit", (e) => hostEventRef.current?.(e));
    app.start();
    if (doc.data?.url) {
      loadAppData(doc.data.url)
        .then((data) => {
          if (!data || disposed) return;
          app.setVars(data);
          if (editable) view?.refresh(); // frozen frame: redraw with the content
        })
        .catch((e) => console.warn("[bite] data fetch failed", e));
    }

    const texts = () => {
      if (!view) return [];
      const boxes = absBoxes(view.scene.root, view.scroll);
      return editableTexts(view.scene.root).map(({ inst, editable: canEdit, text }) => {
        const b = boxes.get(inst.key)!;
        const tl = view!.toClient(b.x, b.y);
        const br = view!.toClient(b.x + b.w, b.y + b.h);
        return { layerId: inst.node.id as string, editable: canEdit, text, rect: { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y } };
      });
    };
    // CAPTURE phase so the canvas never sees edit-mode taps; mousedown is
    // cancelled so the editor's freshly focused <input> keeps focus.
    const onEditPointer = (e: PointerEvent) => {
      const hits = texts().filter(
        (t) => e.clientX >= t.rect.left && e.clientX <= t.rect.left + t.rect.width && e.clientY >= t.rect.top && e.clientY <= t.rect.top + t.rect.height,
      );
      hits.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const hit = hits[0];
      selectRef.current?.(hit ? { layerId: hit.layerId, rect: new DOMRect(hit.rect.left, hit.rect.top, hit.rect.width, hit.rect.height), text: hit.text, editable: hit.editable } : null);
    };
    const onEditMouseDown = (e: MouseEvent) => e.preventDefault();

    mountBite({ el, doc: runDoc, app, debug: true, interactive: !editable, paused: editable, fontBase: `${import.meta.env.BASE_URL}fonts` }).then((v) => {
      if (disposed) {
        v.destroy();
        return;
      }
      view = v;
      if (editable) {
        el.addEventListener("pointerdown", onEditPointer, true);
        el.addEventListener("mousedown", onEditMouseDown, true);
        rectsRef.current?.(texts().map(({ layerId, editable: e, rect }) => ({ layerId, editable: e, rect })));
      }
      readyRef.current?.(app);
    });
    return () => {
      disposed = true;
      el.removeEventListener("pointerdown", onEditPointer, true);
      el.removeEventListener("mousedown", onEditMouseDown, true);
      view?.destroy();
    };
  }, [doc, editable, editPhase]);

  // Below the notch (safe-area inset, see index.html) — the shell pills use the
  // same inset, so they never cover the app's top row on a notch phone.
  return <div ref={ref} style={{ position: "fixed", top: "var(--snack-safe-top)", left: 0, right: 0, bottom: 0, background: "#0b0c0e" }} />;
}
