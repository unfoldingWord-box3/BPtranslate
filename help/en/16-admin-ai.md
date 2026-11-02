---
id: admin-ai
title: AI studio and AI service (admin)
routes: [ai]
roles: [admin]
keywords: [ai, artificial intelligence, pipeline, draft, translate chapter, translate questions, translate notes, provider, api key, gemini, claude, openai, xai, grok, model, bring your own key, byo, run, queue, retry]
screenshots:
  - admin-ai-1 #/admin/ai
---

**AI studio** is where you have AI translate a chapter's translation notes or translation questions, and where you save the AI provider key of your organization. A run locks its chapter for editing until it finishes.

![The AI studio with the run controls and the runs table](../screenshots/en/admin-ai-1.png)

## Start an AI run
1. Open **AI studio** in the admin menu.
2. Choose the **Book** and type the **Chapter**.
3. Press **AI** and choose **Translate chapter** (the chapter's translation notes) or **Translate questions** (its translation questions). These two appear only in a translation project, one that translates from a source language.
4. In the confirm window, choose a chapter or a range and press **Start**.

Only one job runs at a time. The other jobs wait in line. When AI drafts are ready, a banner on the page tells you to review them.

The same **AI** menu also has **Import from Door43**. Admins on a translation project also see **Pull Aquifer drafts** and **Re-source notes from English**. Re-sourcing replaces the book from Door43 and discards local edits, so the app asks you to confirm.

## Follow the runs
The table **Runs — this workspace** shows **Type**, **Scope**, **State**, **Progress**, **Started** and **Requested by**. Runs started by other people are read-only. For your own runs you can press **Cancel** while a run is still queued, and **Retry** after a failure. A failed **Translate** run cannot be retried here. Press **Dismiss** to hide a failed, cancelled or finished run, or **Dismiss all** to hide them all. **Refresh** updates the list.

If the page says **AI not configured**, the AI connection is not set up for this workspace. A technical administrator must set the BT_API_TOKEN setting on the server. Until then retrying is not available.

## Save your own AI key
The section **AI service** sets which AI provider runs your pipeline jobs.
1. Choose the **Provider**: Google Gemini, xAI Grok, Claude (API) or OpenAI.
2. Choose the **Model**.
3. Type your **API key**.
4. Press **Save**.

Once saved, the key is stored encrypted and is never shown again. You see **Configured** with the last characters of the key. Press **Replace** to enter a new key, or **Clear** to remove it. If a red or yellow notice says bringing your own key is not enabled on this deployment, a technical administrator must enable it first.
