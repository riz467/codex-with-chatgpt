const $ = id => document.getElementById(id);
const value = v => v === null || v === undefined || v === '' ? 'unknown' : Array.isArray(v) ? v.join(', ') || 'unknown' : String(v);
const cell = (tag, content) => { const e = document.createElement(tag); e.textContent = value(content); return e; };
const clear = e => e.replaceChildren();
const pair = (root, key, v) => { const d = document.createElement('div'); d.className = 'pair'; d.append(cell('small', key), cell('strong', v)); root.append(d); };
const stageNames = ['Research','Scope','Plan','Execute','Verify','Review','Done'];
const duration = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const n = Math.floor(seconds), days = Math.floor(n / 86400), hours = Math.floor(n % 86400 / 3600), minutes = Math.floor(n % 3600 / 60), secs = n % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
};
function render(data) {
  $('connection').textContent = `Live · ${new Date(data.generated_at).toLocaleTimeString()}`;
  const health = $('health'); clear(health);
  for (const [label, key] of [['Execution Bridge','execution_bridge'],['Review Bridge','review_bridge'],['Tunnel','tunnel'],['Codex Worker','codex_worker'],['Interactive Session','interactive_session'],['Heartbeat','heartbeat'],['Last known PID','last_known_pid'],['Last known Session','last_known_session'],['Last heartbeat','last_heartbeat_age_seconds'],['Queue','queue_depth']]) {
    const v = data.health[key];
    pair(health, label, key === 'last_heartbeat_age_seconds' && v != null ? `${duration(v)} ago` : v);
  }
  const current = $('current'); clear(current);
  const task = data.current_task;
  if (!task) current.append(cell('p', 'No active task'));
  else for (const key of ['task_id','repo','state','mode','actor','started_at','elapsed_seconds','attempt','retry_of','stop_reason_category','stop_reason_summary','human_action_required','recommended_next_action','edit_paths','verification','review_bundle','completion_mode','integrated_commit']) pair(current, key === 'elapsed_seconds' ? 'Elapsed' : key.replaceAll('_',' '), key === 'elapsed_seconds' ? duration(task[key]) : key === 'verification' ? task.verification && `${task.verification.completed ? 'complete' : 'incomplete'} · exit ${value(task.verification.exit_code)}` : task[key]);
  const latest = $('latest'); clear(latest);
  if (data.latest_task) for (const key of ['task_id','repo','state','mode','elapsed_seconds']) pair(latest, key === 'elapsed_seconds' ? 'elapsed' : key.replaceAll('_',' '), key === 'elapsed_seconds' ? duration(data.latest_task[key]) : data.latest_task[key]);
  else latest.append(cell('p', 'No task evidence available'));
  const observed = task || data.latest_task;
  $('pipeline-source').textContent = observed ? `(${task ? 'current' : 'latest historical'}: ${observed.task_id})` : '(no evidence)';
  $('events-source').textContent = $('pipeline-source').textContent;
  const pipeline = $('pipeline'); clear(pipeline);
  for (const name of stageNames) { const e = document.createElement('div'); e.className = 'stage ' + (observed?.pipeline?.[name] || 'unknown'); e.append(cell('b', name),cell('small', observed?.pipeline?.[name])); pipeline.append(e); }
  const events = $('events'); clear(events);
  for (const ev of data.events || []) { const row = document.createElement('div'); row.className = 'event'; row.append(cell('time', new Date(ev.timestamp).toLocaleString()),cell('b', ev.actor),cell('span', `${ev.event_type} · ${ev.summary}`)); events.append(row); }
  if (!events.childNodes.length) events.append(cell('p','No safe event evidence available'));
  const tbody = $('tasks'); clear(tbody);
  for (const t of data.recent_tasks || []) { const tr = document.createElement('tr'); for (const k of ['task_id','repo','state','mode','created_at','attempt','retry_of','review_result','completion_mode','integrated_commit']) tr.append(cell('td',k === 'created_at' ? `${value(t.created_at)} / ${value(t.completed_at)}` : t[k])); tbody.append(tr); }
}
const stream = new EventSource('/events');
stream.addEventListener('snapshot', e => render(JSON.parse(e.data)));
stream.onerror = () => { $('connection').textContent = 'Reconnecting…'; };
