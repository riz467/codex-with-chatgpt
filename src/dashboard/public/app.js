import { stateLabel, taskStateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, reviewLabel, completionLabel, stopLabel, stopSummaryLabel, actionLabel, displayValue, shortId, shortCommit, normalizeBoundedTask } from './labels.js';

const $ = id => document.getElementById(id);
const cell = (tag, content) => { const e = document.createElement(tag); e.textContent = displayValue(content); return e; };
const clear = element => element.replaceChildren();
const pair = (root, label, content, full) => {
  const element = document.createElement('div'); element.className = 'pair';
  const text = cell('strong', content);
  if (full) text.title = full;
  element.append(cell('small', label), text); root.append(element);
  if (content === '未確認') element.classList.add('muted');
};
const stages = ['Research', 'Scope', 'Plan', 'Execute', 'Verify', 'Review', 'Done'];
const duration = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '未確認';
  const n = Math.floor(seconds), days = Math.floor(n / 86400), hours = Math.floor(n % 86400 / 3600), minutes = Math.floor(n % 3600 / 60), secs = n % 60;
  if (days) return `${days}日${hours}時間`;
  if (hours) return `${hours}時間${minutes}分`;
  if (minutes) return `${minutes}分${secs}秒`;
  return `${secs}秒`;
};
const taskFields = [
  ['task_id', 'タスクID', shortId], ['repo', 'リポジトリ'], ['state', '状態', stateLabel], ['mode', 'モード', modeLabel],
  ['actor', '担当', actorLabel], ['started_at', '開始日時'], ['elapsed_seconds', '経過時間', duration], ['attempt', '試行回数'],
  ['retry_of', '再試行元', shortId], ['stop_reason_category', '停止理由', stopLabel],
  ['stop_reason_summary', '停止理由の詳細', (value, task) => stopSummaryLabel(task.stop_reason_category, value)],
  ['human_action_required', '人による対応', value => value == null ? '未確認' : value ? '必要' : '不要'],
  ['recommended_next_action', '推奨する次の対応', (value, task) => actionLabel(task.stop_reason_category, value)],
  ['edit_paths', '変更対象'], ['verification', '検証', value => value ? `${value.completed ? '完了' : '未完了'} · 終了コード ${displayValue(value.exit_code)}` : '未確認'],
  ['review_bundle', 'レビューバンドル'], ['completion_mode', '完了方式', completionLabel],
  ['integrated_commit', '統合コミット', shortCommit]
];
function renderTask(root, task, fields, empty) {
  clear(root);
  if (!task) { root.append(cell('p', empty)); return; }
  for (const [key, label, format] of fields) {
    const raw = task[key];
    pair(root, label, key === 'state' ? taskStateLabel(raw, task.mode) : format ? format(raw, task) : raw, (key === 'task_id' || key === 'retry_of' || key === 'integrated_commit') && raw ? raw : undefined);
  }
  root.classList.add('task-grid');
  root.querySelectorAll('.pair').forEach((element, index) => {
    if (fields[index][0] === 'state') element.classList.add('state-' + (['DONE', 'NEEDS_APPROVAL', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED'].includes(task.state) ? task.state.toLowerCase() : 'default'));
  });
}
function renderSystemHealth(health) {
  const root = $('health'); clear(root);
  for (const [label, key] of [['実行ブリッジ','execution_bridge'],['レビューブリッジ','review_bridge'],['トンネル','tunnel'],['Codexワーカー','codex_worker'],['対話セッション','interactive_session'],['Dashboard','dashboard'],['ハートビート','heartbeat'],['最終確認PID','last_known_pid'],['最終確認セッション','last_known_session'],['最終ハートビート','last_heartbeat_age_seconds'],['キュー','queue_depth']]) {
    const raw = health?.[key];
    const item = health?.verified_health?.[key];
    const value = item ? healthLabel(item.status) : key === 'last_heartbeat_age_seconds' && raw != null ? `${duration(raw)}前` : typeof raw === 'string' ? healthLabel(raw) : raw;
    pair(root, label, value);
    if (item) {
      const details = [item.summary, item.pid != null ? `PID ${item.pid}` : null, item.session_id != null ? `Session ${item.session_id}` : null,
        item.observed_at ? `確認 ${duration(Math.max(0, (Date.now() - Date.parse(item.observed_at)) / 1000))}前` : null].filter(Boolean);
      root.lastElementChild.append(cell('small', details.join(' · ')));
      root.lastElementChild.classList.add('health-' + (['verified','healthy','ready','degraded','unavailable'].includes(item.status) ? item.status : 'unknown'));
    }
  }
}
function renderCurrentTask(task) { renderTask($('current'), task, taskFields, '実行中のタスクはありません'); }
function renderLatestTask(task) { renderTask($('latest'), task, taskFields.slice(0, 7), 'タスクの証拠はありません'); }
function renderAutonomous(runs) {
  const root = $('autonomous'); clear(root);
  const run = runs?.[0];
  if (!run) { root.append(cell('p', '自律実行の証拠はありません')); return; }
  const labels = { RESEARCH: '調査中', PLAN: '計画中', EXECUTE: 'Codex実行中', VERIFY: '検証中', RETRY_VERIFY: 'RetryVerify中',
    REVIEW_HANDOFF: '構造レビュー待ち', REVIEWING: 'レビュー中', STRUCTURAL_REVIEW: '構造レビュー中', SEMANTIC_REVIEW: '意味レビュー中',
    HUMAN_FINAL_APPROVAL: '人間承認待ち', ESCALATE: '停止 / 要確認', READY_FOR_REVIEW: 'レビュー待ち', DONE_CANDIDATE_NO_CHANGE: '変更不要' };
  for (const [label, value] of [['Run ID', run.run_id], ['Task ID', run.task_id], ['Repo', run.repo],
    ['\u6bb5\u968e', run.done ? '\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09' : labels[run.live_stage] ?? '\u672a\u78ba\u8a8d'], ['\u62c5\u5f53', run.actor], ['\u5224\u65ad', run.decision],
    ['構造レビュー', run.review_phase?.structural], ['意味レビュー', run.review_phase?.semantic],
    ['人間の操作', run.human_action_required ? '承認が必要' : '不要 / 未確認'], ['最終結果', run.final_result],
    ['OpenCode input / output / reasoning', [run.usage?.opencode?.input, run.usage?.opencode?.output, run.usage?.opencode?.reasoning].map(displayValue).join(' / ')],
    ['OpenCode cache read / write', [run.usage?.opencode?.cache_read, run.usage?.opencode?.cache_write].map(displayValue).join(' / ')],
    ['Codex呼出', run.usage?.codex_invocations],
    ['Review input / output / reasoning', [run.usage?.review?.input, run.usage?.review?.output, run.usage?.review?.reasoning].map(displayValue).join(' / ')],
    ['Review cache read / write', [run.usage?.review?.cache_read, run.usage?.review?.cache_write].map(displayValue).join(' / ')]]) pair(root, label, value);
  root.classList.add('task-grid');
  const events = document.createElement('div'); events.className = 'autonomous-events';
  for (const event of run.events ?? []) events.append(cell('p', `${event.timestamp} · ${event.event_type}`));
  root.append(events);
}
const boardBuckets = ['\u51e6\u7406\u4e2d', '\u30ec\u30d3\u30e5\u30fc\u5f85\u3061', '\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09', '\u8981\u78ba\u8a8d'];
function boardBucket(state, bounded) {
  if (bounded) {
    if (state === 'RUNNING') return 0;
    if (state === 'REVIEW_PENDING' || state === 'REVIEW_ACCEPTED') return 1;
  } else {
    if (['PLANNING', 'RESEARCHING', 'EXECUTING', 'VERIFYING'].includes(state)) return 0;
    if (state === 'READY_FOR_REVIEW') return 1;
    if (state === 'DONE') return 2;
  }
  return 3;
}
function renderTaskBoard(snapshot) {
  let section = $('task-board');
  if (!section) {
    section = document.createElement('section'); section.id = 'task-board';
    section.append(cell('h2', 'Task Board'));
    $('status-bar').insertAdjacentElement('afterend', section);
  }
  section.querySelectorAll('.task-board-bucket').forEach(clear);
  section.querySelectorAll('.task-board-bucket').forEach(element => element.remove());
  const buckets = boardBuckets.map(() => []);
  for (const task of Array.isArray(snapshot.recent_tasks) ? snapshot.recent_tasks : []) {
    buckets[boardBucket(task?.state, false)].push({ task, bounded: false });
  }
  for (const task of Array.isArray(snapshot.bounded_tasks) ? snapshot.bounded_tasks : []) {
    buckets[boardBucket(task?.state, true)].push({ task, bounded: true });
  }
  buckets.forEach((entries, index) => {
    const bucket = document.createElement('div'); bucket.className = 'task-board-bucket';
    bucket.append(cell('h3', `${boardBuckets[index]} (${entries.length})`));
    const list = document.createElement('ul');
    for (const { task, bounded } of entries.slice(0, 5)) {
      const item = document.createElement('li');
      if (bounded) {
        const safe = normalizeBoundedTask(task);
        const label = `${displayValue(safe.task_id)} · ${safe.progress_mode}`;
        if (task?.state === 'REVIEW_PENDING' || task?.state === 'REVIEW_ACCEPTED') {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = label;
          button.addEventListener('click', () => showBoundedReviewSummary(task));
          item.append(button);
        } else item.append(cell('span', label));
      } else {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = displayValue(shortId(task.task_id));
        button.addEventListener('click', () => { void showTaskDetails(task.task_id); });
        item.append(button, document.createTextNode(' '), cell('span', task.repo), document.createTextNode(' · '), cell('span', taskStateLabel(task.state, task.mode)));
      }
      list.append(item);
    }
    bucket.append(list); section.append(bucket);
  });
}
async function refreshAuthorityStatus() {
  const section = document.createElement('section'); section.id = 'authority-status';
  section.append(cell('h2', '\u6a29\u9650\u72b6\u614b'));
  const details = document.createElement('div'); details.className = 'task-grid';
  section.append(details);
  $('status-bar').insertAdjacentElement('afterend', section);
  const unavailable = '\u672a\u78ba\u8a8d';
  try {
    const response = await fetch('/api/authority-status', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Authority status unavailable');
    const status = await response.json();
    for (const [label, key] of [
      ['\u30ed\u30fc\u30ab\u30eb Review', 'local_review'],
      ['\u30ed\u30fc\u30ab\u30eb DONE', 'local_done']
    ]) pair(details, label, status?.[key] === 'projection_only' ? '\u6295\u5f71\u306e\u307f\uff08\u6a29\u5a01\u3042\u308b\u78ba\u5b9a\u3067\u306f\u306a\u3044\uff09' : unavailable);
    for (const [label, key] of [
      ['\u72ec\u7acb Review Authority', 'independent_review_authority_connected'],
      ['\u7f72\u540d\u4ed8\u304d Approver \u9023\u643a', 'signed_approver_integration_connected'],
      ['Finalizer', 'finalizer_connected'],
      ['\u6a29\u5a01\u3042\u308b DONE', 'authoritative_done_available']
    ]) pair(details, label, status?.[key] === false ? '\u672a\u63a5\u7d9a\uff0f\u5229\u7528\u4e0d\u53ef' : unavailable);
  } catch {
    clear(details);
    details.append(cell('p', '\u6a29\u9650\u72b6\u614b\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3002\u6a29\u5a01\u3042\u308b\u5b8c\u4e86\u306f\u672a\u78ba\u8a8d\u3067\u3059\u3002'));
  }
}
function showBoundedReviewSummary(task) {
  let section = $('bounded-review-summary');
  if (!section) {
    section = document.createElement('section'); section.id = 'bounded-review-summary';
    section.append(cell('h2', '\u5909\u66f4\u5185\u5bb9'));
    $('task-board').insertAdjacentElement('afterend', section);
  }
  let fields = $('bounded-review-summary-fields');
  if (!fields) {
    fields = document.createElement('div'); fields.id = 'bounded-review-summary-fields';
    fields.className = 'task-grid'; section.append(fields);
  }
  clear(fields);
  const safe = normalizeBoundedTask(task);
  const paths = Array.isArray(task.edit_paths) ? task.edit_paths.filter(path => typeof path === 'string').join(', ') : null;
  for (const [label, value] of [
    ['\u76ee\u7684', typeof task.goal === 'string' ? task.goal : null],
    ['進行状況', safe.progress_mode],
    ['実行プロファイル', safe.execution_profile],
    ['\u5909\u66f4\u30d1\u30b9', paths],
    ['\u30ea\u30d3\u30b8\u30e7\u30f3', task.latest_revision],
    ['\u691c\u8a3c\u72b6\u614b', task.verification_present === true ? '\u3042\u308a' : '\u306a\u3057'],
    ['\u5909\u66f4\u30d5\u30a1\u30a4\u30eb\u6570', task.file_count],
    ['\u4f5c\u696d\u8005', task.worker],
    ['\u30ec\u30d3\u30e5\u30fc\u7d50\u679c', task.review_verdict]
  ]) pair(fields, label, value);
}
const boundedFields = [
  ['task_id', 'Task ID'], ['state', '\u72b6\u614b'], ['progress_mode', '進行状況'], ['execution_profile', '実行プロファイル'],
  ['stop_reason_present', '\u505c\u6b62\u7406\u7531'],
  ['contract_sha256', 'Contract SHA256'], ['edit_paths_count', '\u5909\u66f4\u5bfe\u8c61\u6570'],
  ['latest_revision', '\u6700\u65b0\u30ea\u30d3\u30b8\u30e7\u30f3'], ['manifest_sha256', 'Manifest SHA256'],
  ['verification_present', '\u691c\u8a3c'], ['file_count', '\u30d5\u30a1\u30a4\u30eb\u6570'],
  ['worker', 'Worker'], ['review_verdict', '\u30ec\u30d3\u30e5\u30fc\u7d50\u679c']
];
function renderBoundedTasks(tasks) {
  const autonomous = $('autonomous');
  let section = $('bounded-opencode');
  if (!section) {
    section = document.createElement('section'); section.id = 'bounded-opencode';
    const heading = document.createElement('h2'); heading.textContent = 'Bounded OpenCode';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.id = 'bounded-opencode-summary';
    const list = document.createElement('div'); list.id = 'bounded-opencode-tasks';
    details.append(summary, list); section.append(heading, details);
    (autonomous.closest('section') || autonomous).insertAdjacentElement('afterend', section);
  }
  const list = $('bounded-opencode-tasks'); clear(list);
  $('bounded-opencode-summary').textContent = `Tasks (${Array.isArray(tasks) ? tasks.length : 0})`;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    list.append(cell('p', '\u8868\u793a\u3067\u304d\u308b\u30bf\u30b9\u30af\u306f\u3042\u308a\u307e\u305b\u3093'));
    return;
  }
  for (const task of tasks) {
    const safe = normalizeBoundedTask(task);
    const card = document.createElement('div'); card.className = 'task-grid';
    for (const [key, label] of boundedFields) pair(card, label, safe[key]);
    list.append(card);
  }
}
const approvalFields = ['task_id', 'run_id', 'authoritative_review_id', 'goal', 'review_evidence_hash', 'bundle_manifest_sha256', 'canonical_goal_hash'];
let approval = null, approvalCheckAt = 0, approving = false, approvalResult = null;
const approvalButton = $('approve-done');
function renderApproval() {
  const section = $('final-approval'); section.hidden = !approval && !approvalResult;
  const details = $('final-approval-details'); clear(details);
  if (approval) {
    for (const [label, value] of [['Goal', approval.goal], ['Task ID', approval.task_id], ['Run ID', approval.run_id],
      ['Review ID', approval.authoritative_review_id], ['Review evidence SHA256', approval.review_evidence_hash],
      ['Manifest SHA256', approval.bundle_manifest_sha256], ['Canonical goal SHA256', approval.canonical_goal_hash]]) pair(details, label, value);
  }
  approvalButton.disabled = approving || !approval || approval.fixture_approval_enabled !== true;
  $('final-approval-message').textContent = approvalResult ??
    (!approval || approval.fixture_approval_enabled !== true
      ? 'DONE approval is disabled: the independent Approver/Finalizer path is not connected.' : '');
}
async function refreshApproval() {
  if (approving || Date.now() - approvalCheckAt < 5000) return;
  approvalCheckAt = Date.now();
  try {
    const response = await fetch('/api/approval/candidate', { credentials: 'same-origin', cache: 'no-store' });
    const candidate = response.ok ? await response.json() : null;
    if (approving) return;
    approval = candidate;
  } catch { if (approving) return; approval = null; }
  renderApproval();
}
approvalButton.addEventListener('click', async event => {
  if (!event.isTrusted || !approval || approval.fixture_approval_enabled !== true || approving ||
      !window.confirm('Confirm the current goal and Review and explicitly approve DONE for this task?')) return;
  const preview = approval;
  approving = true; approvalResult = null; renderApproval();
  try {
    const response = await fetch('/approval/current', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Current approval candidate is no longer available.');
    const current = await response.json();
    if (approvalFields.some(key => typeof preview[key] !== 'string' || preview[key] !== current[key]) ||
        typeof current.csrf !== 'string') throw new Error('Approval candidate changed. Refresh and review it again.');
    const request = { action: 'FINAL_DONE_APPROVAL', task_id: current.task_id, run_id: current.run_id,
      authoritative_review_id: current.authoritative_review_id };
    const posted = await fetch('/approval/final', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Final-Approval-CSRF': current.csrf }, body: JSON.stringify(request) });
    if (!posted.ok) throw new Error('Approval rejected. Refresh and review the current candidate.');
    approvalResult = 'Explicit approval recorded. Completion and DONE remain separate.';
    approval = null;
  } catch (error) {
    approval = null;
    approvalResult = error instanceof Error ? error.message : 'Approval failed. Refresh and review the current candidate.';
  } finally { approving = false; approvalCheckAt = 0; renderApproval(); void refreshApproval(); }
});
function renderSource(task, current) {
  const source = task ? `（${current ? '実行中タスク' : '最新の履歴タスク'}: ${task.task_id}）` : '（証拠なし）';
  $('pipeline-source').textContent = source;
  $('events-source').textContent = source;
}
function renderPipeline(task) {
  const root = arguments.length > 1 ? arguments[1] : $('pipeline'); clear(root);
  for (const name of stages) {
    const status = task?.pipeline?.[name] ?? 'unknown';
    const element = document.createElement('div');
    element.className = 'stage ' + (['complete','active','waiting','not_started','blocked','incomplete'].includes(status) ? status : 'unknown');
    element.append(cell('b', stageLabel(name)), cell('small', pipelineLabel(status))); root.append(element);
  }
}
function renderLiveEvents(events) {
  const root = arguments.length > 1 ? arguments[1] : $('events'); clear(root);
  for (const event of events || []) {
    const row = document.createElement('div'); row.className = 'event';
    row.append(cell('time', new Date(event.timestamp).toLocaleString('ja-JP')), cell('b', actorLabel(event.actor)), cell('span', `${eventTypeLabel(event.event_type)} · ${eventSummaryLabel(event.summary)}`));
    root.append(row);
  }
  if (!root.childNodes.length) root.append(cell('p', '表示できる実行ログはありません'));
}
let selectedTaskRequest = 0;
async function showTaskDetails(taskId) {
  let section = $('selected-task-details');
  if (!section) {
    section = document.createElement('section'); section.id = 'selected-task-details';
    const heading = cell('h2', 'Task details');
    const status = document.createElement('p'); status.id = 'selected-task-status'; status.setAttribute('role', 'status');
    const fields = document.createElement('div'); fields.id = 'selected-task-fields';
    const pipelineHeading = cell('h3', 'Pipeline');
    const pipeline = document.createElement('div'); pipeline.id = 'selected-task-pipeline';
    const eventsHeading = cell('h3', 'Events');
    const events = document.createElement('div'); events.id = 'selected-task-events';
    section.append(heading, status, fields, pipelineHeading, pipeline, eventsHeading, events);
    ($('tasks').closest('table') || $('tasks')).insertAdjacentElement('afterend', section);
  }
  const request = ++selectedTaskRequest;
  $('selected-task-status').textContent = '読み込み中';
  for (const id of ['selected-task-fields', 'selected-task-pipeline', 'selected-task-events']) clear($(id));
  try {
    const encodedId = encodeURIComponent(String(taskId));
    const [taskResponse, eventsResponse] = await Promise.all([
      fetch(`/api/tasks/${encodedId}`, { method: 'GET', credentials: 'same-origin' }),
      fetch(`/api/events/${encodedId}`, { method: 'GET', credentials: 'same-origin' })
    ]);
    if (!taskResponse.ok || !eventsResponse.ok) throw new Error('Task details could not be loaded.');
    const [task, events] = await Promise.all([taskResponse.json(), eventsResponse.json()]);
    if (request !== selectedTaskRequest) return;
    renderTask($('selected-task-fields'), task, taskFields, 'Task not found.');
    renderPipeline(task, $('selected-task-pipeline'));
    renderLiveEvents(events, $('selected-task-events'));
    $('selected-task-status').textContent = '';
  } catch {
    if (request !== selectedTaskRequest) return;
    for (const id of ['selected-task-fields', 'selected-task-pipeline', 'selected-task-events']) clear($(id));
    $('selected-task-status').textContent = 'Task details could not be loaded.';
  }
}
function renderRecentTasks(tasks) {
  const root = $('tasks'); clear(root);
  for (const task of tasks || []) {
    const row = document.createElement('tr');
    const fields = [
      [shortId(task.task_id), task.task_id], [task.repo], [taskStateLabel(task.state, task.mode)], [modeLabel(task.mode)],
      [`${displayValue(task.created_at)} / ${displayValue(task.completed_at)}`], [task.attempt], [shortId(task.retry_of), task.retry_of],
      [reviewLabel(task.review_result)], [completionLabel(task.completion_mode)], [shortCommit(task.integrated_commit), task.integrated_commit]
    ];
    for (const [content, full] of fields) { const td = cell('td', content); if (full) td.title = full; row.append(td); }
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button'; detailsButton.textContent = '詳細';
    detailsButton.addEventListener('click', () => { void showTaskDetails(task.task_id); });
    row.firstElementChild.append(document.createTextNode(' '), detailsButton);
    const state = row.children[2];
    state.className = 'state-' + (['DONE', 'NEEDS_APPROVAL', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED'].includes(task.state) ? task.state.toLowerCase() : 'default');
    root.append(row);
  }
}
function renderStatusBar(task) {
  const bar = $('status-bar');
  if (!task) { bar.textContent = '● 待機中 — 実行中のタスクはありません'; bar.className = 'status-bar idle'; return; }
  const knownActor = task.actor && !['UNKNOWN', 'unknown', 'IDLE'].includes(task.actor);
  const heading = knownActor ? `${actorLabel(task.actor)} ${taskStateLabel(task.state, task.mode)}` : 'タスク実行中';
  const elapsed = Number.isFinite(task.elapsed_seconds) && task.elapsed_seconds >= 0 ? ` — ${duration(task.elapsed_seconds)}` : '';
  bar.textContent = `● ${heading} — ${displayValue(task.repo)}${elapsed}`;
  bar.className = 'status-bar active';
}
function render(snapshot) {
  $('connection').textContent = `受信中 · ${new Date(snapshot.generated_at).toLocaleTimeString('ja-JP')}`;
  renderStatusBar(snapshot.current_task);
  renderTaskBoard(snapshot);
  renderSystemHealth(snapshot.health);
  renderCurrentTask(snapshot.current_task);
  renderLatestTask(snapshot.latest_task);
  renderAutonomous(snapshot.autonomous_runs);
  renderBoundedTasks(snapshot.bounded_tasks);
  void refreshApproval();
  const observed = snapshot.current_task || snapshot.latest_task;
  renderSource(observed, !!snapshot.current_task);
  renderPipeline(observed);
  renderLiveEvents(snapshot.events);
  renderRecentTasks(snapshot.recent_tasks);
}

void refreshAuthorityStatus();

// The snapshot is the only input to the view; a future event adapter can update sections independently.
const stream = new EventSource('/events');
stream.addEventListener('snapshot', event => render(JSON.parse(event.data)));
stream.onerror = () => { $('connection').textContent = '再接続中…'; };
