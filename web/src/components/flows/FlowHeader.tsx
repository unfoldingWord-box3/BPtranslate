// One header row for every flow screen (#299).
//
// App.tsx renders a single global chrome bar above the flow screens: a flexible
// slot on the inline-start side, the account/status controls on the inline-end
// side. A screen's own title row (back chevron, h1, count, actions)
// renders through <FlowHeader>, which portals it into that slot — so the screen
// title and the global controls share one row instead of stacking two bars.
// The bar sits outside the screen's scroll box, so it stays put without the
// old `position: sticky` wrappers. A screen that renders no <FlowHeader> (phone
// focus mode hides it on purpose) leaves the slot empty and only the controls
// show.
//
// Outside App's flow chrome (no slot provided), or with `inline` (a header that
// belongs to a side pane, not the page), it renders the old in-place sticky bar.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Box } from "@mui/material";

export const FlowHeaderSlotContext = createContext<HTMLElement | null>(null);

// Phone title box (#517). Below the tablet band a work screen's h1 is the short
// passage reference ("ZEC 6") and its caption the screen name. The box is sized
// by the h1 alone; the caption (inline-size contained, so it adds no width)
// fills whatever the row has left and ellipsizes under App's header-slot rule.
// When the toolbar is wider than idle (an "N unsaved" chip plus "offline", the
// update chip) the row gives way in order: the count first (PHONE_COUNT_SX's
// much larger flexShrink), then the caption, then the reference itself, so the
// back and prev/next buttons stay whole and clear of the toolbar.
export const PHONE_TITLE_SX = { flex: "1 1 auto", minWidth: 0, "& > p": { contain: "inline-size" } } as const;

// Phone count text ("Verse 12 of 15"): the first header item to give up width
// when the row would otherwise run under the account controls. Put it on the
// count's flex item (the element that is a direct child of the header row).
export const PHONE_COUNT_SX = { minWidth: 0, flexShrink: 1000, overflow: "hidden", textOverflow: "ellipsis" } as const;

type Props = { children: ReactNode; inline?: boolean; zIndex?: number };

export function FlowHeader({ children, inline, zIndex = 20 }: Props) {
  const slot = useContext(FlowHeaderSlotContext);
  if (slot && !inline) return createPortal(children, slot);
  return (
    <Box
      sx={{
        position: "sticky",
        insetBlockStart: 0,
        zIndex,
        flex: "none",
        bgcolor: "background.paper",
        borderBlockEnd: "1px solid",
        borderColor: "divider",
      }}
    >
      {children}
    </Box>
  );
}
