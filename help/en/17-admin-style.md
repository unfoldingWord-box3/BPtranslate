---
id: admin-style
title: Teaching the AI your style (admin)
routes: [style]
roles: [admin]
keywords: [style, brief, audience, register, instructions, common issues, terminology, glossary, term, examples, few-shot, context pack, qa rules, ai, prompt, export]
screenshots:
  - admin-style-1 #/admin/style
---

**Style** holds what the AI is told before it drafts anything for your project: who the readers are, how to write, which terms to use. Together this is the context pack. Every AI draft is written against it. Only an admin can save changes.

![The Style page with the section list and the context pack bar](../screenshots/en/admin-style-1.png)

The bar at the top shows the state of the context pack, for example **Context pack ready**, with counts of terms and examples. **Export now** builds a new pack. The switch **Project mode** shows whether the project is in translation or authoring mode. The sections below apply to translation projects only. In other projects the page says so.

## Fill in the sections
Use the list on the left to jump to a section. After you change a section, press **Save**.

- **Brief:** fill in **Audience**, **Purpose**, **Register** and **Script / direction notes**. Register is how formal the drafts should be: **Default (auto)**, **Formal** or **Informal**.
- **Instructions:** free text (Markdown) added to every AI drafting and checking request. Use **Preview** to see how it looks.
- **Common issues:** free text about problems that reviewers flag again and again.
- **Terminology:** your decisions about terms. You can give a preferred rendering, mark a term as forbidden with what to use instead, or mark it do-not-translate. This section can also import and export a CSV file.
- **Examples:** notes and questions that were approved in the editor. The AI sees them as models of good work. Switch between **Notes** and **Questions**. Press **Revoke** to remove an example. Revoking returns the item to the edited state.
- **QA rules** and **Templates:** QA rules are listed with **Coming soon**. **Templates** shows how many note templates are translated. Press **Open template curation →** to work on them (see [Note templates](#help:admin-templates)).

## Update the context pack
The AI reads the last exported pack, not your live text. After you change terms or instructions:
1. Press **Save** in each section you changed.
2. Press **Export now** in the bar at the top.
3. Wait until the bar says **Context pack ready**.

If the export is refused because it would remove content, an **Export (force)** button appears. Use it only when you are sure.

If you see **Save failed**, check your connection and try again. If you see **Someone else saved first**, your text is kept. Press **Save** again.
