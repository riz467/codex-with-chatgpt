const unknown = '未確認';
const maps = {
  state: { DONE: '完了', NEEDS_APPROVAL: '確認待ち', READY_FOR_REVIEW: 'レビュー待ち', EXECUTING: '実行中', VERIFYING: '検証中', PLANNING: '計画中', RESEARCHING: '調査中', BLOCKED: '停止中', FAILED: '失敗' },
  mode: { read_only: '読み取り専用', change: '変更あり' },
  actor: { CHATGPT: 'ChatGPT', OPENCODE: 'OpenCode', CODEX: 'Codex', HUMAN: '人', REVIEW: 'レビュー', SYSTEM: 'システム', IDLE: '待機中' },
  stage: { Research: '調査', Scope: '対象確定', Plan: '計画', Execute: '実行', Verify: '検証', Review: 'レビュー', Done: '完了' },
  pipeline: { complete: '完了', active: '実行中', waiting: '待機中', not_started: '未開始', blocked: '停止', incomplete: '未完了' },
  event: { state_transition: '状態変更', research: '調査', scope: '対象確定', plan: '計画', execute: '実行', verify: '検証', review: 'レビュー', complete: '完了', transition: '状態変更' },
  health: { verified: '確認済み', healthy: '正常', ready: '準備完了', degraded: '一部未確認', unavailable: '利用不可', heartbeat_fresh: '受信済み' },
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
export const taskStateLabel = (state, mode) => state === 'DONE'
  ? mode === 'read_only' ? '\u8aad\u307f\u53d6\u308a\u5b8c\u4e86\uff08\u4f5c\u696d\u8005\uff09' : '\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09'
  : stateLabel(state);
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

const boundedUnknown = '\u672a\u78ba\u8a8d';
const boundedStates = {
  RUNNING: '\u5b9f\u884c\u4e2d',
  REVIEW_PENDING: '\u30ec\u30d3\u30e5\u30fc\u5f85\u3061',
  REVIEW_ACCEPTED: '\u30ec\u30d3\u30e5\u30fc\u627f\u8a8d\u6e08\u307f',
  ESCALATE: '\u8981\u78ba\u8a8d'
};
const boundedExecutionProfiles = {
  tracked_typescript_dashboard: 'TypeScript ダッシュボード',
  tracked_typescript_control_plane: 'TypeScript 制御プレーン'
};
const boundedProgressModes = {
  EXECUTION: '実行中', AUTO_REVISION: '自動修正中', REVIEW_PENDING: 'レビュー待ち',
  REVIEW_ACCEPTED: 'レビュー承認済み', ESCALATE: '要確認'
};
const boundedLabel = (values, value) => typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : boundedUnknown;
const boundedHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : boundedUnknown;
const boundedBoolean = value => value === true ? '\u3042\u308a' : value === false ? '\u306a\u3057' : boundedUnknown;
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : boundedUnknown;

export const normalizeBoundedTask = task => {
  const item = task !== null && typeof task === 'object' && !Array.isArray(task) ? task : {};
  return {
    task_id: typeof item.task_id === 'string' && /^bounded-[a-f0-9]{32}$/.test(item.task_id) ? item.task_id : boundedUnknown,
    state: typeof item.state === 'string' && Object.hasOwn(boundedStates, item.state) ? boundedStates[item.state] : boundedUnknown,
    progress_mode: boundedLabel(boundedProgressModes, item.progress_mode),
    execution_profile: boundedLabel(boundedExecutionProfiles, item.execution_profile),
    stop_reason_present: boundedBoolean(item.stop_reason_present),
    contract_sha256: boundedHash(item.contract_sha256),
    edit_paths_count: Array.isArray(item.edit_paths) ? boundedCount(item.edit_paths.length) : boundedUnknown,
    latest_revision: boundedCount(item.latest_revision) !== boundedUnknown && item.latest_revision >= 1 ? String(item.latest_revision) : boundedUnknown,
    manifest_sha256: boundedHash(item.manifest_sha256),
    verification_present: boundedBoolean(item.verification_present),
    file_count: boundedCount(item.file_count),
    worker: item.worker === 'opencode' ? 'opencode' : boundedUnknown,
    review_reviewer: boundedLabel({ chatgpt: 'chatgpt', 'opencode-semantic': 'opencode-semantic' }, item.review_reviewer),
    review_verdict: item.review_verdict === 'PASS' ? '\u5408\u683c' : item.review_verdict === 'NEEDS_WORK' ? '\u8981\u4fee\u6b63' : boundedUnknown,
    latest_semantic_review_diagnostic_code: boundedLabel({ SEMANTIC_REVIEW_FAILED: 'SEMANTIC_REVIEW_FAILED', SEMANTIC_REVIEW_TIMEOUT: 'SEMANTIC_REVIEW_TIMEOUT', SEMANTIC_REVIEW_INVALID: 'SEMANTIC_REVIEW_INVALID' }, item.latest_semantic_review_diagnostic_code),
    commit_state: boundedLabel({ NOT_PREPARED: '\u672a\u6e96\u5099', PREPARED: '\u6e96\u5099\u6e08\u307f', COMMITTED: '\u30b3\u30df\u30c3\u30c8\u6e08\u307f' }, item.commit_state),
    local_commit: typeof item.local_commit === 'string' && /^[a-f0-9]{40}$/.test(item.local_commit) ? item.local_commit : boundedUnknown,
    authoritative_done: item.authoritative_done === true ? '\u3042\u308a' : item.authoritative_done === false ? '\u306a\u3057' : boundedUnknown
  };
};

const boundedStartError = () => new Error('Bounded start failed');
const boundedLines = text => typeof text === 'string' ? text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];

export const buildBoundedStartRequest = (repo, goalText, editPathText, criteriaText) => {
  const goal = typeof goalText === 'string' ? goalText.trim() : '';
  const edit_paths = boundedLines(editPathText);
  const acceptance_criteria = boundedLines(criteriaText);
  const validPath = path => path.length >= 1 && path.length <= 240 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    !path.startsWith('/') && path.split('/').every(segment => segment.length > 0 && !segment.startsWith('.'));
  if (!['codex-with-chatgpt', 'codex-with-chatgpt-control-plane'].includes(repo) ||
      !goal || goal.length > 2000 || edit_paths.length < 1 || edit_paths.length > 3 ||
      !edit_paths.every(validPath) || acceptance_criteria.length < 1 ||
      acceptance_criteria.length > 6 || acceptance_criteria.some(value => value.length > 500)) {
    throw boundedStartError();
  }
  return { repo, goal, edit_paths, acceptance_criteria };
};

export const submitBoundedStart = async (fetcher, request) => {
  try {
    const session = await fetcher('/api/bounded/start-session', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store'
    });
    if (!session.ok) throw boundedStartError();
    const token = session.headers.get('X-Bounded-Start-CSRF');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw boundedStartError();
    const response = await fetcher('/api/bounded/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Bounded-Start-CSRF': token },
      body: JSON.stringify(request)
    });
    if (!response.ok) throw boundedStartError();
    const result = await response.json();
    if (typeof result?.task_id !== 'string' || !/^bounded-[a-f0-9]{32}$/.test(result.task_id)) throw boundedStartError();
    return { task_id: result.task_id };
  } catch {
    throw boundedStartError();
  }
};

export const createBoundedStartController = (fetcher, submitter = submitBoundedStart) => {
  let busy = false;
  return {
    get busy() { return busy; },
    async start(repo, goalText, editPathText, criteriaText) {
      if (busy) return { kind: 'busy' };
      busy = true;
      try {
        const request = buildBoundedStartRequest(repo, goalText, editPathText, criteriaText);
        const result = await submitter(fetcher, request);
        if (typeof result?.task_id !== 'string' || !/^bounded-[a-f0-9]{32}$/.test(result.task_id)) throw boundedStartError();
        return { kind: 'started', task_id: result.task_id };
      } catch {
        return { kind: 'failed' };
      } finally {
        busy = false;
      }
    }
  };
};

export const createBoundedStartSubmitHandler = (controller, readValues, setDisabled, setStatus) => async event => {
  event?.preventDefault?.();
  if (controller.busy) return;
  try {
    setDisabled(true);
    setStatus('');
    const [repo, goal, paths, criteria] = readValues();
    const result = await controller.start(repo, goal, paths, criteria);
    setStatus(result.kind === 'started' ? `${result.task_id} Updates appear automatically.` : 'Bounded start failed.');
  } catch {
    setStatus('Bounded start failed.');
  } finally {
    setDisabled(false);
  }
};

export const boundedStatusRows = task => {
  const safe = normalizeBoundedTask(task);
  return [
    { label: 'Task ID', value: safe.task_id },
    { label: 'State', value: safe.state },
    { label: 'Progress', value: safe.progress_mode },
    { label: 'Reviewer', value: safe.review_reviewer },
    { label: 'Review result', value: safe.review_verdict },
    { label: 'Semantic diagnostic', value: safe.latest_semantic_review_diagnostic_code },
    { label: 'Commit state', value: safe.commit_state },
    { label: 'Local commit', value: safe.local_commit },
    { label: 'Authoritative DONE', value: safe.authoritative_done }
  ];
};

export const boundedBoardBucket = task => {
  const item = task !== null && typeof task === 'object' && !Array.isArray(task) ? task : {};
  const safe = normalizeBoundedTask(item);
  if (safe.task_id === boundedUnknown || safe.state === boundedUnknown || item.authoritative_done !== false) return 3;
  if (item.commit_state != null && !['NOT_PREPARED', 'PREPARED', 'COMMITTED'].includes(item.commit_state)) return 3;
  if (item.local_commit != null && safe.local_commit === boundedUnknown) return 3;
  if (item.commit_state === 'COMMITTED' && safe.local_commit === boundedUnknown) return 3;
  if (item.commit_state !== 'COMMITTED' && safe.local_commit !== boundedUnknown) return 3;
  if (item.state === 'ESCALATE') return 3;
  if (item.state === 'RUNNING') return item.commit_state === 'COMMITTED' ? 3 : 0;
  if (item.state === 'REVIEW_PENDING') return item.commit_state === 'COMMITTED' ? 3 : 1;
  if (item.state === 'REVIEW_ACCEPTED') return item.commit_state === 'COMMITTED' ? 2 : 1;
  return 3;
};

export const boundedTrackingRows = task => {
  const safe = normalizeBoundedTask(task);
  return [
    { label: 'Task ID', value: safe.task_id },
    { label: 'State', value: safe.state },
    { label: 'Progress', value: safe.progress_mode },
    { label: 'Revision', value: safe.latest_revision },
    { label: 'Verification', value: safe.verification_present },
    { label: 'Reviewer', value: safe.review_reviewer },
    { label: 'Review result', value: safe.review_verdict },
    { label: 'Semantic diagnostic', value: safe.latest_semantic_review_diagnostic_code },
    { label: 'Commit state', value: safe.commit_state },
    { label: 'Local commit', value: safe.local_commit },
    { label: 'Authoritative DONE', value: safe.authoritative_done }
  ];
};
