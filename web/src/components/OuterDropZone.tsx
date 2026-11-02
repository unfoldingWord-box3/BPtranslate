// The workspace PERIMETER drop zone — a frame of four bands around the whole
// arrangeable workspace. Dropping on one wraps the ENTIRE layout tree in a new
// split, so the dragged panel becomes a full-width band (top/bottom) or a
// full-height column (left/right).
//
// WHY IT EXISTS: every other drop target is scoped to a region that already
// exists. Once the user drags the scripture panel out of Flexible's full-width
// top band, that region is empty, normalizeTree deletes it, the root split
// collapses to its single surviving child — and no region-scoped gesture can ever
// rebuild a band spanning the whole workspace again. Dropping on a column's top
// edge only splits that column. The perimeter is the recovery gesture.
//
// DISCOVERABILITY is half the fix: the user could not find the capability, so all
// four bands are visibly inviting the moment a panel drag starts, and the hovered
// one previews the exact band that will be created.
//
// Rendered only from WorkspaceLayout's recursive (non-Classic) path, and the bands
// exist only while a PANEL drag is in flight — so Classic never sees it and normal
// interaction is never covered by an invisible frame.
//
// The pointer arithmetic (including RTL mirroring) is NOT here: it lives in
// lib/dropZone.ts (computeOuterDropTarget) so it can be unit-tested with no DOM.
// Everything painted here is positioned with CSS LOGICAL insets — via dropZone's
// shared `bandInsets`, which RegionDropZone paints its preview with too — so it is
// correct in both directions without mirroring anything itself. One helper for both
// preview paths is deliberate: they drifted apart once (the region preview went
// physical and was double-mirrored under RTL) and that must not recur.

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import {
  OUTER_BAND_PX,
  bandInsets,
  computeOuterDropBand,
  computeOuterDropTarget,
  isPointerInAnyOuterBand,
  type Direction,
  type OuterBandEdge,
} from "../lib/dropZone";
import type { OuterDropTarget } from "../lib/layoutTree";
import { useLayoutDrag } from "./LayoutDragContext";

const EDGES: OuterBandEdge[] = ["blockStart", "blockEnd", "inlineStart", "inlineEnd"];

interface Resolved {
  target: OuterDropTarget;
  edge: OuterBandEdge;
  // Fraction of the workspace the resulting band will occupy.
  size: number;
}

export function OuterDropZone() {
  const { t } = useTranslation();
  const drag = useLayoutDrag();
  const draggedPanelId = drag?.draggedPanelId ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Resolved | null>(null);
  const hoverKeyRef = useRef("");
  // ARMING. A band is drawn as soon as a drag starts (that visibility IS the
  // discoverability affordance) but it must not be a live drop target yet: the
  // drag grip of any panel whose header abuts a workspace edge lives INSIDE a
  // band, so the band would materialise under the cursor on mousedown, hijack the
  // gesture, and read to the user as "the handle doesn't work". Unarmed bands are
  // pointer-events:none, so events fall through to the RegionDropZone underneath
  // and ordinary region drops keep working; the first time the pointer is seen
  // outside all four bands we arm them and the perimeter behaves as before.
  const [armed, setArmed] = useState(false);

  const clear = useCallback(() => {
    if (hoverKeyRef.current !== "") {
      hoverKeyRef.current = "";
      setHover(null);
    }
  }, []);

  // Any end of the drag (drop elsewhere, Escape, dragend) must wipe the preview —
  // dragleave is not guaranteed to fire in those cases.
  useEffect(() => {
    if (!draggedPanelId) clear();
    // Every new drag starts disarmed, including a second drag of the same panel.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- runs after commit with clear(), which writes hoverKeyRef; a ref write cannot move into render, and splitting the two would let the arm reset and the hover wipe drift apart.
    setArmed(false);
  }, [draggedPanelId, clear]);

  // Watch for the pointer leaving the perimeter. The unarmed bands are
  // pointer-events:none, so they never see these events themselves — listen on
  // the document in the CAPTURE phase so a region's own dragover handler (which
  // preventDefaults and may stop propagation) cannot hide the move from us. A
  // pointer outside the workspace box entirely also counts as "outside all bands".
  useEffect(() => {
    if (!draggedPanelId || armed) return;
    const onDragOver = (e: DragEvent) => {
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const outside = !isPointerInAnyOuterBand({
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
        pointer: { x: e.clientX, y: e.clientY },
      });
      if (outside) setArmed(true);
    };
    document.addEventListener("dragover", onDragOver, true);
    return () => document.removeEventListener("dragover", onDragOver, true);
  }, [draggedPanelId, armed]);

  // Measure on demand rather than caching: the perimeter is only hit-tested while
  // the pointer is inside a 22px band, so this runs far less often than a region's
  // dragover, and a fresh rect is immune to a mid-drag resize.
  const resolve = useCallback((clientX: number, clientY: number): Resolved | null => {
    const el = ref.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    // Read the EFFECTIVE direction off the element (an ancestor carries `dir`),
    // never off a prop or theme flag.
    const computed = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const direction: Direction = computed?.direction === "rtl" ? "rtl" : "ltr";
    const target = computeOuterDropTarget({
      rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      pointer: { x: clientX, y: clientY },
      direction,
    });
    if (!target) return null;
    return { target, ...computeOuterDropBand(target) };
  }, []);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // Only PANEL drags concern us; the repo has other HTML5 drags (note
    // reordering) which must pass through untouched.
    if (!draggedPanelId || !armed) return;
    e.preventDefault(); // without this the browser never fires `drop`
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      /* ignore */
    }
    const next = resolve(e.clientX, e.clientY);
    const k = next ? next.edge : "";
    if (k === hoverKeyRef.current) return; // same band — no re-render
    hoverKeyRef.current = k;
    setHover(next);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId) return;
    // Ask where the pointer is GOING: moving between two adjacent bands never
    // leaves this frame, so a blanket clear here would flicker the preview off.
    const related = e.relatedTarget as Node | null;
    if (related && ref.current && ref.current.contains(related)) return;
    clear();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId || !drag || !armed) return;
    e.preventDefault();
    e.stopPropagation();
    // Recompute rather than trusting the last hover: a drop can arrive with no
    // preceding dragover tick.
    const resolved = resolve(e.clientX, e.clientY);
    clear();
    if (resolved) drag.commitDrop(resolved.target);
    drag.endDrag();
  };

  return (
    // zIndex sits above the regions' own preview overlays (zIndex 4) so the
    // perimeter wins whenever the pointer is inside a band.
    <Box ref={ref} sx={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}>
      {/* Bands exist ONLY while a panel is in flight — otherwise a frame of
          pointer-events:auto elements would sit on top of the workspace. */}
      {draggedPanelId !== null &&
        EDGES.map((edge) => (
          <Box
            key={edge}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            sx={{
              position: "absolute",
              // load-bearing: an ARMED band must RECEIVE dragover/drop, and an
              // unarmed one must NOT — see the arming comment above.
              pointerEvents: armed ? "auto" : "none",
              ...bandInsets(edge, `${OUTER_BAND_PX}px`),
              boxSizing: "border-box",
              border: "2px dashed",
              borderColor: hover?.edge === edge ? "primary.main" : "primary.light",
              bgcolor: "primary.main",
              // Three legible states: unarmed (faint), armed idle, hovered.
              opacity: hover?.edge === edge ? 0.4 : armed ? 0.14 : 0.07,
              borderRadius: 1,
              transition: "opacity 0.12s",
            }}
          />
        ))}
      {draggedPanelId !== null && hover && (
        // The resulting band, previewed at its real size. pointer-events:none —
        // an overlay that swallowed dragover would freeze the preview.
        <Box
          sx={{
            position: "absolute",
            ...bandInsets(hover.edge, `${hover.size * 100}%`),
            pointerEvents: "none",
            bgcolor: "primary.main",
            opacity: 0.18,
            border: "2px solid",
            borderColor: "primary.main",
            borderRadius: 1,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            variant="caption"
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: 1,
              bgcolor: "background.paper",
              color: "primary.main",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {t(hover.target.orientation === "vertical" ? "layout.dockFullWidth" : "layout.dockFullHeight")}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
