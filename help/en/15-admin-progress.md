---
id: admin-progress
title: Progress and review state (admin)
routes: [admin/progress, admin/review]
roles: [admin]
keywords: [progress, review state, approve, approved, validated, bulk, sweep, reopen, needs review, chapter, book, notes, questions, dashboard, percent]
screenshots:
  - admin-progress-1 #/admin/progress
  - admin-progress-2 #/admin/review
---

Two admin pages show and set how far the review has come. **Progress** shows the numbers. **Review state** changes the review state of many notes or questions at once. Only an admin can open them.

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
