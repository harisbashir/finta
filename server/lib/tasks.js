// Completing a task. Shared by the Tasks API and Alexa sync.
import { nextTaskDate } from './dates.js';

/** Repeating tasks roll forward instead of disappearing; others are marked done. */
export function completeTask(db, task, todayStr) {
  if (task.repeat !== 'none') {
    const next = nextTaskDate(task.repeat, task.due_date, todayStr);
    db.prepare(`UPDATE tasks SET due_date = ?, last_done_at = datetime('now') WHERE id = ?`).run(next, task.id);
    return { ...db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), rolled: true, previous_due: task.due_date };
  }
  db.prepare(`UPDATE tasks SET done_at = datetime('now'), last_done_at = datetime('now') WHERE id = ?`).run(task.id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
}
