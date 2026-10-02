import { createContext } from "react";

export interface HelpContextValue {
  /** Guide route key of the screen on show (see guideMap.routeKey), or null. */
  routeKey: string | null;
  /** Open the Help panel: on `articleId` when given, else on the current screen's article. */
  openHelp: (articleId?: string) => void;
}

export const HelpContext = createContext<HelpContextValue>({
  routeKey: null,
  openHelp: () => {},
});
