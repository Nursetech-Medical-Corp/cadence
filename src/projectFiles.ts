// Attachments for a whole project, fetched once and shared by every cell and card that shows them.
import {useEffect, useState} from 'react';
import {api} from './store.ts';
import type {ProjectFile} from './FilesView.tsx';

const cache = new Map<string, {tick: number; p: Promise<Map<string, ProjectFile[]>>}>();
export function useItemFiles(projectId: string, tick: number) {
  const [map, setMap] = useState<Map<string, ProjectFile[]>>(new Map());
  useEffect(() => {
    let c = cache.get(projectId);
    if (!c || c.tick !== tick) {
      c = {tick, p: api<ProjectFile[]>(`/projects/${projectId}/files`).then(l => { const m = new Map<string, ProjectFile[]>(); for (const f of l) m.set(f.itemId, [...(m.get(f.itemId) ?? []), f]); return m; }).catch(() => new Map())};
      cache.set(projectId, c);
    }
    let live = true;
    c.p.then(m => live && setMap(m));
    return () => { live = false; };
  }, [projectId, tick]);
  return map;
}
