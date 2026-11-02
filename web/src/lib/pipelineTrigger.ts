// How the pipeline trigger presents itself (#731). Pure, so the rule is
// unit-tested without a browser (pipelineTrigger.test.mjs).
//
// Only translation projects have AI actions (PipelineMenu's "Translate
// chapter" items). Since #470 removed the bot's older actions, a source
// project's (the English root's) pipeline menu holds nothing but "Import from
// Door43", so every trigger for it — the classic top-bar button, the AI studio
// button, a flow screen's header icon and the phone account-menu item — is an
// import action, not an AI one. The caller passes isTranslationProject(cfg),
// the same predicate PipelineMenu uses for its AI items, so the label can never
// disagree with what the menu holds.

export type PipelineTriggerKind = "ai" | "import";

export interface PipelineTrigger {
  kind: PipelineTriggerKind;
  /** Short label for a text button. */
  buttonKey: string;
  /** Longer label for an icon button's tooltip or a menu item. */
  actionKey: string;
}

export function pipelineTrigger(translationProject: boolean): PipelineTrigger {
  return translationProject
    ? { kind: "ai", buttonKey: "pipeline.aiButton", actionKey: "pipeline.startAiRun" }
    : { kind: "import", buttonKey: "pipeline.importButton", actionKey: "pipeline.importFromDoor43" };
}

/** AI studio's page subtitle: a source project has no AI translation runs. */
export function aiStudioSubtitleKey(translationProject: boolean): string {
  return translationProject ? "aiStudio.subtitle" : "aiStudio.subtitleSourceProject";
}
