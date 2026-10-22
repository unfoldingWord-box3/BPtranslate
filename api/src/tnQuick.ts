// Thin proxy for the unfoldingWord bot-platform `/api/tn-quick` endpoint
// (https://uw-bt-bot.fly.dev). The bot drafts translation notes from a
// verse + issue type + Hebrew quote. We forward the user's body to the
// bot using the shared service token (BT_API_TOKEN secret) so the
// token never reaches the browser.
//
// This route is NOT a verbatim forward: auth gate, env check, swap the
// Authorization header, parse the body, inject contextRef/targetLang/
// direction (derived server-side — see assistedContextRef.ts's
// applyTnQuickContext, which also strips any client-supplied values for
// those same keys), re-serialize, forward, return the bot's response
// verbatim. The bot's schema is zod .strict(), so no unknown key may be
// added — only the keys the bot itself declares. Request validation, Hebrew
// normalization, and note drafting still live entirely in the bot.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireEditor } from "./auth.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { getLatestSuccessfulContextExport } from "./contextExportResults.ts";
import { applyTnQuickContext, stripClientContextFields } from "./assistedContextRef.ts";

export const tnQuick = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const DEFAULT_URL = "https://uw-bt-bot.fly.dev/api/tn-quick";
const MAX_BODY_BYTES = 32 * 1024;

// #551: every AI call for an org must run on that org's own key. The bot's
// tn-quick schema can't take one, so this route is switched off until it can
// (#446 tracks an in-Worker port). The proxy code below is kept for then; flip
// this to false once the call carries the org key.
const TN_QUICK_NEEDS_ORG_KEY: boolean = true;

tnQuick.post("/", requireEditor, async (c) => {
  if (TN_QUICK_NEEDS_ORG_KEY) {
    return c.json({ error: "ai_needs_org_key" }, 409);
  }
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "tn_quick_disabled" }, 503);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return c.json({ error: "body_too_large", maxBytes: MAX_BODY_BYTES }, 413);
  }

  // Fold the org's curated preferences (brief, terminology, instructions) into
  // the drafting request via the pinned contextRef, plus targetLang/direction
  // for the pack's language header — mirrors the translate pipeline
  // (pipelines.ts's "translate" branch). No successful export → forward the
  // body unchanged, exactly as before; the bot then drafts unsteered.
  let body = rawBody;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = undefined;
    // Malformed JSON — forward unchanged and let the bot's own validation reject it.
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    // Strip the caller's context fields FIRST, and forward the stripped body
    // even if the lookups below fail. These three are always server-derived:
    // the proxy calls the bot with our shared BT_API_TOKEN, so honoring a
    // caller-supplied contextRef would be a cross-tenant read of another
    // workspace's pack and a prompt-steering vector. Degrading must not
    // reopen that hole by falling back to the raw body.
    body = JSON.stringify(stripClientContextFields(parsed as Record<string, unknown>));
    try {
      const cfg = await getProjectConfig(c.env);
      const latest = await getLatestSuccessfulContextExport(c.env);
      if (!latest) {
        console.warn("tn-quick: no successful context export yet; drafting unsteered (contextRef omitted)");
      }
      body = JSON.stringify(applyTnQuickContext(parsed as Record<string, unknown>, latest, cfg));
    } catch (err) {
      // Config/export lookup threw (e.g. an unmigrated workspace DB missing
      // context_export_results / templates_count) — draft unsteered from the
      // STRIPPED body rather than silently disabling steering with no signal.
      console.warn("tn-quick: context injection failed, forwarding unsteered:", err);
    }
  }
  // else: parsed is null/array/primitive/undefined — forward the raw body
  // unchanged rather than spreading a non-object into a request shape.

  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes > MAX_BODY_BYTES) {
    return c.json({ error: "body_too_large", maxBytes: MAX_BODY_BYTES }, 413);
  }

  const url = c.env.TN_QUICK_URL || DEFAULT_URL;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.BT_API_TOKEN}`,
      },
      body,
    });
  } catch {
    return c.json({ error: "model_call_failed" }, 502);
  }

  const text = await upstream.text();
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  };
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(text, { status: upstream.status, headers });
});
