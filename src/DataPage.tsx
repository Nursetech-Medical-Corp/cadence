import {useEffect, useRef, useState} from 'react';
import {Download, HardDriveDownload, Upload} from 'lucide-react';
import type {Item, Project} from './types.ts';
import {PRIORITIES} from './types.ts';
import {api, type Store, wsId} from './store.ts';

type Snap = {name: string; bytes: number; created: string; reason: string; keptAs?: string};
type Settings = {enabled: boolean; intervalHours: number; keepRecent: number; keepDaily: number; keepWeekly: number; keepMonthly: number};

export function DataPage({store}: {store: Store}) {
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [cloud, setCloud] = useState<{configured: boolean; bucket?: string; lastOk?: string; lastFile?: string; lastError?: string} | null>(null);
  const load = () => { api<Snap[]>('/backups').then(setSnaps).catch(() => {}); api<typeof cloud>('/cloud-backup').then(setCloud).catch(() => {}); };
  useEffect(() => { load(); }, []);

  const restore = async (f: File) => {
    let dump: unknown;
    try { dump = JSON.parse(await f.text()); } catch { setMsg('That file is not valid JSON.'); return; }
    if (!confirm(`Replace everything in this workspace with "${f.name}"? A snapshot of the current data is saved first, so you can come back to it.`)) return;
    try {
      const r = await api<{restored: Record<string, number>}>('/import', {method: 'POST', body: dump});
      setMsg(`Restored: ${Object.entries(r.restored).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}.`);
      load();
    } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="page">
      <h1>Data and backups</h1>
      <p className="muted">Everything is stored in one SQLite file on this computer: <code>{wsId() === 'main' ? 'data/tasks.db' : `data/workspaces/${wsId()}/tasks.db`}</code>. Views, sprints, custom fields, comments and time entries are all part of it.</p>

      <h3>Export</h3>
      <div className="chips">
        <a className="btn primary" href="/api/export" download><Download size={14} /> Full export (JSON)</a>
        <span className="muted small">Every project, item, view and its settings, sprint, person, comment and time entry. Use it to restore, move to another machine, or feed another tool.</span>
      </div>
      <p className="muted small">CSV of a single view: open the view and use Export CSV in its toolbar. It exports exactly the rows and filters you see.</p>

      <h3>Restore</h3>
      <div className="chips">
        <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Restore from a JSON export</button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ''; }} />
      </div>
      {msg && <p className="small">{msg}</p>}

      <h3>Automatic backups</h3>
      <BackupSchedule onSaved={load} />
      <p className="muted small">Snapshots are full copies of the database in <code>{wsId() === 'main' ? 'data/backups' : `data/workspaces/${wsId()}/backups`}</code>. Manual and before-restore copies are never removed automatically. To roll back to one, stop the app and copy it over that database file.</p>
      <p className="small">{cloud?.configured
        ? <>Encrypted cloud copies: on, to <code>{cloud.bucket}</code>. {cloud.lastOk ? `Last upload ${new Date(cloud.lastOk).toLocaleString()}.` : 'No upload yet since the server started.'} {cloud.lastError && <span style={{color: 'var(--danger)'}}>Last error: {cloud.lastError}</span>}</>
        : <span className="muted">Encrypted cloud copies: off. Set the CADENCE_BACKUP_S3_* variables and CADENCE_BACKUP_PASSPHRASE on the server (see server/cloudbackup.ts) to send every snapshot, encrypted, to an S3-compatible bucket.</span>}</p>
      <button className="btn" onClick={async () => { const r = await api<{cloud: boolean}>('/backups', {method: 'POST'}); load(); setMsg(r.cloud ? 'Snapshot saved and uploaded, encrypted.' : 'Snapshot saved.'); }}><HardDriveDownload size={14} /> Back up now</button>
      <div style={{marginTop: 10}}>
        {snaps.map(s => <div key={s.name} className="row"><span className="grow">{new Date(s.created).toLocaleString()}</span><span className={'tag'}>{s.keptAs ?? 'will be pruned'}</span><span className="muted small">{(s.bytes / 1024).toFixed(0)} KB</span></div>)}
        {!snaps.length && <p className="muted small">No snapshots yet.</p>}
      </div>
      <p className="muted small" style={{marginTop: 16}}>{store.projects.length} projects, {store.items.size} items, {store.views.length} views, {store.sprints.length} sprints.</p>
    </div>
  );
}

/** Download the given rows as CSV with the common columns plus the project's custom fields. */
export function downloadCsv(name: string, project: Project, items: Item[], store: Store) {
  const person = (id: string) => store.people.find(p => p.id === id)?.name ?? id;
  const status = (id: string) => project.statuses.find(s => s.id === id)?.name ?? id;
  const sprint = (id: string | null) => store.sprints.find(s => s.id === id)?.name ?? '';
  const parent = (id: string | null) => { const p = id ? store.items.get(id) : null; return p ? `${project.key}-${p.number}` : ''; };
  const head = ['ID', 'Title', 'Type', 'Status', 'Priority', 'Assignees', 'Start', 'Due', 'Estimate (h)', 'Sprint', 'Parent', 'Tags', 'Repeats', 'Completed', ...project.fields.map(f => f.name)];
  const rows = items.map(i => [
    `${project.key}-${i.number}`, i.title, i.type, status(i.status), PRIORITIES[i.priority], i.assignees.map(person).join('; '),
    i.start ?? '', i.due ?? '', i.estimate ?? '', sprint(i.sprint), parent(i.parentId), i.tags.join('; '), i.recur ? 'yes' : '', i.completed?.slice(0, 10) ?? '',
    ...project.fields.map(f => { const v = i.fields[f.id]; return Array.isArray(v) ? v.map(person).join('; ') : v ?? ''; }),
  ]);
  // A leading = + - @ would run as a formula in Excel or Sheets; prefix with an apostrophe.
  const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], {type: 'text/csv'}));
  a.download = `${name.replace(/[^a-z0-9]+/gi, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function BackupSchedule({onSaved}: {onSaved: () => void}) {
  const [s, setS] = useState<Settings | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { api<Settings>('/backup-settings').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const save = async (patch: Partial<Settings>) => {
    const next = {...s, ...patch};
    setS(next);
    try { await api('/backup-settings', {method: 'PUT', body: next}); setNote('Saved'); onSaved(); } catch (e) { setNote(String(e instanceof Error ? e.message : e)); }
    setTimeout(() => setNote(''), 2000);
  };
  const num = (k: keyof Settings, label: string, hint: string) => (
    <label className="set-row"><span style={{width: 200}}>{label}</span>
      <input className="plain-select" type="number" min={0} style={{width: 80}} defaultValue={s[k] as number} key={String(s[k])} onBlur={e => { const v = Number(e.target.value); if (v !== s[k]) save({[k]: v} as Partial<Settings>); }} />
      <span className="muted small">{hint}</span></label>
  );
  return (
    <div className="chart-card" style={{maxWidth: 620, marginBottom: 12}}>
      <label className="set-row"><input type="checkbox" checked={s.enabled} onChange={e => save({enabled: e.target.checked})} /> Back up automatically</label>
      <label className="set-row"><span style={{width: 200}}>Every</span>
        <select className="plain-select" value={s.intervalHours} onChange={e => save({intervalHours: Number(e.target.value)})}>
          {[[1, 'hour'], [3, '3 hours'], [6, '6 hours'], [12, '12 hours'], [24, 'day'], [168, 'week']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      {num('keepRecent', 'Keep the latest', 'snapshots, whatever their age')}
      {num('keepDaily', 'Then keep one per day for', 'days')}
      {num('keepWeekly', 'Then one per week for', 'weeks')}
      {num('keepMonthly', 'Then one per month for', 'months')}
      <div className="muted small">Older copies are replaced as new ones arrive. {note}</div>
    </div>
  );
}
