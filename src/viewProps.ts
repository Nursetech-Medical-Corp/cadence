import type {Item, Project, Sprint, ViewConfig} from './types.ts';
import type {Store} from './store.ts';

/** What every project view receives. `items` is filtered by the view config, `allItems` is not. */
export type ViewProps = {
  store: Store; project: Project; items: Item[]; allItems: Item[]; sprints: Sprint[];
  open: (id: string) => void; config: ViewConfig; setConfig: (patch: Partial<ViewConfig>) => void;
  /** Multi-select for bulk edit. `toggle` handles Ctrl (add/remove) and Shift (range over `order`). */
  selected: Set<string>; toggle: (id: string, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}, order: string[]) => void; setSelected: (s: Set<string>) => void;
};

/** List row fields that can be dragged into a new order. Time and due date keep their place. */
export const ROW_FIELDS = ['priority', 'assignees', 'status'] as const;
export type RowField = typeof ROW_FIELDS[number];
/** The saved order for a view: unknown ids dropped, missing ones added at the end. */
export const rowFieldsOf = (c: ViewConfig): RowField[] => [...new Set([...(c.rowFields ?? []).filter((f): f is RowField => (ROW_FIELDS as readonly string[]).includes(f)), ...ROW_FIELDS])];
