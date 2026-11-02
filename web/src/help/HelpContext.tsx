import { createContext } from "react";

export interface HelpContextValue {
  /** Guide route key of the screen on show (see guideMap.routeKey), or null. */
  routeKey: string | null;
  /**
   * Open the Help panel: on `articleId` when given, else on the current screen's
   * article. Focus returns to `returnFocus` on close (default: the element
   * focused now), so a menu item that unmounts can hand over its menu button.
   */
  openHelp: (articleId?: string, returnFocus?: HTMLElement | null) => void;
}

export const HelpContext = createContext<HelpContextValue>({
  routeKey: null,
  openHelp: () => {},
});
