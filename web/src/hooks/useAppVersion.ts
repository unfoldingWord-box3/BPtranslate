import { useEffect, useState } from "react";

// The version baked into the bundle running right now (see vite.config.ts).
export const APP_VERSION = __APP_VERSION__;

export interface VersionInfo {
  commit: string;
  builtAt: string;
}

// How often a foregrounded tab re-checks /version.json. Long enough that it's
// negligible traffic; short enough that someone who leaves a tab open for a
// workday gets nudged within a few minutes of a deploy.
const POLL_MS = 5 * 60 * 1000;

function isVersionInfo(x: unknown): x is VersionInfo {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as VersionInfo).commit === "string" &&
    typeof (x as VersionInfo).builtAt === "string"
  );
}

// Fetch the version.json that ships with the *deployed* bundle. Cache-busted +
// no-store so we read what prod actually has, not a CDN/browser copy. Returns
// null on any failure (offline, 404 in dev) — callers treat null as "no info,
// assume current".
async function fetchDeployedVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isVersionInfo(data) ? data : null;
  } catch {
    return null;
  }
}

interface UseAppVersionReturn {
  /** Version of the bundle this tab is running. */
  current: VersionInfo;
  /** True once the deployed build's commit differs from ours — refresh needed. */
  updateAvailable: boolean;
}

// Polls /version.json and flips `updateAvailable` when prod has moved past the
// build this tab booted with. Checks on mount, on an interval, on tab refocus,
// and on reconnect — whichever notices first wins, then we stop polling (the
// only cure is a reload, so there's nothing more to learn).
export function useAppVersion(): UseAppVersionReturn {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // No version.json is emitted by `vite` dev, and a stale-prompt during
    // hot-reload development is just noise — skip the whole mechanism. One
    // dev-only seam: `be:devUpdateAvailable=1` in localStorage raises the
    // prompt, so the phone-header spec (#522) can lay out the update control.
    // Dead code in a production build.
    if (import.meta.env.DEV) {
      try {
        if (localStorage.getItem("be:devUpdateAvailable") === "1") setUpdateAvailable(true);
      } catch {
        /* storage blocked: no prompt */
      }
      return;
    }
    // An "unknown" build can't be meaningfully compared; don't cry wolf.
    if (APP_VERSION.commit === "unknown") return;

    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      const deployed = await fetchDeployedVersion();
      if (cancelled || !deployed) return;
      if (deployed.commit !== APP_VERSION.commit) setUpdateAvailable(true);
    };

    void check();
    const interval = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);

  return { current: APP_VERSION, updateAvailable };
}
