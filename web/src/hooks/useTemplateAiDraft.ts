// Async lifecycle for POST /api/templates/unit/draft — the note-template
// analogue of useAiDrafts.ts (which owns /api/tn-quick). Simpler than the TN
// version on purpose: a template is edited in a single-pane workspace (one
// TemplateEditor mounted at a time, keyed by templateId — see
// TemplateWorkspace.tsx), so there's no off-screen-card / notification-stack
// concern to solve. The request still aborts on unmount (component remounts
// wholesale on templateId change), matching useAiDrafts's cross-navigation
// safety without needing to lift ownership to a shell-level owner.

import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../i18n";
import { ApiError, api, type TemplateUnit } from "../sync/api";
import { AI_NEEDS_ORG_KEY } from "../lib/aiProviderErrors";

/** Stable, NEVER-translated classification of a draft failure. This is the
 *  logic value: CurateEditor keys its "AI is disabled for this screen" latch
 *  off `"disabled"` here. It used to sniff the English prose out of `error`
 *  (`error.startsWith("AI not configured")`), which silently stopped matching
 *  the moment that prose was localized — hence the split into a stable id
 *  (`errorCode`) plus a display-only label (`error`). */
export type TemplateDraftErrorCode =
  | "disabled"
  | "needs_org_key"
  | "service_unavailable"
  | "too_large"
  | "version_mismatch"
  | "unauthorized"
  | "http"
  | "network";

/** Classify only — no user-visible text. */
function classifyTemplateDraftError(err: unknown): TemplateDraftErrorCode | null {
  if (err instanceof ApiError) {
    const code =
      err.body && typeof err.body === "object" && "error" in err.body
        ? String((err.body as { error?: unknown }).error)
        : "";
    switch (code) {
      case "template_draft_disabled":
        return "disabled";
      case AI_NEEDS_ORG_KEY:
        return "needs_org_key";
      case "model_call_failed":
        return "service_unavailable";
      case "body_too_large":
        return "too_large";
      case "version_mismatch":
        return "version_mismatch";
      case "unauthorized":
        return "unauthorized";
      default:
        return "http";
    }
  }
  if (err instanceof DOMException && err.name === "AbortError") return null;
  return "network";
}

// DISPLAY ONLY — rendered as the workspace's error banner. Translated on every
// call (never at module load) so the active UI language wins. HTTP statuses and
// BT_API_TOKEN are interpolated/literal, never translated.
function describeTemplateDraftError(code: TemplateDraftErrorCode, err: unknown): string {
  switch (code) {
    case "disabled":
      return i18n.t("messages.aiDraft.notConfiguredToken");
    case "needs_org_key":
      return i18n.t("ai.needsOrgKey");
    case "service_unavailable":
      return i18n.t("messages.aiDraft.serviceUnavailable");
    case "too_large":
      return i18n.t("messages.templateDraft.tooLarge");
    case "version_mismatch":
      return i18n.t("messages.templateDraft.versionMismatch");
    case "unauthorized":
      return i18n.t("messages.aiDraft.sessionExpired");
    case "http":
      return i18n.t("messages.aiDraft.requestFailed", {
        status: err instanceof ApiError ? err.status : 0,
      });
    case "network":
      // A thrown Error's own message (e.g. api.ts's "request timeout") is a
      // diagnostic, kept verbatim; the bare fallback is localized.
      if (err instanceof Error && err.message) return err.message;
      return i18n.t("messages.aiDraft.networkError");
  }
}

export interface UseTemplateAiDraftAPI {
  drafting: boolean;
  /** Localized, DISPLAY-ONLY message. Never branch on this — use `errorCode`. */
  error: string | null;
  /** Stable id for the same failure, safe to compare against. Set/cleared in
   *  lockstep with `error`. */
  errorCode: TemplateDraftErrorCode | null;
  clearError: () => void;
  /** Set when a draft request 409s — the fresh server row from the error
   *  body, same as handleSave's conflict rebase. The caller should apply it
   *  (e.g. via applyServerUnit) so the next retry uses the current version
   *  instead of re-sending the stale one and 409ing forever. */
  conflictUnit: TemplateUnit | null;
  clearConflict: () => void;
  draft: (unit: TemplateUnit) => Promise<TemplateUnit | null>;
}

export function useTemplateAiDraft(): UseTemplateAiDraftAPI {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<TemplateDraftErrorCode | null>(null);
  const [conflictUnit, setConflictUnit] = useState<TemplateUnit | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const clearError = useCallback(() => {
    setError(null);
    setErrorCode(null);
  }, []);
  const clearConflict = useCallback(() => setConflictUnit(null), []);

  const draft = useCallback(async (unit: TemplateUnit) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setDrafting(true);
    setError(null);
    setErrorCode(null);
    try {
      const updated = await api.draftTemplate(unit.template_id, unit.version, controller.signal);
      return updated;
    } catch (err) {
      if (controller.signal.aborted) return null;
      if (err instanceof ApiError && err.status === 409) {
        const fresh = (err.body as { current?: TemplateUnit } | undefined)?.current;
        if (fresh) setConflictUnit(fresh);
      }
      const code = classifyTemplateDraftError(err);
      if (code) {
        const message = describeTemplateDraftError(code, err);
        if (message) {
          setError(message);
          setErrorCode(code);
        }
      }
      return null;
    } finally {
      if (controllerRef.current === controller) setDrafting(false);
    }
  }, []);

  // Abort an in-flight draft request when the owning component unmounts
  // (templateId change remounts TemplateEditor wholesale — see the `key`
  // prop in TemplateWorkspace.tsx).
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { drafting, error, errorCode, clearError, conflictUnit, clearConflict, draft };
}
