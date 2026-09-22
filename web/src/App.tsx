import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Box, Button, Chip, CircularProgress, Link, Snackbar, Stack, Tooltip, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Shell } from "./components/Shell";
import { ArticleWorkspace } from "./components/ArticleWorkspace";
import { TopBar, UiLanguageControl } from "./components/TopBar";
import { SyncStatusBar } from "./components/SyncStatusBar";
import { PipelineStatusBar } from "./components/PipelineStatusBar";
import { AccountMenu } from "./components/AccountMenu";
import { TemplateWorkspace } from "./components/TemplateWorkspace";
import { PreferencesWorkspace, ALL_SECTIONS as PREFS_SECTIONS, type Section as PrefsSection } from "./components/PreferencesWorkspace";
import { LocalizationInspector } from "./components/LocalizationInspector";
import { useBook } from "./hooks/useBook";
import { useAlerts } from "./hooks/useAlerts";
import { useAppVersion } from "./hooks/useAppVersion";
import {
  authLogout,
  devSignIn,
  fetchAuthMe,
  onAuthError,
  onAuthRefreshed,
  setReadOnly,
  setIsAdmin,
  updateLastLocation,
  type MeResponse,
  type Role,
} from "./sync/api";
import { setPipelineUser } from "./sync/pipelineStore";
import { getWorkspaceSlug, setWorkspaceSlug, setWorkspaceIsFallback } from "./sync/workspace";
import {
  WorkspaceChoiceDialog,
  markChooseWsPending,
  isChooseWsPending,
} from "./components/WorkspaceChoiceDialog";

type Location =
  | { view: "chapter"; book: string; chapter: number; verse: number }
  | { view: "article"; resource: "tw" | "ta"; articleId: string | null }
  | { view: "templates"; templateId: string | null }
  | { view: "preferences"; section: PrefsSection }
  | { view: "ai" }
  | { view: "style" }
  | { view: "curate"; templateId: string | null }
  | { view: "books"; book: string | null }
  | { view: "observe" }
  | { view: "notes"; book: string; chapter: number; verse: number | null; rowId: string | null }
  | { view: "questions"; book: string; chapter: number; verse: number | null; rowId: string | null }
  | { view: "package"; book: string }
  | { view: "translateWords"; book: string }
  | { view: "translateScripture"; book: string; chapter: number }
  | { view: "translateAlign"; book: string; chapter: number; verse: number; mode: "single" | "dual" }
  | { view: "admin"; section: "team" | "setup" | "workflow" | "progress" };

// The position (book/chapter/verse) a route represents, for recording the
// user's last location so the Books "Continue" card can jump them back. Returns
// null for routes that carry no working position — the package hub (#/package/
// {BOOK} is a book with no chapter/verse: browsing, not working, so it must not
// overwrite a precise stored position with 1:1) and every non-scripture view.
//
// NOTE on view names (#200): the redesign routes the issue targets parse to the
// `translate*` views, NOT the same-named old-flow views. `#/scripture/{BOOK}
// [/{CH}]` → `translateScripture` (the `ts` regex claims the 1–2 segment arity
// ahead of the old 3-segment `scripture`); `#/alignment/{BOOK}/{CH}[/{VS}]` →
// `translateAlign`. `translateScripture` carries no verse, so it records verse 1.
function positionFromLoc(loc: Location): { book: string; chapter: number; verse: number } | null {
  switch (loc.view) {
    case "chapter":
    case "translateAlign":
      return { book: loc.book, chapter: loc.chapter, verse: loc.verse };
    case "notes":
    case "questions":
      return { book: loc.book, chapter: loc.chapter, verse: loc.verse ?? 1 };
    case "translateScripture":
      return { book: loc.book, chapter: loc.chapter, verse: 1 };
    default:
      return null;
  }
}

// Flow screens (docs/flows port) are lazy so their weight isn't paid on the
// classic editor routes. Stubs today; replaced screen-by-screen in this stack.
const AiScreen = lazy(() => import("./components/flows/AiScreen"));
const StyleScreen = lazy(() => import("./components/flows/StyleScreen"));
const CurateScreen = lazy(() => import("./components/flows/CurateScreen"));
const BooksScreen = lazy(() => import("./components/flows/BooksScreen"));
const ObserveScreen = lazy(() => import("./components/flows/ObserveScreen"));
const TranslateNotesScreen = lazy(() => import("./components/flows/TranslateNotesScreen"));
const TranslateQuestionsScreen = lazy(() => import("./components/flows/TranslateQuestionsScreen"));
const TranslateScriptureScreen = lazy(() => import("./components/flows/TranslateScriptureScreen"));
const TranslateWordsScreen = lazy(() => import("./components/flows/TranslateWordsScreen"));
const PackageHubScreen = lazy(() => import("./components/flows/PackageHubScreen"));
const TranslateAlignScreen = lazy(() => import("./components/flows/TranslateAlignScreen"));
const AdminTeamScreen = lazy(() => import("./components/flows/AdminTeamScreen"));
const AdminSetupScreen = lazy(() => import("./components/flows/AdminSetupScreen"));
const AdminWorkflowScreen = lazy(() => import("./components/flows/AdminWorkflowScreen"));
const AdminProgressScreen = lazy(() => import("./components/flows/AdminProgressScreen"));

// OBA (Obadiah) is the shortest book in the canon — one chapter, 21 verses.
// Used as the fallback book code for partial routes (e.g. a hash with a
// chapter/verse but no book) and as the initial book for useBook before a
// chapter view is active. The default landing page is Books (#/books), not
// a chapter view, so this no longer controls landing-page load weight.
const DEFAULT_BOOK = "OBA";

// Set when the user explicitly clicks "Sign out". Read at boot to suppress
// the dev-mode silent re-mint and show the signed-out screen instead.
// This is a UX flag only — auth state lives in HttpOnly cookies and is
// gone by the time we read this. Cleared on next successful sign-in.
const SIGNED_OUT_KEY = "bible-editor.signed_out";

// Guards the boot-time workspace reconciliation below from looping forever
// if the server and localStorage can never agree (shouldn't happen, but a
// persistent mismatch must not reload-loop the tab). Cleared once the two
// agree so a later genuine mismatch (e.g. a stale cookie from another tab)
// still gets one reconciliation attempt.
const WS_RECONCILED_KEY = "bible-editor.ws-reconciled";

// Organization name shown (bold) inside the read-only viewer banner. A brand
// name, so it is deliberately NOT a translatable string.
const VIEWER_ORG = "unfoldingWord";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Rewrites the URL of a retired route so the stale hash doesn't stick around.
// replaceState deliberately does NOT fire hashchange, so the Loc the caller
// returns alongside this call is what actually renders — same contract the
// legacy #/import redirect below has always used.
//
// location.search is preserved: parseHash runs in App's FIRST useState
// initializer, ahead of the ones that read ?_auth_denied / ?_choose_ws, so
// dropping the query here would silently swallow the denied screen or the
// workspace picker for anyone arriving with both a retired hash and one of
// those params.
function retire(next: string) {
  history.replaceState(null, "", location.pathname + location.search + next);
}

function parseHash(): Location {
  const pm = location.hash.match(/^#\/preferences(?:\/(\w+))?$/);
  if (pm) {
    const s = pm[1] as PrefsSection | undefined;
    return { view: "preferences", section: s && PREFS_SECTIONS.includes(s) ? s : "brief" };
  }
  const am = location.hash.match(/^#\/articles\/(tw|ta)(?:\/(.+))?$/);
  if (am) {
    return {
      view: "article",
      resource: am[1] as "tw" | "ta",
      articleId: decodeURIComponent(am[2] ?? "") || null,
    };
  }
  const tm = location.hash.match(/^#\/templates(?:\/(.+))?$/);
  if (tm) {
    return { view: "templates", templateId: decodeURIComponent(tm[1] ?? "") || null };
  }
  // Legacy #/import[/BOOK[/CH[/VERSE]]] — the standalone IMPORT surface was
  // retired once BooksScreen's "Bring in this book" sheet landed (PR #305's
  // A3; docs/ux-simplification.md §2.1). The book carries over to #/books/:book
  // so a reference-box nav to an un-imported book still lands on that book;
  // the chapter/verse tail is dropped because the new flow opens a book at its
  // package hub (#/package/:book), which is not verse-addressable.
  const im = location.hash.match(/^#\/import(?:\/([A-Za-z0-9]+)(?:\/\d+)?(?:\/\d+)?)?$/);
  if (im) {
    const book = im[1] ? im[1].toUpperCase() : null;
    const next = book ? `#/books/${book}` : "#/books";
    // replaceState doesn't fire hashchange, so the returned Loc below is what
    // renders — this only stops the stale #/import URL from sticking around.
    history.replaceState(null, "", location.pathname + next);
    return { view: "books", book };
  }
  // Retired #/review/BOOK[/CH] — the old flows review queue (ReviewQueue.tsx +
  // the Review* panels) was deleted with the rest of the old flows screens
  // (#173). Its only entry points were HomeScreen's two queue cards and the
  // FlowNav pill bar, both deleted in the same change. Notes are the queue's
  // main workload, so a stale bookmark lands on the redesigned notes screen for
  // that chapter; #/questions is one tap away from the package hub. The
  // reviewer-only actions the queue carried (restore/hint/preserve, edit
  // history, bulk approve, the tQ grid) have no new-UI home yet — #390.
  const rv = location.hash.match(/^#\/review\/([A-Za-z0-9]+)(?:\/(\d+))?$/);
  if (rv) {
    const book = rv[1].toUpperCase();
    const chapter = rv[2] ? parseInt(rv[2], 10) : 1;
    retire(`#/notes/${book}/${chapter}`);
    return { view: "notes", book, chapter, verse: null, rowId: null };
  }
  // Optional ?row={id} tail: the SyncStatusBar "N unsaved" jump menu uses it to
  // land on the exact note holding the draft — a verse can carry several notes,
  // and without the id the screen can only seek to the verse's first card.
  const nt = location.hash.match(/^#\/notes\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?(?:\?row=([^&]+))?$/);
  if (nt) {
    return {
      view: "notes",
      book: nt[1].toUpperCase(),
      chapter: nt[2] ? parseInt(nt[2], 10) : 1,
      verse: nt[3] ? parseInt(nt[3], 10) : null,
      // Guarded decode: a hand-mangled percent sequence ("?row=%E0") would
      // otherwise throw out of parseHash and blank the app on load. Fall back
      // to the raw capture — a wrong id just degrades to the verse seek.
      rowId: nt[4] ? safeDecode(nt[4]) : null,
    };
  }
  // Optional verse + ?row={id} tail, mirroring the #/notes form above: the
  // SyncStatusBar "N unsaved" jump menu uses them to land on the exact question
  // holding the draft, not just the chapter. The bare #/questions/{book}/{ch}
  // form still parses (verse/rowId null) for backward compatibility.
  const qn = location.hash.match(/^#\/questions\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?(?:\?row=([^&]+))?$/);
  if (qn) {
    return {
      view: "questions",
      book: qn[1].toUpperCase(),
      chapter: qn[2] ? parseInt(qn[2], 10) : 1,
      verse: qn[3] ? parseInt(qn[3], 10) : null,
      // Guarded decode (see the #/notes case): a mangled percent sequence must
      // not throw out of parseHash and blank the app; a wrong id just degrades
      // to the verse seek.
      rowId: qn[4] ? safeDecode(qn[4]) : null,
    };
  }
  // Flow screens (docs/flows port). Parameterless routes are single reserved
  // tokens; none collide with 3-letter USFM book codes in the catch-all below.
  // Retired parameterless flows routes (#173): #/home is now Books, the
  // standalone #/setup and #/team pages are the admin desk's own sections, and
  // the bare #/articles list is the classic article workspace (which the desk
  // and the translate screens both still link into as #/articles/tw|ta).
  if (/^#\/home$/.test(location.hash)) {
    retire("#/books");
    return { view: "books", book: null };
  }
  if (/^#\/articles$/.test(location.hash)) {
    retire("#/articles/tw");
    return { view: "article", resource: "tw", articleId: null };
  }
  if (/^#\/setup$/.test(location.hash)) {
    retire("#/admin/setup");
    return { view: "admin", section: "setup" };
  }
  if (/^#\/team$/.test(location.hash)) {
    retire("#/admin/team");
    return { view: "admin", section: "team" };
  }
  if (/^#\/ai$/.test(location.hash)) return { view: "ai" };
  if (/^#\/style$/.test(location.hash)) return { view: "style" };
  const bk = location.hash.match(/^#\/books(?:\/([A-Za-z0-9]+))?$/);
  if (bk) return { view: "books", book: bk[1] ? bk[1].toUpperCase() : null };
  if (/^#\/observe$/.test(location.hash)) return { view: "observe" };
  const cu = location.hash.match(/^#\/curate(?:\/(.+))?$/);
  if (cu) {
    return { view: "curate", templateId: decodeURIComponent(cu[1] ?? "") || null };
  }
  // Titus-redesign routes. #/scripture and #/words used to be arity-split (1–2
  // segments = the new translate screens, 3 = the old flows screens); the old
  // screens are gone (#173), so these now claim the route outright and the
  // legacy verse-level arity is handled as a retired form below.
  const pk = location.hash.match(/^#\/package\/([A-Za-z0-9]+)$/);
  if (pk) {
    return { view: "package", book: pk[1].toUpperCase() };
  }
  const wb = location.hash.match(/^#\/words\/([A-Za-z0-9]+)$/);
  if (wb) {
    return { view: "translateWords", book: wb[1].toUpperCase() };
  }
  const ts = location.hash.match(/^#\/scripture\/([A-Za-z0-9]+)(?:\/(\d+))?$/);
  if (ts) {
    return {
      view: "translateScripture",
      book: ts[1].toUpperCase(),
      chapter: ts[2] ? parseInt(ts[2], 10) : 1,
    };
  }
  // Redesigned admin desk (#/admin/{section}); AdminDesk renders the rail.
  const ad = location.hash.match(/^#\/admin\/(team|setup|workflow|progress)$/);
  if (ad) {
    return { view: "admin", section: ad[1] as "team" | "setup" | "workflow" | "progress" };
  }
  // #/alignment (redesign) is distinct from the retired #/align handled below.
  // Must sit above the final book-code catch-all, which is unanchored and would
  // swallow "alignment" as a book.
  const al = location.hash.match(/^#\/alignment\/([A-Za-z0-9]+)\/(\d+)(?:\/(\d+))?(\/dual)?$/);
  if (al) {
    return {
      view: "translateAlign",
      book: al[1].toUpperCase(),
      chapter: parseInt(al[2], 10),
      verse: al[3] ? parseInt(al[3], 10) : 1,
      mode: al[4] ? "dual" : "single",
    };
  }
  // Retired verse-level flows arities (#173). These used to open ScriptureScreen
  // / AlignScreen / WordsScreen / VerseScreen; those files are gone. Without an
  // explicit redirect a stale bookmark would fall through to the unanchored
  // book-code catch-all below and render an empty chapter of a book called
  // "SCRIPTURE" / "ALIGN" / "WORDS" / "VERSE" — a broken screen, not a 404. The
  // 1–2 segment #/scripture and #/words forms never reach here (claimed above);
  // only the legacy longer forms and the bare #/align, #/verse do.
  //
  // This covers the arities the deleted screens actually produced, not every
  // near miss: a hand-typed #/review, #/team/ or #/align/GEN/3/5/dual still
  // reaches the catch-all and renders that garbage book. Unchanged from before
  // this deletion, and closing it means anchoring the catch-all — a separate
  // change with its own blast radius.
  const fv = location.hash.match(
    /^#\/(scripture|align|words|verse)(?:\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?)?$/,
  );
  if (fv) {
    const book = fv[2] ? fv[2].toUpperCase() : DEFAULT_BOOK;
    const chapter = fv[3] ? parseInt(fv[3], 10) : 1;
    const verse = fv[4] ? parseInt(fv[4], 10) : 1;
    // #/align keeps its verse (the redesigned aligner is verse-addressable);
    // #/words is per-book; #/scripture and the verse overview land on the
    // redesigned scripture queue for that chapter, the closest live surface.
    // That chapter-not-verse landing is the gap tracked by #389.
    if (fv[1] === "align") {
      retire(`#/alignment/${book}/${chapter}/${verse}`);
      return { view: "translateAlign", book, chapter, verse, mode: "single" };
    }
    if (fv[1] === "words") {
      retire(`#/words/${book}`);
      return { view: "translateWords", book };
    }
    retire(`#/scripture/${book}/${chapter}`);
    return { view: "translateScripture", book, chapter };
  }
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  if (!m) return { view: "books", book: null };
  return {
    view: "chapter",
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
  };
}

// Auth gate. The API requires a valid Access cookie for every write, so we
// must have one before mounting the editor — otherwise every save 401s.
//
// Boot sequence:
//   1. If the URL has ?_auth_denied=1, the OAuth callback rejected this DCS
//      account (not on the editor allowlist). Show the denied screen.
//   2. Otherwise call /api/auth/me. The HttpOnly Access cookie is sent
//      automatically; we never see the token itself. On 200 → ready; on
//      401 → fall through.
//   3. If the user explicitly signed out (SIGNED_OUT_KEY), stay in missing
//      — block the dev silent re-mint so the "Sign in with Door43" flow
//      is required after logout.
//   4. In dev mode, attempt /api/auth/dev silent mint. If 404 (disabled)
//      or any other failure → missing.
//   5. In prod, fall straight to missing.
type AuthState =
  | { kind: "loading" }
  | { kind: "ready"; me: MeResponse | null; role: Role }
  | { kind: "missing" }                            // not signed in — show "Sign in with Door43"
  | { kind: "denied"; username: string | null; orgName: string | null }    // signed in but not on editor allowlist
  | { kind: "error"; message: string };

function isSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function clearSignedOutFlag() {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* private mode */
  }
}

function useAuthGate(): [AuthState, (s: AuthState) => void] {
  const [state, setState] = useState<AuthState>(() => {
    const params = new URLSearchParams(location.search);
    // Step 1: OAuth callback rejected this account (not on the allowlist).
    if (params.get("_auth_denied")) {
      const username = params.get("u");
      const orgName = params.get("org");
      history.replaceState(null, "", location.pathname + location.hash);
      return { kind: "denied", username, orgName };
    }
    return { kind: "loading" };
  });

  // loading → /api/auth/me probe → ready/missing/denied/error. The Access
  // cookie (if any) rides automatically. A successful 200 also clears any
  // stale signed_out flag — implicit "we got back in" signal.
  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;
    fetchAuthMe()
      .then(async (me) => {
        if (cancelled) return;
        if (me && (me.role === "admin" || me.role === "editor" || me.role === "viewer")) {
          clearSignedOutFlag();
          setReadOnly(me.role === "viewer");
          setIsAdmin(me.role === "admin");
          setState({ kind: "ready", me, role: me.role });
          return;
        }
        if (me && !me.role) {
          // /api/auth/me carries no rejecting-org name; only the _auth_denied
          // OAuth redirect does (see useAuthGate initializer).
          setState({ kind: "denied", username: me.username, orgName: null });
          return;
        }
        // me === null → 401, no cookie. Decide whether to silent-mint (dev)
        // or land on the sign-in screen.
        if (isSignedOut() || !import.meta.env.DEV) {
          setState({ kind: "missing" });
          return;
        }
        try {
          const devMe = await devSignIn("dev");
          if (cancelled) return;
          if (devMe.role !== "admin" && devMe.role !== "editor" && devMe.role !== "viewer") {
            setState({ kind: "denied", username: devMe.username, orgName: null });
            return;
          }
          clearSignedOutFlag();
          setReadOnly(devMe.role === "viewer");
          setIsAdmin(devMe.role === "admin");
          setState({ kind: "ready", me: devMe, role: devMe.role });
        } catch (err: unknown) {
          if (cancelled) return;
          const status = (err as { status?: number })?.status;
          if (status === 404) {
            // DEV_AUTH_ENABLED=false (e.g. running prod build locally).
            setState({ kind: "missing" });
          } else {
            setState({ kind: "error", message: String(err) });
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        if (status === 403) {
          setState({ kind: "denied", username: null, orgName: null });
        } else {
          setState({ kind: "error", message: String(err) });
        }
      });
    return () => { cancelled = true; };
  }, [state.kind]);

  return [state, setState];
}

export function App() {
  const { t } = useTranslation();
  // Same signal StatusIndicator shows in the classic TopBar (see there for
  // the sibling render) — surfaced here too so a tab left open in the new-UI
  // flow screens still gets nudged to reload after a deploy.
  const { updateAvailable } = useAppVersion();
  const [loc, setLoc] = useState<Location>(() => parseHash());
  // ?_choose_ws=1: the OAuth callback matched this account to SEVERAL Door43
  // orgs with no usable history and landed the session in the first match —
  // offer a one-time picker. Persisted to sessionStorage (markChooseWsPending)
  // because the workspace-reconciliation effect below may reload the tab once
  // before the dialog is seen; the initializer runs before useAuthGate's so
  // the flag survives its own history.replaceState URL cleanup too.
  const [chooseWs, setChooseWs] = useState<boolean>(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("_choose_ws")) {
      history.replaceState(null, "", location.pathname + location.hash);
      markChooseWsPending();
      return true;
    }
    return isChooseWsPending();
  });
  const [auth, setAuth] = useAuthGate();
  const [sessionExpired, setSessionExpired] = useState(false);
  // useBook is hoisted here so its chapter cache survives Shell remounts
  // (which happen when the user navigates between chapters via the URL).
  // Don't initialize it until auth is ready — the BookSummary fetch is now
  // gated and would otherwise burn a 401 every reload.
  const bookHook = useBook(
    loc.view === "chapter" ? loc.book : DEFAULT_BOOK,
    auth.kind === "ready" && loc.view === "chapter",
  );

  useEffect(() => {
    const handler = () => setLoc(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  useEffect(() => onAuthError(() => setSessionExpired(true)), []);
  // Clear the banner once a subsequent auth attempt succeeds — a silent
  // refresh, or (in dev) the first-load silent mint that lands after the
  // initial /api/auth/me + /api/auth/refresh 401s already raised it. Both
  // fire onAuthRefreshed, so the banner no longer sticks until a manual
  // reload (issue #283).
  useEffect(() => onAuthRefreshed(() => setSessionExpired(false)), []);

  const navigate = (book: string, chapter: number, verse?: number) => {
    location.hash =
      verse !== undefined && verse > 1
        ? `#/${book}/${chapter}/${verse}`
        : `#/${book}/${chapter}`;
  };

  // Remember the last scripture location so leaving preferences/articles
  // returns here instead of the default landing book. Only tracks chapter
  // views; a fresh load straight into preferences keeps the default.
  const lastScriptureRef = useRef<{ book: string; chapter: number; verse: number }>({
    book: DEFAULT_BOOK,
    chapter: 1,
    verse: 1,
  });
  if (loc.view === "chapter") {
    lastScriptureRef.current = { book: loc.book, chapter: loc.chapter, verse: loc.verse };
  }
  const backToScripture = () => {
    const { book, chapter, verse } = lastScriptureRef.current;
    navigate(book, chapter, verse);
  };

  // Live in-session position for the Books screen's Continue card. `auth.me`
  // is fetched once at boot and never refreshed, so without this the card
  // would keep showing the *previous* session's position after the user
  // edits in this session and navigates back to #/books. Unlike
  // lastScriptureRef above (a ref, so it can't trigger a re-render), this is
  // state — BooksScreen needs to actually re-render when it changes.
  const [livePosition, setLivePosition] = useState<{ book: string; chapter: number; verse: number } | null>(null);
  useEffect(() => {
    // Track the same routes the server-side push does (classic chapter + the
    // redesign scripture routes), so the card updates in-session no matter which
    // UI the translator works in (#200). The prev-comparison keeps this a no-op
    // when the position is unchanged.
    const pos = positionFromLoc(loc);
    if (!pos) return;
    setLivePosition((prev) =>
      prev && prev.book === pos.book && prev.chapter === pos.chapter && prev.verse === pos.verse
        ? prev
        : pos,
    );
  }, [loc]);

  // Workspace reconciliation. The server's be_ws cookie is the source of
  // truth for which org's D1 database we're talking to; localStorage is just
  // the client's mirror, and the outbox's IndexedDB name is derived from it
  // (see sync/outbox.ts). If they disagree — e.g. localStorage predates this
  // feature, or was left over from a different session on this device — pull
  // the server's value into localStorage and reload ONCE so the outbox opens
  // under the correct name from a cold start. Absent `me.workspace` means an
  // older cached /api/auth/me response; do nothing.
  useEffect(() => {
    if (auth.kind !== "ready") return;
    const serverWs = auth.me?.workspace;
    if (serverWs === undefined) return;
    const serverIsFallback = auth.me?.workspaceIsFallback;
    if (serverWs === getWorkspaceSlug()) {
      // Slug already agrees — still sync the fallback flag (it's cheap and
      // keeps outbox.ts's outboxDbName() correct even if it was never set,
      // e.g. an install that predates the fallback flag).
      if (serverIsFallback !== undefined) setWorkspaceIsFallback(serverIsFallback);
      try { sessionStorage.removeItem(WS_RECONCILED_KEY); } catch { /* private mode */ }
      return;
    }
    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(WS_RECONCILED_KEY) === "1"; } catch { /* private mode */ }
    if (alreadyTried) return; // already reloaded once this session — don't loop
    setWorkspaceSlug(serverWs);
    if (serverIsFallback !== undefined) setWorkspaceIsFallback(serverIsFallback);
    try { sessionStorage.setItem(WS_RECONCILED_KEY, "1"); } catch { /* private mode */ }
    location.reload();
  }, [auth]);

  // Debounced push of the current location to the server so the next sign-in
  // on a different device / after a logout can land back here. Records from the
  // classic chapter view AND the redesign routes (#/scripture, #/alignment,
  // #/notes, #/questions — see positionFromLoc); the package hub and
  // non-scripture views map to null and leave the stored position untouched (#200).
  useEffect(() => {
    if (auth.kind !== "ready") return;
    const pos = positionFromLoc(loc);
    if (!pos) return;
    const { book, chapter, verse } = pos;
    const t = setTimeout(() => {
      void updateLastLocation(book, chapter, verse);
    }, 1500);
    return () => clearTimeout(t);
  }, [auth.kind, loc]);

  // Must run before any of the early returns below — otherwise the hook is
  // conditionally invoked across renders (loading → ready calls one extra
  // hook), which violates Rules of Hooks. The hook itself no-ops while
  // auth is not "ready".
  const { alerts, dismiss } = useAlerts(auth.kind === "ready");

  useEffect(() => {
    setPipelineUser(auth.kind === "ready" ? auth.me?.userId ?? null : null);
  }, [auth]);

  if (auth.kind === "loading") {
    return (
      // 100dvh with a 100vh fallback — see the height comment on the main Shell
      // Box further down; plain 100vh sits under mobile browsers' URL bar.
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" } }}
        spacing={2}
      >
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">{t("appShell.auth.signingIn")}</Typography>
      </Stack>
    );
  }
  if (auth.kind === "missing") {
    // After an explicit logout (signed_out flag set) we surface a "queued
    // edits are safe" reassurance line. First-time visitors with no token
    // see the bare "Sign in to continue" screen instead — they have no
    // queued edits to worry about.
    const wasSignedOut = isSignedOut();
    const devSignInClick = () => {
      clearSignedOutFlag();
      setAuth({ kind: "loading" });
    };
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" } }}
        spacing={2}
      >
        <Typography variant="h6">
          {wasSignedOut ? t("appShell.auth.signedOutTitle") : t("appShell.auth.signInToContinue")}
        </Typography>
        {wasSignedOut && (
          <Typography variant="body2" color="text.secondary">
            {t("appShell.auth.queuedEditsSafe")}
          </Typography>
        )}
        <Button variant="contained" href="/api/auth/dcs/start" size="large">
          {t("appShell.auth.signInWithDoor43")}
        </Button>
        {import.meta.env.DEV && (
          <Button variant="text" size="small" onClick={devSignInClick}>
            {t("appShell.auth.signInDev")}
          </Button>
        )}
      </Stack>
    );
  }
  if (auth.kind === "denied") {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" }, px: 4 }}
        spacing={2}
      >
        <Typography variant="h6">{t("appShell.auth.notAuthorizedTitle")}</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
          {auth.orgName
            ? auth.username
              ? t("appShell.auth.notAllowlistedNamedOrg", { username: auth.username, org: auth.orgName })
              : t("appShell.auth.notAllowlistedOrg", { org: auth.orgName })
            : auth.username
              ? t("appShell.auth.notAllowlistedNamed", { username: auth.username })
              : t("appShell.auth.notAllowlisted")}
          {" "}{t("appShell.auth.askAdmin")}
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            // Server-side: clear cookies via logout, then start the OAuth
            // dance. The user still has to sign out of DCS separately to
            // actually switch accounts (DCS session cookie is sticky).
            void authLogout().finally(() => {
              location.href = "/api/auth/dcs/start";
            });
          }}
          size="small"
        >
          {t("appShell.auth.signInDifferentAccount")}
        </Button>
      </Stack>
    );
  }
  if (auth.kind === "error") {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">{t("appShell.auth.authFailed", { message: auth.message })}</Alert>
      </Box>
    );
  }

  const handleSignOut = async () => {
    // Server-side cleanup clears all three session cookies, revokes the
    // session row, and best-effort revokes the DCS access token. Set the
    // local UX flag so the next boot doesn't silent-mint in dev.
    await authLogout();
    try {
      localStorage.setItem(SIGNED_OUT_KEY, "1");
    } catch {
      /* private mode */
    }
    // Strip the URL hash too: leaving #/JON/3 around would confuse the next
    // boot into thinking the user requested a specific verse. Mirror that
    // into React state (replaceState doesn't fire hashchange) so the next
    // sign-in lands on the default Books screen instead of a stale deep link.
    history.replaceState(null, "", location.pathname);
    setLoc({ view: "books", book: null });
    setAuth({ kind: "missing" });
  };

  const handleSessionExpired = () => {
    // Cookies are still set but the Access token expired and refresh failed
    // (e.g. session revoked). Send the user through OAuth in both dev and
    // prod — there's no silent recovery from this state.
    location.href = "/api/auth/dcs/start";
  };

  const isViewer = auth.kind === "ready" && auth.role === "viewer";

  return (
    <Box
      sx={{
        // 100dvh with a 100vh fallback — plain 100vh includes mobile browsers'
        // retractable URL bar, so the bottom of the app sits under it.
        height: "100vh",
        "@supports (height: 100dvh)": { height: "100dvh" },
        display: "flex",
        flexDirection: "column",
      }}
    >
      <LocalizationInspector />
      {alerts.length > 0 && (
        // Float the alert stack so it doesn't push Shell down — the outer
        // flex column's children can't actually shrink (Shell's internal
        // box rejects flex:1 minHeight:0 sizing), and any added in-flow
        // height makes <html> scroll the banner above the viewport.
        // Fixed positioning keeps the banner visible regardless of scroll
        // state and accepts the tradeoff of obscuring the top 44px of the
        // TopBar — appropriate UX for a "Benjamin fix this" alert.
        <Box
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: (theme) => theme.zIndex.appBar + 2,
          }}
        >
          {alerts.map((a) => (
            <Alert
              key={a.id}
              severity={a.severity}
              variant="filled"
              onClose={() => void dismiss(a.id)}
              sx={{ borderRadius: 0, py: 0.5 }}
            >
              {a.message}
              {/* Scheme check: linkUrl is server-authored, but React doesn't
                  block javascript: hrefs — only render a link for https. */}
              {a.linkUrl && /^https:\/\//.test(a.linkUrl) && (
                <>
                  {" — "}
                  <Link
                    href={a.linkUrl}
                    target="_blank"
                    rel="noopener"
                    color="inherit"
                    underline="always"
                  >
                    {t("appShell.alerts.viewRun")}
                  </Link>
                </>
              )}
            </Alert>
          ))}
        </Box>
      )}
      {isViewer && (
        <Alert severity="info" variant="filled" sx={{ borderRadius: 0, py: 0.5 }}>
          {/* Split around the org name so it can stay bold: the org is a brand
              name and is never translated, while the surrounding sentence is. */}
          {t("appShell.viewer.readOnlyBannerBefore")}
          <strong>{VIEWER_ORG}</strong>
          {t("appShell.viewer.readOnlyBannerAfter")}
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loc.view === "preferences" ? (
          <PreferencesWorkspace
            section={loc.section}
            role={auth.role}
            onBack={backToScripture}
            onNavigate={(s) => {
              location.hash = `#/preferences/${s}`;
            }}
          />
        ) : loc.view === "article" ? (
          // The article workspace keeps the app's top bar so navigating here
          // doesn't drop the user out of the shell chrome (status, More,
          // account, theme/font/language). Book navigation is switched off —
          // an article has no book/chapter. The bar is fed the last scripture
          // position so "back" targets and status scope stay coherent; the
          // chapter-scoped controls Shell owns (AI pipeline menu, layout
          // switcher, export, verse-list toggle, lint counts) are simply not
          // passed, so each hides itself.
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <TopBar
              showNavigation={false}
              book={lastScriptureRef.current.book}
              chapter={lastScriptureRef.current.chapter}
              verse={lastScriptureRef.current.verse}
              onNavigate={navigate}
              username={auth.kind === "ready" ? auth.me?.username ?? null : null}
              onLogout={handleSignOut}
            />
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <ArticleWorkspace
                resource={loc.resource}
                articleId={loc.articleId}
                onBack={backToScripture}
                onNavigate={(r, a) => {
                  // Empty articleId (e.g. switching resource with nothing selected)
                  // must not emit a trailing slash — `#/articles/ta/` fails the
                  // article regex and misparses as a chapter.
                  location.hash = a ? `#/articles/${r}/${encodeURIComponent(a)}` : `#/articles/${r}`;
                }}
              />
            </Box>
          </Stack>
        ) : loc.view === "templates" ? (
          <TemplateWorkspace
            templateId={loc.templateId}
            onBack={backToScripture}
            onNavigate={(id) => {
              location.hash = id ? `#/templates/${encodeURIComponent(id)}` : `#/templates`;
            }}
          />
        ) : loc.view === "ai" ||
          loc.view === "style" ||
          loc.view === "curate" ||
          loc.view === "books" ||
          loc.view === "observe" ||
          loc.view === "notes" ||
          loc.view === "questions" ||
          loc.view === "package" ||
          loc.view === "translateWords" ||
          loc.view === "translateScripture" ||
          loc.view === "translateAlign" ||
          loc.view === "admin" ? (
          // The new-UI flow screens replaced the classic Shell/TopBar, which
          // carried the org (workspace) switcher, the UI-language switcher, the
          // account menu (identity, dark mode, reading text size, sign out), and
          // the global sync/pipeline status (queue, conflicts, failed-op discard,
          // AI-pipeline progress). Re-mount all of it here, once, as a slim
          // global chrome strip above every flow screen — so changing org or
          // interface language, signing out, or seeing/discarding a stuck save no
          // longer means dropping back into classic mode (#212). The org switcher
          // sits inside AccountMenu (it is account-scoped, and keeping it out of
          // the strip leaves the Team screen's own expanded switcher as the only
          // org control visible there — #209). SyncStatusBar/PipelineStatusBar
          // render nothing when there is no queued/failed op or pipeline job (own
          // null-render guards), so the strip stays empty-quiet on the common
          // case. justify-end keeps the controls on the inline-end corner in both
          // LTR and RTL.
          //
          // The "N unsaved drafts" reminder (UnsavedToasts) is intentionally NOT
          // mounted here — it requires a `book` in scope (Shell resolves it via
          // its own useChapter instance), but most flow views (books, style,
          // curate, ai, observe, package, admin) have no
          // book/chapter in `loc` at all. Hoisting it needs either new data
          // plumbing or a redesign of its in-place Save action — scoped as a
          // separate follow-up rather than risking a silent no-op or a
          // half-working Save button on those screens.
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="flex-end"
              spacing={0.5}
              role="toolbar"
              aria-label={t("topbar.chromeStrip.ariaLabel")}
              sx={{
                flex: "none",
                minHeight: 44,
                paddingInline: 1.5,
                paddingBlock: 0.5,
                borderBlockEnd: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
              }}
            >
              {updateAvailable && (
                <Tooltip title={t("sync.updateAvailableTooltip")}>
                  <Chip
                    size="small"
                    icon={<RefreshIcon sx={{ fontSize: 16 }} />}
                    label={t("sync.updateAvailable")}
                    onClick={() => window.location.reload()}
                    sx={{
                      color: "#E59D33",
                      borderColor: "#E59D33",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    variant="outlined"
                  />
                </Tooltip>
              )}
              <SyncStatusBar onNavigate={navigate} flowRouting />
              <PipelineStatusBar />
              <UiLanguageControl />
              <AccountMenu
                username={auth.kind === "ready" ? auth.me?.username ?? null : null}
                onLogout={handleSignOut}
              />
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0 }}>
          <Suspense
            fallback={
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
                <CircularProgress />
              </Stack>
            }
          >
            {loc.view === "ai" ? (
              <AiScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "style" ? (
              <StyleScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "curate" ? (
              <CurateScreen role={auth.role} me={auth.me} onNavigate={navigate} templateId={loc.templateId} />
            ) : loc.view === "books" ? (
              <BooksScreen
                role={auth.role}
                me={auth.me}
                onNavigate={navigate}
                book={loc.book}
                lastPosition={
                  livePosition ??
                  (auth.me?.lastBook && auth.me.lastChapter != null && auth.me.lastVerse != null
                    ? { book: auth.me.lastBook, chapter: auth.me.lastChapter, verse: auth.me.lastVerse }
                    : null)
                }
              />
            ) : loc.view === "observe" ? (
              <ObserveScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "notes" ? (
              <TranslateNotesScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse ?? undefined} rowId={loc.rowId ?? undefined} />
            ) : loc.view === "questions" ? (
              <TranslateQuestionsScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse ?? undefined} rowId={loc.rowId ?? undefined} />
            ) : loc.view === "package" ? (
              <PackageHubScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} />
            ) : loc.view === "translateWords" ? (
              <TranslateWordsScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} />
            ) : loc.view === "translateScripture" ? (
              <TranslateScriptureScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} />
            ) : loc.view === "translateAlign" ? (
              <TranslateAlignScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} mode={loc.mode} />
            ) : loc.section === "team" ? (
              // Terminal arm: the guard above admits only the views handled
              // here, so `admin` is what is left — TS narrows `loc` to it.
              <AdminTeamScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.section === "setup" ? (
              <AdminSetupScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.section === "workflow" ? (
              <AdminWorkflowScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : (
              <AdminProgressScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            )}
          </Suspense>
            </Box>
          </Stack>
        ) : (
          <Shell
            key={loc.book}
            book={loc.book}
            chapter={loc.chapter}
            initialVerse={loc.verse}
            onNavigate={navigate}
            bookHook={bookHook}
            onLogout={handleSignOut}
            meUserId={auth.kind === "ready" ? auth.me?.userId ?? null : null}
            meUsername={auth.kind === "ready" ? auth.me?.username ?? null : null}
          />
        )}
      </Box>
      <Snackbar
        open={sessionExpired}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          severity="warning"
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={handleSessionExpired}>
              {t("appShell.session.signIn")}
            </Button>
          }
        >
          {t("appShell.session.expired")}
        </Alert>
      </Snackbar>
      {chooseWs && <WorkspaceChoiceDialog onClose={() => setChooseWs(false)} />}
    </Box>
  );
}
