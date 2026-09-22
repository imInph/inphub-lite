/**
 * inphub lite: the activity vocabulary.
 *
 * In inphub these strings sit in fifteen different PHP files, which is how the
 * History filter ends up quietly missing a category. Declared once here instead,
 * and every writer plus History and Insights import from it, so an event History
 * can't show is a compile error rather than a gap you notice months later.
 *
 * Worth remembering that the log isn't decoration: History and Insights' hours
 * chart are built from activity_log and nothing else, so a mutation that skips
 * its row leaves a hole in the charts. tx.ts makes skipping one a type error.
 */

export const ACTIVITY_TYPES = [
  'todo.created', 'todo.updated', 'todo.completed', 'todo.deleted',
  'expense.created', 'expense.updated', 'expense.deleted',
  'habit.logged', 'habit.unlogged',
  'note.created', 'note.updated', 'note.pinned', 'note.unpinned', 'note.deleted',
  'goal.created', 'goal.progress',
  'focus.completed', 'focus.stopped', 'focus.deleted',
  'repos.synced',
  'data.imported', 'data.erased',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Types inphub could write that lite never does, kept so an imported backup
 * still renders: History shows these rows, it just cannot produce new ones.
 * (auth.*, admin.* and the AI writes: ai.brief, ai.repo_analyzed, repo.suggestion,
 * goal.status, habit.created.)
 */
export const LEGACY_ACTIVITY_TYPES = [
  'auth.login', 'auth.password_changed', 'admin.user_active',
  'ai.brief', 'ai.repo_analyzed', 'repo.suggestion', 'goal.status', 'habit.created',
] as const;

export type EntityType =
  | 'todo' | 'expense' | 'habit' | 'note' | 'goal' | 'focus' | 'repo' | 'user' | 'data';

/** entity_type → the view a History row deep-links into. */
export const ENTITY_VIEWS: Partial<Record<EntityType, string>> = {
  todo: 'todos',
  expense: 'expenses',
  note: 'notes',
  habit: 'habits',
  goal: 'goals',
  repo: 'repos',
};

/** Human labels for the History type filter. */
export const TYPE_LABELS: Record<string, string> = {
  'todo.created': 'Task added',
  'todo.updated': 'Task edited',
  'todo.completed': 'Task completed',
  'todo.deleted': 'Task deleted',
  'expense.created': 'Money added',
  'expense.updated': 'Money edited',
  'expense.deleted': 'Money deleted',
  'habit.logged': 'Habit logged',
  'habit.unlogged': 'Habit cleared',
  'note.created': 'Note added',
  'note.updated': 'Note edited',
  'note.pinned': 'Note pinned',
  'note.unpinned': 'Note unpinned',
  'note.deleted': 'Note deleted',
  'goal.created': 'Goal added',
  'goal.progress': 'Goal progress',
  'focus.completed': 'Focus finished',
  'focus.stopped': 'Focus stopped',
  'focus.deleted': 'Focus deleted',
  'repos.synced': 'Repos synced',
  'data.imported': 'Data imported',
  'data.erased': 'Data erased',
};
