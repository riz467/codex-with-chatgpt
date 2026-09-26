import { stateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, reviewLabel, completionLabel, stopLabel, stopSummaryLabel, actionLabel, displayValue, shortId, shortCommit } from './labels.js';

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
    pair(root, label, format ? format(raw, task) : raw, (key === 'task_id' || key === 'retry_of' || key === 'integrated_commit') && raw ? raw : undefined);
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
    ['段階', run.done ? '完了' : labels[run.live_stage] ?? '未確認'], ['担当', run.actor], ['判断', run.decision],
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
let approval = null, approvalCheckAt = 0, approving = false;
async function refreshApproval() {
  if (approving || Date.now() - approvalCheckAt < 5000) return;
  approvalCheckAt = Date.now();
  try {
    const response = await fetch('/approval/current', { credentials: 'same-origin', cache: 'no-store' });
    approval = response.ok ? await response.json() : null;
  } catch { approval = null; }
  const section = $('final-approval'); section.hidden = !approval;
  const details = $('final-approval-details'); clear(details);
  if (approval) {
    for (const [label, value] of [['Goal', approval.goal], ['Task ID', approval.task_id], ['Run ID', approval.run_id],
      ['Review ID', approval.authoritative_review_id], ['Review evidence SHA256', approval.review_evidence_hash],
      ['Manifest SHA256', approval.bundle_manifest_sha256], ['Canonical goal SHA256', approval.canonical_goal_hash]]) pair(details, label, value);
  }
}
$('approve-done').addEventListener('click', async event => {
  if (!event.isTrusted || !approval || approving || !window.confirm('現在のgoal・Reviewを確認しましたか？ このtaskのDONEを明示的に承認します。')) return;
  approving = true; $('approve-done').disabled = true;
  const request = { action: 'FINAL_DONE_APPROVAL', task_id: approval.task_id, run_id: approval.run_id,
    authoritative_review_id: approval.authoritative_review_id };
  try {
    const response = await fetch('/approval/final', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Final-Approval-CSRF': approval.csrf }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error('承認は拒否されました。現在のReviewを再確認してください。');
    $('final-approval-message').textContent = '明示承認を記録しました。MCP Completeの実行・ledger DONE確認は別途必要です。';
    approval = null; $('final-approval').hidden = true;
  } catch (error) { $('final-approval-message').textContent = error.message; }
  finally { approving = false; $('approve-done').disabled = false; approvalCheckAt = 0; }
});
function renderSource(task, current) {
  const source = task ? `（${current ? '実行中タスク' : '最新の履歴タスク'}: ${task.task_id}）` : '（証拠なし）';
  $('pipeline-source').textContent = source;
  $('events-source').textContent = source;
}
function renderPipeline(task) {
  const root = $('pipeline'); clear(root);
  for (const name of stages) {
    const status = task?.pipeline?.[name] ?? 'unknown';
    const element = document.createElement('div');
    element.className = 'stage ' + (['complete','active','waiting','not_started','blocked','incomplete'].includes(status) ? status : 'unknown');
    element.append(cell('b', stageLabel(name)), cell('small', pipelineLabel(status))); root.append(element);
  }
}
function renderLiveEvents(events) {
  const root = $('events'); clear(root);
  for (const event of events || []) {
    const row = document.createElement('div'); row.className = 'event';
    row.append(cell('time', new Date(event.timestamp).toLocaleString('ja-JP')), cell('b', actorLabel(event.actor)), cell('span', `${eventTypeLabel(event.event_type)} · ${eventSummaryLabel(event.summary)}`));
    root.append(row);
  }
  if (!root.childNodes.length) root.append(cell('p', '表示できる実行ログはありません'));
}
function renderRecentTasks(tasks) {
  const root = $('tasks'); clear(root);
  for (const task of tasks || []) {
    const row = document.createElement('tr');
    const fields = [
      [shortId(task.task_id), task.task_id], [task.repo], [stateLabel(task.state)], [modeLabel(task.mode)],
      [`${displayValue(task.created_at)} / ${displayValue(task.completed_at)}`], [task.attempt], [shortId(task.retry_of), task.retry_of],
      [reviewLabel(task.review_result)], [completionLabel(task.completion_mode)], [shortCommit(task.integrated_commit), task.integrated_commit]
    ];
    for (const [content, full] of fields) { const td = cell('td', content); if (full) td.title = full; row.append(td); }
    const state = row.children[2];
    state.className = 'state-' + (['DONE', 'NEEDS_APPROVAL', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED'].includes(task.state) ? task.state.toLowerCase() : 'default');
    root.append(row);
  }
}
function renderStatusBar(task) {
  const bar = $('status-bar');
  if (!task) { bar.textContent = '● 待機中 — 実行中のタスクはありません'; bar.className = 'status-bar idle'; return; }
  const knownActor = task.actor && !['UNKNOWN', 'unknown', 'IDLE'].includes(task.actor);
  const heading = knownActor ? `${actorLabel(task.actor)} ${stateLabel(task.state)}` : 'タスク実行中';
  const elapsed = Number.isFinite(task.elapsed_seconds) && task.elapsed_seconds >= 0 ? ` — ${duration(task.elapsed_seconds)}` : '';
  bar.textContent = `● ${heading} — ${displayValue(task.repo)}${elapsed}`;
  bar.className = 'status-bar active';
}
function render(snapshot) {
  $('connection').textContent = `受信中 · ${new Date(snapshot.generated_at).toLocaleTimeString('ja-JP')}`;
  renderStatusBar(snapshot.current_task);
  renderSystemHealth(snapshot.health);
  renderCurrentTask(snapshot.current_task);
  renderLatestTask(snapshot.latest_task);
  renderAutonomous(snapshot.autonomous_runs);
  void refreshApproval();
  const observed = snapshot.current_task || snapshot.latest_task;
  renderSource(observed, !!snapshot.current_task);
  renderPipeline(observed);
  renderLiveEvents(snapshot.events);
  renderRecentTasks(snapshot.recent_tasks);
}

// The snapshot is the only input to the view; a future event adapter can update sections independently.
const stream = new EventSource('/events');
stream.addEventListener('snapshot', event => render(JSON.parse(event.data)));
stream.onerror = () => { $('connection').textContent = '再接続中…'; };
