import { all } from '../lib/db.js';
import { listSources } from '../connectors/index.js';

/** Each source, and how its latest read went. */
async function sourceHealth(db) {
  const sources = await listSources(db);
  // Each source by its own latest read: a run that read one source (Check
  // laundry now) says nothing about the others.
  const last = await all(db, `
    SELECT r.source_id, r.status, r.detail FROM etl_source_run r
     WHERE r.run_id = (SELECT MAX(o.run_id) FROM etl_source_run o WHERE o.source_id = r.source_id)`);
  const byId = new Map(last.map((r) => [r.source_id, r]));
  return sources.map((s) => ({
    id: s.id,
    label: s.label,
    status: byId.get(s.id)?.status || 'never run',
    detail: byId.get(s.id)?.detail || null,
  }));
}

export { sourceHealth };
