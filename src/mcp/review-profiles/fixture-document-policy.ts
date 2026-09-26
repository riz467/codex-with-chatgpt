// Deliberately fixture-specific. Never import this from the structural review controller.
export function fixtureDocumentPolicy(edits: unknown[], diff: string): boolean {
  if (edits.length !== 1) return false;
  const edit = edits[0] as Record<string, unknown>;
  return edit.path === "docs/document-map.md" && typeof edit.new_text === "string" &&
    edit.new_text.includes("分類") && edit.new_text.includes("必要") && edit.new_text.includes("参照") &&
    /(だけ|のみ)/.test(edit.new_text) && !/毎回|必ず/.test(edit.new_text) &&
    diff.includes("-通常の入口は[AGENTS](../AGENTS.md)") && diff.includes("+通常の入口は[AGENTS](../AGENTS.md)");
}
