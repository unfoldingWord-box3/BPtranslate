---
id: admin-progress
title: Progress, review state and draft scorecard (admin)
routes: [admin/progress, admin/review, admin/scorecard]
roles: [admin]
keywords: [progress, review state, approve, approved, validated, bulk, sweep, reopen, needs review, chapter, book, notes, questions, dashboard, percent, scorecard, draft quality, AI draft, unchanged, similarity, context pack, closing period]
screenshots:
  - admin-progress-1 #/admin/progress
  - admin-progress-2 #/admin/review
---

Three admin pages show and set how far the review has come. **Progress** shows the numbers. **Review state** changes the review state of many notes or questions at once. **Draft scorecard** shows how good the AI drafts of approved notes were. Only an admin can open them.

![The Progress page with totals and the book package board](../screenshots/en/admin-progress-1.png)

## Read the Progress page
1. Open **Progress** in the admin menu.
2. The tiles at the top count the imported **Books**, **Verses**, **Notes**, **Word links** and **Questions**. **Approved** shows the share of notes, questions and verses that are approved, all together.
3. In **Book package board**, each row is one imported book. Click a row to see the same numbers for each chapter.
4. **Activity** lists the latest export runs and AI jobs.

The page loads each book one by one, so the tiles may say they are still loading.

## Set the review state of many rows
Use this when you already know the status of imported work. For example, a book was checked before it came into the app, so its notes should count as approved. For normal reviewing, see [Review queue](#help:review-queue).

![The Review state page with the Set review state form](../screenshots/en/admin-progress-2.png)

1. Open **Review state** in the admin menu.
2. Under **Set review state**, choose the **Book** and the **Resource**: **Translation notes** or **Translation questions**.
3. Choose the **New state**: **Approved** or **Needs review**. **Needs review** puts the rows back in the review queue.
4. Choose **From chapter** and **To chapter**. Tick **Whole book** to use every chapter.
5. Press **Review change**. Nothing is saved yet. The app counts the rows it would change.
6. In **Confirm review state change**, check the book, chapters, resource, new state and **Rows to update**.
7. Press **Apply**, or **Cancel** to stop.

The message after saving tells you how many rows changed. The table **Current state by chapter** shows how many notes and questions are approved in each chapter.

Good to know:
- Every row in the range changes, including rows a translator is still working on.
- The text of the notes does not change. The change is recorded in the history as an admin action.
- These rows are not used as AI examples.
- If the app says the change could not be confirmed, it may be partly or fully applied. Check the counts in the table before you try again.

## Check the quality of AI drafts
**Draft scorecard** compares each approved translation note with the last AI draft of it, chapter by chapter. Use it to see whether a change to the AI's guidance makes drafts better. It changes nothing.

1. Open **Draft scorecard** in the admin menu.
2. Choose the **Book**. The table shows one row per chapter, and **Whole book** at the bottom.
3. Read the columns:
   - **Approved notes**: approved translation notes in the chapter.
   - **No draft logged**: notes with no AI draft on record. Edit history older than 180 days can be cleared.
   - **Draft was English**: the AI draft was the English note, not translated. These notes are left out of the columns to the right. A note that is the same as the English for a good reason, such as one that holds only links, is counted here too.
   - **Compared**: the notes the other columns are about.
   - **Approved unchanged**: the share approved exactly as the AI wrote them.
   - **Median similarity**: how much of a draft was kept, from 0 (all rewritten) to 1 (unchanged). When the changed part of a note is longer than 2,000 characters, only its first 2,000 characters are compared, so that note's similarity is approximate and the chapter's median is marked ≈. Point at the ≈ to see how many notes it covers.
   - **Period added after ]**: of the drafts that end with ] and no period, the share where the editor had to add the period.
   - **Context pack**: the version of the guidance the AI was given, with how many notes used it. Hover over it to see the full name. **Not pinned (latest pack at run time, if any)** means the run was not tied to one version: it used the latest guidance when it ran, or none if no guidance had been exported yet. **Run not on record** means the AI run has been cleared. Each draft is matched to its AI run by time, so in rare cases where runs overlapped a draft can be credited to the wrong run.

If the English notes cannot be read for some chapters, a message names those chapters and gives each reason. No draft in them is left out as English, and their counts are marked with *. On the **Whole book** row, * means only part of the book was checked.
