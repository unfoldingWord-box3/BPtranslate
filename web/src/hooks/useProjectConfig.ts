import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type ProjectConfig, type ProjectConfigResponse } from "../sync/api";
import { getBuiltinLayouts } from "../lib/builtinLayouts";
import { validateLayoutSpec, type LayoutSpec } from "../lib/layoutSpec";
import { validateLayoutAgainstRegistry } from "../lib/panelRegistry";

// The active per-project source config (org/language/direction/labels +
// translationSource). Mirrors useNoteTemplates: one shared fetch, a
// localStorage cache so an F5 while offline still has the config, and
// stale-while-revalidate on mount. Config changes are rare admin actions, so a
// cached value is almost always current; the background refresh converges after
// a PUT. Returns null until the first fetch resolves (no cached value yet).
const STORAGE_KEY = "bible-editor.project-config.v1";

function readPersisted(): ProjectConfig | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ProjectConfig;
  } catch {
    return null;
  }
}

function writePersisted(cfg: ProjectConfig) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota or private mode — soft fail */
  }
}

const persisted = readPersisted();
let cache: ProjectConfigResponse | null = persisted ? { config: persisted } : null;
let inflight: Promise<ProjectConfigResponse> | null = null;
const subscribers = new Set<(c: ProjectConfigResponse) => void>();

// Whether the last config fetch failed (offline, server down). useProjectConfig
// keeps returning the cached value on failure, which is null when nothing was
// ever cached; this lets a screen that cannot render without the config say so
// instead of waiting forever (issue #451).
let loadFailed = false;
const loadFailedSubscribers = new Set<() => void>();

function setLoadFailed(next: boolean) {
  if (loadFailed === next) return;
  loadFailed = next;
  for (const s of loadFailedSubscribers) s();
}

function publish(next: ProjectConfigResponse): ProjectConfigResponse {
  cache = next;
  writePersisted(next.config);
  setLoadFailed(false);
  for (const s of subscribers) s(next);
  return next;
}

function load(): Promise<ProjectConfigResponse> {
  if (inflight) return inflight;
  // A new fetch supersedes an earlier failure: while it is in flight the
  // config is loading, not failed.
  setLoadFailed(false);
  inflight = api
    .getProjectConfig()
    .then((res) => {
      inflight = null;
      return publish(res);
    })
    .catch((err) => {
      inflight = null;
      setLoadFailed(true);
      throw err;
    });
  return inflight;
}

function subscribeLoadFailed(cb: () => void): () => void {
  loadFailedSubscribers.add(cb);
  return () => {
    loadFailedSubscribers.delete(cb);
  };
}

// True once a config fetch has failed and no later fetch has succeeded.
export function useProjectConfigLoadFailed(): boolean {
  return useSyncExternalStore(subscribeLoadFailed, () => loadFailed);
}

// Try the config fetch again after a failure. load() clears the failed flag,
// so the caller shows its loading state while the retry is in flight.
export function retryProjectConfig(): void {
  load().catch(() => {
    /* load() has set the failed flag again */
  });
}

export function useProjectConfig(): ProjectConfig | null {
  const [val, setVal] = useState<ProjectConfig | null>(() => cache?.config ?? null);
  useEffect(() => {
    let mounted = true;
    load()
      .then((res) => {
        if (mounted) setVal(res.config);
      })
      .catch(() => {
        /* keep cached value */
      });
    const subscriber = (res: ProjectConfigResponse) => setVal(res.config);
    subscribers.add(subscriber);
    return () => {
      mounted = false;
      subscribers.delete(subscriber);
    };
  }, []);
  return val;
}

// Resolve the workspace layout list for a config-response: prefer the
// server-shipped `layouts` (each validated structurally, then against the panel
// registry, dropping any invalid/drifted spec) when present and non-empty;
// otherwise fall back to the client's bundled built-ins. This gives offline
// resilience (the localStorage cache stores only `config`, so its responses
// have no `layouts` and fall through) and drift safety (a bad server spec is
// dropped, never fatal — worst case the whole set falls back to bundled).
function resolveWorkflowLayouts(res: ProjectConfigResponse): LayoutSpec[] {
  const cfg = res.config;
  if (Array.isArray(res.layouts) && res.layouts.length > 0) {
    const valid: LayoutSpec[] = [];
    for (const raw of res.layouts) {
      const structural = validateLayoutSpec(raw);
      if (!structural) continue;
      const available = validateLayoutAgainstRegistry(structural, cfg);
      if (available) valid.push(available);
    }
    if (valid.length > 0) return valid;
  }
  return getBuiltinLayouts(cfg);
}

// The workspace layouts the switcher offers: server-shipped defaults when
// available, otherwise the bundled built-ins. Same subscribe-to-shared-cache
// pattern as useProjectPresets.
export function useWorkflowLayouts(): LayoutSpec[] {
  const [val, setVal] = useState<LayoutSpec[]>(() =>
    cache ? resolveWorkflowLayouts(cache) : getBuiltinLayouts(null),
  );
  useEffect(() => {
    let mounted = true;
    load()
      .then((res) => {
        if (mounted) setVal(resolveWorkflowLayouts(res));
      })
      .catch(() => {
        /* keep cached value */
      });
    const subscriber = (res: ProjectConfigResponse) => setVal(resolveWorkflowLayouts(res));
    subscribers.add(subscriber);
    return () => {
      mounted = false;
      subscribers.delete(subscriber);
    };
  }, []);
  return val;
}

// Persist the editor/translator mode override (admin only) and publish the
// updated config through the shared cache so every mode-dependent component
// (TopBar articles, Preferences memory, translation UI) re-renders at once.
export async function setProjectMode(
  mode: "authoring" | "translation",
): Promise<ProjectConfig> {
  const res = await api.patchProjectMode(mode);
  publish({ config: res.config });
  return res.config;
}

// PR B: apply a custom-gl draft (or any explicit override set) — always sends
// `overrides` explicitly (unlike a preset switch with overrides omitted, which
// preserves whatever is already stored).
export async function applyProjectOverrides(
  preset: string,
  overrides: Record<string, unknown> | null,
): Promise<ProjectConfig> {
  const res = await api.putProjectConfigWithOverrides(preset, overrides);
  publish({ config: res.config });
  return res.config;
}

// Publish an externally-obtained config update (e.g. from a lane PATCH
// response) through the shared cache so every subscriber re-renders.
export function updateProjectConfig(cfg: ProjectConfig): void {
  publish({ config: cfg });
}

// Force a fresh fetch from the server and publish. Useful after lane mutations
// where the server returns partial state and we want the full picture.
export async function refreshProjectConfig(): Promise<ProjectConfig> {
  inflight = null; // clear any stale in-flight
  const res = await api.getProjectConfig();
  publish(res);
  return res.config;
}

// True when translation-mode UI should be shown. Now driven by the explicit,
// admin-toggleable `mode` (materialized server-side), decoupled from the
// data source: an admin can run an org that HAS a translationSource in
// authoring mode, or vice versa.
/**
 * isTranslationProject once the config is known; null while it is still
 * loading (or failed with nothing cached), for callers that must not guess
 * "source project" from a missing config (lib/pipelineTrigger.ts, #731).
 */
export function projectType(cfg: ProjectConfig | null): boolean | null {
  return cfg ? isTranslationProject(cfg) : null;
}

export function isTranslationProject(cfg: ProjectConfig | null): boolean {
  if (!cfg) return false;
  // `mode` is the source of truth. Fall back to the legacy translationSource
  // derivation ONLY for a pre-mode cached config whose `mode` field is missing,
  // so first paint before the fetch converges still matches the old behavior
  // (English root → non-translation) rather than flickering.
  if (cfg.mode === "authoring" || cfg.mode === "translation") {
    return cfg.mode === "translation";
  }
  return cfg.translationSource != null;
}
