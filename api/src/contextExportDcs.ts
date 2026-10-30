// Serialized master commit for {owner}/translation-context.
// Expected-parent CAS + retry so manual and nightly exports can't publish a
// SHA that does not represent the rendered D1 snapshot they just produced.

import { commitFilesToDcs, type DcsCommitConfig } from "./export.ts";
import { stalePackPaths, type ContextFile } from "./contextExportLib.ts";

export type ContextDcsConfig = {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
};

export type CommitContextResult = {
  commitSha: string;
  parentSha: string;
  changed: boolean;
  committedCount: number;
};

async function getBranchTipSha(cfg: ContextDcsConfig, branch: string): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/` +
    `${encodeURIComponent(cfg.repo)}/branches/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`dcs_branch_tip_failed: GET ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { commit?: { id?: string } };
  return body.commit?.id ?? null;
}

async function getCommitParentSha(cfg: ContextDcsConfig, sha: string): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/` +
    `${encodeURIComponent(cfg.repo)}/git/commits/${encodeURIComponent(sha)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`dcs_commit_parent_failed: GET ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { parents?: Array<{ sha?: string }> };
  return body.parents?.[0]?.sha ?? null;
}

/**
 * Commit pack files to master with expected-parent compare-and-swap.
 * On parent mismatch (concurrent writer), throws `context_cas_conflict` so the
 * caller can re-render from D1 and retry (max attempts live in the workflow).
 */
export async function commitContextPackToMaster(
  cfg: ContextDcsConfig,
  files: ContextFile[],
  message: string,
  expectedParentSha: string | null,
): Promise<CommitContextResult> {
  const tip = await getBranchTipSha(cfg, "master");
  if (expectedParentSha != null && tip != null && tip !== expectedParentSha) {
    throw new Error(`context_cas_conflict:expected=${expectedParentSha}:actual=${tip}`);
  }

  const dcsCfg: DcsCommitConfig = {
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    owner: cfg.owner,
    repo: cfg.repo,
    branch: "master",
  };

  // Pack-managed files omitted from this render have an empty D1 source —
  // delete any stale copy in the same commit (never touches runs/, candidates/
  // or README.md; see PACK_MANAGED_PATHS).
  let result;
  try {
    result = await commitFilesToDcs(dcsCfg, files, message, {
      deletePaths: stalePackPaths(files),
    });
  } catch (e) {
    // Another export moved master after our tip check: Door43 refuses the ref
    // update with a 403 "cannot lock ref". Same race as the checks above, so
    // let the workflow re-render and retry (#712).
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("dcs_batch_commit_failed") && msg.includes("cannot lock ref")) {
      throw new Error(`context_cas_conflict:ref_lock:${msg}`);
    }
    throw e;
  }

  if (!result.changed) {
    // Byte-identical to tip — the trustworthy SHA is the current tip.
    const sha = tip ?? (await getBranchTipSha(cfg, "master"));
    if (!sha) throw new Error("context_master_tip_missing_after_noop");
    return {
      commitSha: sha,
      parentSha: tip ?? sha,
      changed: false,
      committedCount: 0,
    };
  }

  const commitSha = result.commitSha;
  if (!commitSha) throw new Error("context_commit_sha_missing");

  // Verify the new commit's parent is the tip we read (CAS).
  const parent = await getCommitParentSha(cfg, commitSha);
  const expected = tip;
  if (expected != null && parent != null && parent !== expected) {
    throw new Error(`context_cas_conflict:expected_parent=${expected}:got_parent=${parent}`);
  }

  // Tip after commit should be our SHA; otherwise someone raced past us.
  const tipAfter = await getBranchTipSha(cfg, "master");
  if (tipAfter && tipAfter !== commitSha) {
    throw new Error(`context_cas_conflict:tip_after=${tipAfter}:ours=${commitSha}`);
  }

  return {
    commitSha,
    parentSha: parent ?? expected ?? "",
    changed: true,
    committedCount: result.committedCount,
  };
}

export async function repoExists(cfg: ContextDcsConfig): Promise<boolean> {
  const url =
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/` +
    `${encodeURIComponent(cfg.repo)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`dcs_repo_check_failed: GET ${res.status} ${await res.text()}`);
  return true;
}

export { getBranchTipSha };
