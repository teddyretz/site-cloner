export function renderReviewUi(token: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replicator review</title>
  <style>
    :root { color-scheme: light; --ink:#17201d; --muted:#66736d; --paper:#fbfaf6; --card:#fff; --line:#d9ddd9; --green:#174f3a; --green-soft:#e9f6ee; --amber:#a15c00; --amber-soft:#fff4de; --red:#9c2f2f; --red-soft:#fff0ef; --blue:#265e8e; --blue-soft:#edf5fc; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:10; background:#fbfaf6ee; backdrop-filter:blur(14px); border-bottom:1px solid var(--line); }
    .wrap { width:min(1180px,calc(100% - 32px)); margin:auto; }
    header .wrap { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:18px 0; }
    h1 { margin:0; font-size:21px; letter-spacing:-.02em; }
    h2 { margin:0; font-size:18px; }
    p { margin:.35rem 0 0; }
    .muted { color:var(--muted); }
    .score { font-weight:800; color:var(--green); font-size:20px; white-space:nowrap; }
    .summary { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; padding:26px 0 18px; }
    .metric { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:15px; }
    .metric strong { display:block; font-size:22px; }
    .metric span { color:var(--muted); font-size:13px; }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:10px 0 18px; }
    .filters { display:flex; flex-wrap:wrap; gap:8px; }
    .filter { border:1px solid var(--line); background:white; border-radius:999px; padding:7px 11px; cursor:pointer; }
    .filter.active { background:var(--ink); color:white; border-color:var(--ink); }
    .difference { background:var(--card); border:1px solid var(--line); border-radius:16px; margin:0 0 14px; overflow:hidden; box-shadow:0 8px 28px #26332e0a; }
    .difference.accepted { border-left:5px solid var(--green); }
    .difference.fix-replica { border-left:5px solid var(--red); }
    .difference.unresolved { border-left:5px solid var(--amber); }
    .difference-head { display:flex; justify-content:space-between; gap:18px; padding:18px 20px 14px; }
    .badges { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:8px; }
    .badge { border-radius:999px; padding:3px 8px; font-size:12px; font-weight:700; background:#eff1ef; }
    .badge.ui { background:var(--blue-soft); color:var(--blue); }
    .badge.api { background:#f0edfc; color:#674aa3; }
    .badge.data { background:var(--amber-soft); color:var(--amber); }
    .badge.workflow { background:#edf0f2; color:#44515b; }
    .path { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); overflow-wrap:anywhere; }
    .compare { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .value { background:#f8f9f7; padding:14px 20px; min-width:0; }
    .value label { display:block; text-transform:uppercase; color:var(--muted); font-size:11px; font-weight:800; letter-spacing:.08em; margin-bottom:7px; }
    pre { max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin:0; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .decision { display:grid; grid-template-columns:190px 170px 1fr auto; gap:10px; align-items:end; padding:16px 20px 20px; }
    .field label { display:block; color:var(--muted); font-size:12px; font-weight:700; margin:0 0 5px; }
    select,textarea,input,button { font:inherit; }
    select,textarea,input { width:100%; border:1px solid #bdc5c0; border-radius:9px; background:white; padding:9px 10px; color:var(--ink); }
    textarea { min-height:42px; max-height:120px; resize:vertical; }
    button.save { border:0; border-radius:9px; padding:10px 15px; background:var(--green); color:white; font-weight:800; cursor:pointer; }
    button.save:disabled { opacity:.5; cursor:wait; }
    .saved { color:var(--green); font-size:12px; min-height:18px; margin-top:4px; }
    .empty,.error { background:white; border:1px solid var(--line); border-radius:16px; padding:28px; }
    .error { color:var(--red); background:var(--red-soft); }
    footer { padding:25px 0 50px; color:var(--muted); font-size:13px; }
    @media (max-width:850px) { .summary { grid-template-columns:repeat(2,1fr); } .decision { grid-template-columns:1fr 1fr; } .decision .field.note { grid-column:1/-1; } }
    @media (max-width:600px) { .compare,.decision { grid-template-columns:1fr; } header .wrap { align-items:flex-start; } .score { font-size:16px; } }
  </style>
</head>
<body>
  <header><div class="wrap"><div><h1>Replicator review</h1><p class="muted" id="subtitle">Loading comparison…</p></div><div class="score" id="score">—</div></div></header>
  <main class="wrap">
    <section class="summary" id="summary"></section>
    <section class="toolbar"><div class="filters" id="filters"></div><label class="field" style="width:220px"><span class="muted">Reviewer</span><input id="reviewer" value="local-reviewer" maxlength="500"></label></section>
    <section id="differences"></section>
  </main>
  <footer class="wrap">Decisions are stored locally. Exact rules match only the same observed values; path rules intentionally apply to future values at the same workflow check.</footer>
  <script nonce="${nonce}">
    const token = ${JSON.stringify(token)};
    let state;
    let activeFilter = 'all';
    const decisions = [
      ['unresolved','Not decided'],
      ['fix-replica','Replica must be fixed'],
      ['expected','Expected difference'],
      ['noise','Ignore as noise'],
      ['legacy-bug','Source app is wrong']
    ];
    const api = async (path, options = {}) => {
      const response = await fetch(path, { ...options, headers: { 'content-type':'application/json', 'x-replicator-review-token':token, ...(options.headers || {}) } });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Request failed');
      return value;
    };
    const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
    const percent = value => (value * 100).toFixed(1) + '%';
    function render() {
      const { report, review } = state;
      document.getElementById('subtitle').textContent = report.workflow + ' · ' + report.sourceRunId + ' → ' + report.replicaRunId;
      document.getElementById('score').textContent = percent(review.adjustedParityScore) + ' accepted parity';
      const metrics = [
        [percent(review.originalParityScore),'Observed parity'],
        [review.counts.reviewed + '/' + review.counts.totalDifferences,'Reviewed'],
        [review.counts.accepted,'Accepted'],
        [review.counts.actionable,'Must fix'],
        [review.counts.unresolved,'Unresolved']
      ];
      const summary = document.getElementById('summary'); summary.replaceChildren();
      for (const [value,label] of metrics) { const card = text('div','', 'metric'); card.append(text('strong',String(value)),text('span',label)); summary.append(card); }
      const filters = [['all','All'],['unresolved','Unresolved'],['fix-replica','Must fix'],['accepted','Accepted'],['ui','UI'],['api','API'],['data','Data']];
      const filterRoot = document.getElementById('filters'); filterRoot.replaceChildren();
      for (const [value,label] of filters) { const button = text('button',label,'filter' + (activeFilter === value ? ' active' : '')); button.onclick = () => { activeFilter=value; render(); }; filterRoot.append(button); }
      const root = document.getElementById('differences'); root.replaceChildren();
      const visible = review.differences.filter(item => activeFilter === 'all' || (activeFilter === 'accepted' ? item.accepted : item.decision === activeFilter || item.difference.layer === activeFilter));
      if (!visible.length) root.append(text('div','No differences in this view.','empty'));
      for (const item of visible) root.append(renderDifference(item));
    }
    function renderDifference(item) {
      const difference = item.difference;
      const card = text('article','', 'difference ' + (item.accepted ? 'accepted' : item.decision));
      const head = text('div','', 'difference-head');
      const title = document.createElement('div');
      const badges = text('div','', 'badges');
      badges.append(text('span',difference.layer,'badge ' + difference.layer),text('span','Step ' + difference.stepIndex,'badge'),text('span',item.decision,'badge'));
      title.append(badges,text('h2',difference.summary),text('p',difference.path,'path'));
      head.append(title); card.append(head);
      const comparison = text('div','', 'compare');
      for (const [label,value] of [['Source expected',difference.expected],['Replica actual',difference.actual]]) { const pane = text('div','', 'value'); pane.append(text('label',label),text('pre',JSON.stringify(value,null,2))); comparison.append(pane); }
      card.append(comparison);
      const form = text('div','', 'decision');
      const decisionField = field('Decision'); const decisionSelect = document.createElement('select');
      for (const [value,label] of decisions) { const option = document.createElement('option'); option.value=value; option.textContent=label; option.selected=item.decision===value; decisionSelect.append(option); } decisionField.append(decisionSelect);
      const scopeField = field('Apply to'); const scopeSelect = document.createElement('select');
      for (const [value,label] of [['exact','Only this exact difference'],['path','Future differences here']]) { const option=document.createElement('option'); option.value=value; option.textContent=label; option.selected=(item.rule?.scope || 'exact')===value; scopeSelect.append(option); } scopeField.append(scopeSelect);
      const noteField = field('Reason or context','note'); const note = document.createElement('textarea'); note.maxLength=4000; note.placeholder='Optional note for future reviewers'; note.value=item.rule?.note || ''; noteField.append(note);
      const action = document.createElement('div'); const save=text('button','Save decision','save'); const saved=text('div','', 'saved');
      save.onclick = async () => { save.disabled=true; saved.textContent='Saving…'; try { state = await api('/api/decision',{method:'POST',body:JSON.stringify({differenceId:difference.id,decision:decisionSelect.value,scope:scopeSelect.value,note:note.value,reviewer:document.getElementById('reviewer').value || 'local-reviewer'})}); render(); } catch (error) { saved.textContent=error.message; save.disabled=false; } };
      action.append(save,saved); form.append(decisionField,scopeField,noteField,action); card.append(form); return card;
    }
    function field(label,className='') { const root=text('label','', 'field ' + className); root.append(text('span',label)); return root; }
    api('/api/review').then(value => { state=value; render(); }).catch(error => { document.getElementById('differences').append(text('div',error.message,'error')); });
  </script>
</body>
</html>`;
}
