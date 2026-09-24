import fs from "node:fs";
import path from "node:path";
import { gitInfo } from "../workspace/git.js";
import type { Workspace } from "../workspace/manager.js";
import { REVIEW_ROOT } from "./local-gateway.js";

type GitIdentity = ReturnType<typeof gitInfo>;

/** The review root is fixed by the host, not a tool argument or caller-supplied path. */
export function isReviewWorkspace(workspace: Workspace): boolean {
  return process.platform === "win32" && workspace.root.toLowerCase() === path.resolve(REVIEW_ROOT).toLowerCase();
}

export function workspaceOverview(
  workspace: Workspace,
  readGit: (root: string) => GitIdentity = gitInfo,
  onGitError?: (error: unknown) => void
) {
  const review = isReviewWorkspace(workspace);
  const project = workspace.detectProject();
  let git: GitIdentity;
  try {
    git = readGit(workspace.root);
  } catch (error) {
    // Metadata is optional for an otherwise valid review directory. Do not mask
    // errors in project detection, path validation or other workspace operations.
    onGitError?.(error);
    git = { isRepo: false, branch: null, commit: null, dirty: false };
  }
  let currentReviewExists = false;
  if (review) {
    const pointer = path.join(workspace.root, "CURRENT_REVIEW.json");
    try {
      currentReviewExists = fs.lstatSync(pointer).isFile(); // symlinks are not regular files
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    rootAlias: "workspace:/",
    ...project,
    git: {
      isRepo: git.isRepo,
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
      ...(review ? { available: git.isRepo } : {}),
    },
    ...(review ? {
      workspaceRoot: workspace.root,
      readOnly: true,
      directoryExists: fs.statSync(workspace.root).isDirectory(),
      currentReviewExists,
    } : {}),
  };
}
