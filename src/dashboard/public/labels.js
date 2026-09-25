const unknown = '未確認';
const maps = {
  state: { DONE: '完了', NEEDS_APPROVAL: '確認待ち', READY_FOR_REVIEW: 'レビュー待ち', EXECUTING: '実行中', VERIFYING: '検証中', PLANNING: '計画中', RESEARCHING: '調査中', BLOCKED: '停止中', FAILED: '失敗' },
  mode: { read_only: '読み取り専用', change: '変更あり' },
  actor: { CHATGPT: 'ChatGPT', OPENCODE: 'OpenCode', CODEX: 'Codex', HUMAN: '人', REVIEW: 'レビュー', SYSTEM: 'システム', IDLE: '待機中' },
  stage: { Research: '調査', Scope: '対象確定', Plan: '計画', Execute: '実行', Verify: '検証', Review: 'レビュー', Done: '完了' },
  pipeline: { complete: '完了', active: '実行中', waiting: '待機中', not_started: '未開始', blocked: '停止', incomplete: '未完了' },
  event: { state_transition: '状態変更', research: '調査', scope: '対象確定', plan: '計画', execute: '実行', verify: '検証', review: 'レビュー', complete: '完了', transition: '状態変更' },
  health: { healthy: '正常', ready: '準備完了', unavailable: '利用不可', heartbeat_fresh: '受信済み' },
  review: { PASS: '合格', FAIL: '不合格' },
  completion: { post_integration: '統合後', direct: '直接' },
  stop: { HUMAN_APPROVAL_REQUIRED: '人による確認が必要', SCOPE_CONFIRMATION_REQUIRED: '対象範囲の確認が必要', EVIDENCE_INSUFFICIENT: '証拠不足', VERIFY_BLOCKED: '検証で停止', EXECUTION_BLOCKED: '実行で停止', READY_FOR_REVIEW: 'レビュー待ち' },
  action: {
    HUMAN_APPROVAL_REQUIRED: '記録された提案を人が確認してください。このタスクに承認・再開経路はありません。',
    SCOPE_CONFIRMATION_REQUIRED: '候補のパスを確認してください。元の変更対象が明示的に記録されている場合のみ、新しいタスクとして再試行できます。',
    EVIDENCE_INSUFFICIENT: '再試行の適格性を確認し、利用者の明示的な依頼がある場合に限り、同じ範囲で新しい調査タスクとして再試行してください。元のタスクは再開しません。',
    VERIFY_BLOCKED: '検証の証拠を確認してください。エンジンの RetryVerify 事前確認が通る場合のみ ai-resume を使用してください。',
    EXECUTION_BLOCKED: '実行環境と再試行の適格性を確認してください。元の限定された範囲を持つ新しいタスクとしてのみ再試行できます。',
    READY_FOR_REVIEW: '検証済みの変更を独立してレビューしてください。'
  }
};
const actionSources = {
  HUMAN_APPROVAL_REQUIRED: 'Human review of the recorded proposal is required; the engine has no approval/resume route for this task.',
  SCOPE_CONFIRMATION_REQUIRED: 'Inspect candidate paths; a new-task retry is allowed only if the original explicit edit_paths were recorded.',
  EVIDENCE_INSUFFICIENT: 'Check retry eligibility, then retry research as a new task with the same scope on explicit user request; never resume the original task.',
  VERIFY_BLOCKED: 'Inspect verification evidence; use ai-resume only if the engine RetryVerify preflight accepts this task.',
  EXECUTION_BLOCKED: 'Inspect the execution environment and retry eligibility; only a new task with the original bounded scope may be retried.',
  READY_FOR_REVIEW: 'Perform independent review of the verified changes.'
};

const label = (group, value) => value === null || value === undefined || value === '' || value === 'unknown' || value === 'UNKNOWN'
  ? unknown : (Object.hasOwn(maps[group], value) ? maps[group][value] : String(value));
export const stateLabel = value => label('state', value);
export const modeLabel = value => label('mode', value);
export const actorLabel = value => label('actor', value);
export const stageLabel = value => label('stage', value);
export const pipelineLabel = value => label('pipeline', value);
export const eventTypeLabel = value => label('event', value);
export const healthLabel = value => label('health', value);
export const reviewLabel = value => label('review', value);
export const completionLabel = value => label('completion', value);
export const stopLabel = value => label('stop', value);
export const actionLabel = (category, original) => category && original === actionSources[category] ? maps.action[category] : displayValue(original);
export const stopSummaryLabel = (category, original) => category && original === `${category} recorded; inspect authorized evidence for details.`
  ? `${stopLabel(category)}を記録しました。詳細は権限のある証拠を確認してください。` : displayValue(original);
export const displayValue = value => value === null || value === undefined || value === '' ? unknown : Array.isArray(value) ? value.length ? value.join(', ') : unknown : String(value);
export const eventSummaryLabel = summary => {
  if (typeof summary !== 'string') return unknown;
  const state = /^State → ([A-Z_]+)$/.exec(summary);
  if (state) return `状態 → ${stateLabel(state[1])}`;
  const action = /^([a-z]+) recorded$/.exec(summary);
  if (action && Object.hasOwn(maps.event, action[1])) return `${eventTypeLabel(action[1])}を記録`;
  return summary;
};
export const shortId = value => typeof value === 'string' && value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : displayValue(value);
export const shortCommit = value => typeof value === 'string' && value.length > 12 ? `${value.slice(0, 12)}…` : displayValue(value);
