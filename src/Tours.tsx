// Help center with short guides and step-by-step tours. A tour opens the right screen, spotlights the
// real control, and explains it; Next moves on. Works on the live app, so what you learn is what you use.
import {useEffect, useLayoutEffect, useState} from 'react';
import {GraduationCap, Play, X, Zap, CircleCheck, FolderKanban, Users, GanttChart, Timer, Repeat, LayoutTemplate, Bot, CalendarDays, Keyboard} from 'lucide-react';
import {realProjects, type Store} from './store.ts';
import type {ViewKind} from './types.ts';

const VIEW_LABELS: Record<string, string> = {gantt: 'Timeline', backlog: 'Backlog', sprint: 'Sprint', calendar: 'Calendar', workload: 'Workload'};

/** need: a view kind the step shows; when no project has one, the tour offers to add it. */
type Step = {go?: string; sel?: string; title: string; text: string; need?: string};
type Tour = {id: string; title: string; minutes: number; summary: string; steps: (s: Store) => Step[]};

// The first real project (not a rollup) that has a view of this kind, else the first real project.
const projectFor = (s: Pick<Store, 'projects' | 'views'>, kind: string) => {
  const real = realProjects(s.projects);
  return real.find(p => s.views.some(v => v.projectId === p.id && v.kind === kind)) ?? real[0];
};
const firstView = (s: Store, kind: string) => {
  const p = projectFor(s, kind);
  const v = s.views.find(x => x.projectId === p?.id && x.kind === kind);
  return p ? `/p/${p.id}/${v?.id ?? ''}` : '/mywork';
};

export const TOURS: Tour[] = [
  {id: 'add', title: 'Add tasks fast', minutes: 1, summary: 'Quick add, nesting, and the shortcuts that set dates and people as you type.', steps: s => [
    {go: firstView(s, 'list'), sel: '.add-row', title: 'Add a task', text: 'Click here and type a title. Enter saves it and opens the next line, so you can keep typing a whole list.'},
    {sel: '.add-row', title: 'Fill details while typing', text: 'Add @name to assign, !high for priority, due:fri for a date, #tag, ~2h for an estimate, every:w to repeat. Example: Call vendor @sam !high due:fri'},
    {sel: '.list', title: 'Nest and reorder', text: 'Tab nests a line under the one above, Shift+Tab moves it back out. Drag rows to reorder.'},
    {title: 'Capture from anywhere', text: 'Press C on any page to open Quick capture: add tasks to any space, one per line, typed or dictated.'},
  ]},
  {id: 'done', title: 'Complete tasks and find them later', minutes: 1, summary: 'Checking off, where finished work goes, and how to undo.', steps: s => [
    {go: firstView(s, 'list'), sel: '.list .row .check', title: 'Check it off', text: 'Click the circle to mark a task done. It stays in place, struck through, so nothing vanishes.'},
    {sel: '.toolbar', title: 'Hide or show finished work', text: 'Use Showing done in the toolbar to hide finished items in this view. The setting is saved with the view.'},
    {go: '/mywork', sel: '.free-grid', title: 'Your day', text: 'My work shows what is due, overdue and finished today. Add widgets and drag them where you want.'},
    {go: '/history', sel: '.history', title: 'Undo anything', text: 'Ctrl+Z undoes your last change. History keeps every change by everyone; press Revert on any line.'},
  ]},
  {id: 'projects', title: 'Spaces, views and settings', minutes: 2, summary: 'Create a space, add views like Board or Timeline, and make the names your own.', steps: s => [
    {go: '/mywork', sel: '.nav-section', title: 'New space', text: 'Press + next to Spaces. Pick level names (General, Quality and regulatory, Operations...) or start from a template.'},
    {go: firstView(s, 'list'), sel: '.tabs', title: 'Views', text: 'Each tab is a saved view of the same work: List, Table, Board, Timeline, Calendar, Workload, Backlog, Sprint. Each keeps its own filters, sort and columns.'},
    {sel: '.tabs .tab:last-child', title: 'Settings', text: 'Rename statuses, levels (Project, Phase, Task, Subtask), add custom fields, automations, access and integrations.'},
    {sel: '.toolbar', title: 'Filter, sort, export', text: 'Filter with AND/OR rules, sort by several fields, export what you see as CSV.'},
  ]},
  {id: 'people', title: 'Assign work and keep track of people', minutes: 1, summary: 'Assignees, workload, and the manager view.', steps: s => [
    {go: firstView(s, 'table'), sel: '.grid', title: 'Assign', text: 'Click the Assignee cell (or the avatar in any view) to pick people. Several people can share a task.'},
    {go: firstView(s, 'workload'), need: 'workload', sel: '.content', title: 'Workload', text: 'Hours per person per day against capacity. Red means overloaded; drag a task to another person to rebalance. Add a Workload view with + View if this project has none.'},
    {go: '/insights', sel: '.ins-table', title: 'Team insights', text: 'Finished work, on-time rate, time logged, estimate vs actual, and flagged work that is overdue, over budget or stalled.'},
  ]},
  {id: 'gantt', title: 'Timeline (Gantt)', minutes: 2, summary: 'Schedule by dragging, link dependencies, and read the chart.', steps: s => [
    {go: firstView(s, 'gantt'), need: 'gantt', sel: '.g-right', title: 'Move and resize', text: 'Drag a bar to move it, drag its ends to change start or due. Drag empty space to scroll. Drag across an empty row to schedule an undated task.'},
    {sel: '.g-legend', title: 'Read the shapes', text: 'Bars are scheduled work, bracketed bars are parents spanning their children (drag one to shift everything under it), diamonds have only a due date.'},
    {sel: '.g-right', title: 'Link dependencies', text: 'Hover a bar and drag the dot on its right end onto another bar: that one now waits for the first. Click an arrow to remove it.'},
    {sel: '.toolbar', title: 'Color and zoom', text: 'Color bars by type, person, status or priority. Zoom by day, week or month.'},
  ]},
  {id: 'sprints', title: 'Sprints', minutes: 2, summary: 'Plan two-week blocks, see burndown, roll over what is left.', steps: s => [
    {go: firstView(s, 'backlog'), need: 'backlog', sel: '.split .right', title: 'Plan', text: 'Drag items from the backlog onto a sprint card. Children come along. Capacity bars show who is overloaded.'},
    {sel: '.split .left', title: 'Faster ways', text: 'Type sprint:now in quick add, set Sprint on any item, or select rows and press S (current) or Shift+S (next).'},
    {go: firstView(s, 'sprint'), need: 'sprint', sel: '.sprint-tabs, .empty', title: 'Track it', text: 'Open Burndown and capacity: burndown (or burnup) with a projection says if you are on pace or how late you will finish. No sprint yet? Press New sprint first.'},
    {sel: '.sprint-head, .empty', title: 'When things slip', text: 'Roll over unfinished moves open work to the next sprint. Or turn on automatic rollover in Settings, Automations.'},
  ]},
  {id: 'routines', title: 'Repeating work and routines', minutes: 1, summary: 'Taxes, filings, reviews, reorders: set them once.', steps: () => [
    {go: '/templates', sel: '.gallery', title: 'Start from the gallery', text: 'Add "Business and compliance routines" for FDA registration, payroll and sales tax filings, SOP reviews, HR audits, insurance, budget updates, reorders and follow-ups.'},
    {go: '/routines', sel: '.routine-stats', title: 'All routines in one place', text: 'Each routine has one live copy. Finish it and the next appears on its date, so nothing piles up. The boxes show how many hours a week your routines take, split by auto job, hybrid and manual.'},
    {go: '/routines', sel: '.routine-group', title: 'Grouped by SOP', text: 'Routines tagged with an SOP code (like SOP-07.2) sit together. The switch by the SOP name pauses or resumes all of them at once. Tag a routine auto-job, hybrid or manual to show who does the work.'},
    {go: '/routines', sel: '.routine-row', title: 'On, off, skip, end', text: 'Switch off: the routine leaves views, sprints and plans and keeps its history; switch on and it comes back on its next date. Skip moves this copy to the next date. End stops repeating and keeps this copy as a normal task.'},
    {go: '/routines', sel: '.page', title: 'See what is coming', text: 'Timeline and Calendar show faded copies on future dates. They are previews, not tasks; only the live copy can be worked. Open any routine to change its rule: weekdays, nth weekday, skip weekends, after completion, end dates.'},
  ]},
  {id: 'templates', title: 'Templates and packs', minutes: 1, summary: 'Reuse checklists and share whole systems.', steps: () => [
    {go: '/templates', sel: '.gallery', title: 'Gallery', text: 'Ready-made packs: vendor onboarding, new hires, AI agency work, compliance routines. Steps are marked human or AI.'},
    {go: '/templates', sel: '.toolbar', title: 'Share a whole system', text: 'Tick templates and Export: you get a pack file another organization can Import. People are removed on export.'},
    {go: '/templates', sel: '.page', title: 'Make your own', text: 'Open any item with subitems and press the template icon in its panel. Use it later from + New in any view.'},
  ]},
  {id: 'ai', title: 'Working with AI agents', minutes: 2, summary: 'Give AI tasks, review its work, keep a full log.', steps: () => [
    {go: '/team', sel: '.agents-card', title: 'You or an agent?', text: 'Your Cadence connector in Claude already acts as you. Add an agent under My AI agents only when an AI should work on its own, under its own name, with its changes held for your approval.'},
    {go: '/team', sel: '.agents-card', title: 'Add and connect it', text: 'Name it, pick the AI app, press Add agent, then Get connection key. The key is the agent\'s login. The steps for Claude, ChatGPT and Muse each have their own tour on the Learn page.'},
    {go: '/ai', sel: '.board', title: 'The AI work board', text: 'Tasks marked for AI flow left to right: ready, claims to approve, working, ready for review, approved.'},
    {go: '/ai', sel: '.board', title: 'Review', text: 'Read the report, open links and screenshots, then Approve or Send back with a comment. Everything the agent did is in the item\'s work log.'},
  ]},
  {id: 'claude', title: 'Connect Claude as an agent', minutes: 3, summary: 'Paste the key into Claude, schedule its runs, approve its work.', steps: () => [
    {go: '/team', sel: '.agents-card', title: 'Do you need this?', text: 'No, if you only want Claude to help while you chat: your Cadence connector already does that as you. Yes, if Claude should check for work on a schedule and act under its own name, with its changes waiting for you.'},
    {sel: '.agents-card', title: 'Make the agent', text: 'Type a name like David\'s Claude, pick Claude, press Add agent. Leave Changes it makes on Wait for my approval to start.'},
    {sel: '.agents-card', title: 'Get the key', text: 'Press Get connection key. You get an address with the key built in. It is shown once; anyone with it acts as this agent.'},
    {title: 'Add it to Claude', text: 'In Claude: Settings (or Customize), Connectors, +, Add custom connector. Name it Cadence agent, paste the address, leave OAuth empty, Add. Free plans allow one custom connector; on Team and Enterprise an Owner adds it first, then you press Connect.'},
    {title: 'Schedule the runs', text: 'Make a scheduled task in Claude with the prompt shown under the key, on the cadence you set (Checks for work). Turn on only the Cadence agent connector for that task, so it acts as the agent and not as you.'},
    {go: '/ai', sel: '.board, .page', title: 'Approve what it does', text: 'Its claims, finished work and held changes land here and in your notifications. Approve, edit or reject. To let it skip approval for a routine job, list that SOP code under Approved AI SOPs.'},
  ]},
  {id: 'chatgpt', title: 'Connect ChatGPT as an agent', minutes: 3, summary: 'Developer mode, a custom app with the key, and a scheduled task.', steps: () => [
    {go: '/team', sel: '.agents-card', title: 'Make the agent', text: 'Under My AI agents: name it (like David\'s ChatGPT), pick ChatGPT, Add agent, then Get connection key. The key is its login; keep it private.'},
    {title: 'Check your plan', text: 'Custom apps need Developer mode, on ChatGPT web for paid plans. OpenAI lists full read and write support for Business, Enterprise and Edu; on Plus or Pro, writes may be limited. On a workspace plan an admin turns Developer mode on.'},
    {title: 'Turn on Developer mode', text: 'ChatGPT: Settings, Apps, Advanced settings, Developer mode on.'},
    {title: 'Create the app', text: 'Create app. Name: Cadence. MCP server URL: the address from Cadence. Authentication: none, because the key is in the address. ChatGPT lists Cadence\'s tools when it connects.'},
    {title: 'Writes need your OK', text: 'ChatGPT asks you to confirm each change before it runs. Cadence also holds the agent\'s changes for your approval, so nothing changes without you.'},
    {title: 'Schedule the runs', text: 'Open Scheduled in the ChatGPT sidebar and add a task with the prompt shown under the key. Scheduled tasks can use connected apps when they are available on your account.'},
  ]},
  {id: 'meta', title: 'Connect Muse (Meta AI) as an agent', minutes: 3, summary: 'Ask Muse to build a custom connector; the key goes in its credential store.', steps: () => [
    {go: '/team', sel: '.agents-card', title: 'Make the agent', text: 'Under My AI agents: name it, pick Muse (Meta AI), Add agent, Get connection key.'},
    {title: 'No address box in Muse', text: 'Muse (Meta\'s AI app) has no setting to paste a connector address. Instead you ask Muse to build a custom connector, and it writes and tests the connection itself.'},
    {title: 'Ask Muse to build it', text: 'Copy the message shown under the key and send it to Muse. It names the Cadence address and says the key goes in an Authorization header.'},
    {title: 'Key goes in the safe place', text: 'When Muse opens its secure credential prompt, paste the key there, never in the chat. Muse keeps it in its Secure Credentials Store.'},
    {title: 'Know the trade-off', text: 'Meta does not review custom connectors. Keep Changes it makes on Wait for my approval so every change comes to you first.'},
    {title: 'Schedule the runs', text: 'Ask Muse to run the prompt shown under the key on a schedule (for example every weekday at 8:00). Results come back as messages in your Muse chat; approvals show up in Cadence.'},
  ]},
  {id: 'calendar', title: 'Calendar, email and notifications', minutes: 2, summary: 'See tasks in Google Calendar and get reminders.', steps: s => [
    {go: firstView(s, 'calendar'), need: 'calendar', sel: '.cal-grid', title: 'Calendar view', text: 'Tasks by due date (or spanning start to due). Drag to reschedule, press + on a day to add.'},
    {go: realProjects(s.projects)[0] ? `/p/${realProjects(s.projects)[0].id}/settings` : '/mywork', sel: '.int-block', title: 'Put tasks in your calendar', text: 'Copy a calendar link (project, or one person\'s work). In Google Calendar: Other calendars, +, From URL, paste. Outlook and Apple: subscribe to calendar by URL.'},
    {sel: '.int-block', title: 'Reminders on your phone', text: 'After subscribing, open that calendar\'s settings in Google Calendar and add default notifications for all-day events (for example the day before at 9 am). Google needs the app on a public address to read the link; until then download the .ics file and import it.'},
    {go: '/team', sel: '.google-card, .team-row', title: 'Email notifications', text: 'An admin connects a Gmail sender on the Team page; then each person ticks Email to get assignments, mentions and reviews by email.'},
  ]},
  {id: 'keys', title: 'Keyboard shortcuts', minutes: 1, summary: 'Move through work without the mouse.', steps: () => [
    {go: '/mywork', sel: '.side-bottom', title: 'See and change them', text: 'Press ? for every shortcut; click one to rebind it. j and k move between rows, x selects, o opens, d marks done, i assigns to you, g then m goes to My work, 1 to 9 switch view tabs.'},
  ]},
];

// A colored icon for each tour on the Learn page.
const TOUR_ICONS: Record<string, [typeof Play, string]> = {
  add: [Zap, '#f59e0b'], done: [CircleCheck, '#10b981'], projects: [FolderKanban, '#6d5dfc'], people: [Users, '#0ea5e9'],
  gantt: [GanttChart, '#ec4899'], sprints: [Timer, '#ef4444'], routines: [Repeat, '#14b8a6'], templates: [LayoutTemplate, '#8b5cf6'],
  ai: [Bot, '#0f172a'], claude: [Bot, '#d97757'], chatgpt: [Bot, '#10a37f'], meta: [Bot, '#0866ff'], calendar: [CalendarDays, '#f97316'], keys: [Keyboard, '#64748b'],
};
export function HelpPage({start}: {start: (id: string) => void}) {
  return (
    <div className="page" style={{maxWidth: 1000}}>
      <h1><GraduationCap size={20} /> Learn the basics</h1>
      <p className="muted">Short guided tours. Each one opens the right screen and points at the real buttons. Press Esc any time to stop.</p>
      <p className="small">Training someone new? On Templates, add <b>Learn Cadence: training checklist</b> from the Gallery, then Use it and assign it to them. It lists every tour and feature as steps with dates.</p>
      <div className="gallery">
        {TOURS.map(t => (
          <div key={t.id} className="chart-card gal-card learn-card">
            {(() => { const [Icon, color] = TOUR_ICONS[t.id] ?? [Play, '#6d5dfc']; return <span className="learn-icon" style={{background: color}}><Icon size={20} /></span>; })()}
            <b>{t.title}</b>
            <div className="muted small">{t.summary}</div>
            <div className="muted small">{t.minutes} min</div>
            <button className="btn primary small" onClick={() => start(t.id)}><Play size={12} /> Start tour</button>
          </div>
        ))}
      </div>
      <h3>Quick answers</h3>
      <div className="faq">
        <details><summary>Where do finished tasks go?</summary><p>They stay where they are, checked and struck through. Hide them per view with Showing done. My work lists what you finished today, and History has every change.</p></details>
        <details><summary>How do I rename Epic, Feature, Task?</summary><p>Project Settings, Item types: rename, add, reorder or remove levels. New projects let you pick a naming preset.</p></details>
        <details><summary>How do I get tasks into Google Calendar?</summary><p>Project Settings, Integrations, Calendar feed: copy the link and add it in Google Calendar under Other calendars, From URL. For reminders, set default notifications on that calendar in Google Calendar's settings.</p></details>
        <details><summary>Do I need an agent if Claude already has the Cadence connector?</summary><p>No. That connector acts as you. An agent is a separate login for an AI that works on its own, on a schedule, with its changes held for your approval. Add one under Team, My AI agents.</p></details>
        <details><summary>How do AI agents connect?</summary><p>Team page, My AI agents: add the agent, press Get connection key, and follow the tour for Claude, ChatGPT or Muse. The key is the agent's login. The AI app connects to /mcp with that key and should read the guide first (get_guide). The guide is also at /api/guide.</p></details>
        <details><summary>How do I back up or move everything?</summary><p>Data and backups: automatic snapshots on a schedule you choose, full JSON export and restore. Template packs move workflows between organizations.</p></details>
      </div>
    </div>
  );
}

/** Spotlight overlay that walks through a tour. */
export function TourRunner({tour, store, close}: {tour: Tour; store: Store; close: () => void}) {
  const steps = tour.steps(store);
  const [n, setN] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[n];
  useEffect(() => { if (step.go && location.hash !== '#' + step.go) location.hash = step.go; }, [n]);
  useLayoutEffect(() => {
    setRect(null);
    let tries = 0, alive = true;
    const find = () => {
      if (!alive) return;
      const el = step.sel ? document.querySelector(step.sel) : null;
      // Wait for content that loads a moment later (an empty box has no height yet).
      if (el && el.getBoundingClientRect().height > 0) { el.scrollIntoView({block: 'nearest', inline: 'nearest'}); setTimeout(() => alive && setRect(el.getBoundingClientRect()), 120); }
      else if (tries++ < 20) setTimeout(find, 100);
    };
    find();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') setN(x => Math.max(0, x - 1)); };
    addEventListener('keydown', k);
    const r = () => { const el = step.sel ? document.querySelector(step.sel) : null; if (el) setRect(el.getBoundingClientRect()); };
    addEventListener('resize', r);
    return () => { alive = false; removeEventListener('keydown', k); removeEventListener('resize', r); };
  }, [n]);
  const next = () => n < steps.length - 1 ? setN(n + 1) : close();
  const real = realProjects(store.projects);
  const missing = step.need && !real.some(p => store.views.some(v => v.projectId === p.id && v.kind === step.need)) ? real[0] : undefined;
  const addView = async () => {
    const label = VIEW_LABELS[step.need!] ?? step.need!;
    const v = missing && await store.createView(missing.id, label, step.need as ViewKind);
    if (v) location.hash = `/p/${missing!.id}/${v.id}`;
  };
  const pad = 6;
  // Spotlight only the visible part of the element, never more than ~60% of the screen height.
  const box = rect ? (() => {
    const l = Math.max(8, rect.left - pad), t = Math.max(8, rect.top - pad);
    const r = Math.min(innerWidth - 8, rect.right + pad), b = Math.min(innerHeight - 8, rect.bottom + pad, t + innerHeight * 0.6);
    return {left: l, top: t, width: Math.max(40, r - l), height: Math.max(30, b - t)};
  })() : null;
  // Card goes below the spotlight if there is room, else above, else centered.
  const cardTop = box ? (box.top + box.height + 190 < innerHeight ? box.top + box.height + 12 : Math.max(12, box.top - 200)) : innerHeight / 2 - 90;
  const cardLeft = box ? Math.min(Math.max(12, box.left), innerWidth - 352) : innerWidth / 2 - 170;
  return (
    <div className="tour">
      {box ? <div className="tour-hole" style={box} /> : <div className="tour-dim" />}
      <div className="tour-card" style={{top: cardTop, left: cardLeft}}>
        <div className="tour-top"><span className="muted small">{tour.title}, {n + 1} of {steps.length}</span><span className="spacer" /><button className="icon" onClick={close} title="End tour (Esc)"><X size={14} /></button></div>
        <b>{step.title}</b>
        <p>{step.text}</p>
        {missing && <p className="small">No space has a {VIEW_LABELS[step.need!] ?? step.need} view yet. <button className="btn small" onClick={addView}>Add one to {missing.name}</button></p>}
        <div className="tour-dots">{steps.map((_, k) => <span key={k} className={k === n ? 'on' : ''} />)}</div>
        <div className="tour-actions">
          {n > 0 && <button className="btn small" onClick={() => setN(n - 1)}>Back</button>}
          <span className="spacer" />
          <button className="btn primary small" onClick={next}>{n < steps.length - 1 ? 'Next' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}
