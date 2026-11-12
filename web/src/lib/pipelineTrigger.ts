// How the pipeline trigger presents itself (#731). Pure, so the rule is
// unit-tested without a browser (pipelineTrigger.test.mjs).
//
// Only translation projects have AI actions (PipelineMenu's "Translate
// chapter" items). Since #470 removed the bot's older actions, a source
// project's (the English root's) pipeline menu holds nothing but "Import from
// Door43", so every trigger for it — the classic top-bar button, the AI studio
// button, a flow screen's header icon and the phone account-menu item — is an
// import action, not an AI one. The caller passes projectType(cfg): the same
// isTranslationProject predicate PipelineMenu uses for its AI items, or null
// while the config is unknown (still loading, or failed with nothing cached).
// Unknown keeps the AI trigger, the behaviour before #731, so a translation
// project never shows "Import" or opens the import dialog during a load.

export type PipelineTriggerKind = "ai" | "import";

/** true = translation project, false = source project, null = config not known yet. */
export type ProjectType = boolean | null;

export interface PipelineTrigger {
  kind: PipelineTriggerKind;
  /** Short label for a text button. */
  buttonKey: string;
  /** Longer label for an icon button's tooltip or a menu item. */
  actionKey: string;
}

export function pipelineTrigger(type: ProjectType): PipelineTrigger {
  return type === false
    ? { kind: "import", buttonKey: "pipeline.importButton", actionKey: "pipeline.importFromDoor43" }
    : { kind: "ai", buttonKey: "pipeline.aiButton", actionKey: "pipeline.startAiRun" };
}

/** AI studio's page subtitle: a source project has no AI translation runs. */
export function aiStudioSubtitleKey(type: ProjectType): string {
  return type === false ? "aiStudio.subtitleSourceProject" : "aiStudio.subtitle";
}
