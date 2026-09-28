import { DatabaseSync } from 'node:sqlite';
import { datedReleaseText } from './release-format.mjs';

const apply = process.argv.includes('--apply');
const db = new DatabaseSync(`${process.env.DATA_DIR || '/data'}/nexus.sqlite`);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
try {
  const target = db
    .prepare("SELECT * FROM channels WHERE name='Releases'")
    .get();
  if (!target || target.archived || target.visibility !== 'public')
    throw Error('An active public Releases channel is required.');
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE kind='event' AND recipient IS NULL ORDER BY id",
    )
    .all();
  const groups = [];
  for (const release of db
    .prepare('SELECT * FROM deployment_announcements ORDER BY created_at')
    .all()) {
    const matches = rows.filter(
      (row) =>
        row.created_at === release.created_at &&
        /^Nexus (?:deployment announcement|release)(?: \([^)]*\))?: /.test(
          row.text,
        ) &&
        row.text.endsWith(`Release ${release.release}.`),
    );
    if (!matches.length) continue;
    const normalized = matches.map((row) =>
      datedReleaseText(row.text, row.created_at),
    );
    if (new Set(normalized).size !== 1)
      throw Error(
        `Conflicting announcement copies for ${release.release}; review manually.`,
      );
    const keep =
      matches.find((row) => row.channel === 'Releases') || matches[0];
    const duplicates = matches.filter((row) => row.id !== keep.id);
    if (
      keep.channel !== 'Releases' ||
      keep.text !== normalized[0] ||
      duplicates.length
    )
      groups.push({
        release: release.release,
        keep,
        duplicates,
        text: normalized[0],
      });
  }
  if (apply && groups.length) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS release_history_backup(message_id INTEGER PRIMARY KEY, release TEXT NOT NULL, original_row TEXT NOT NULL, saved_at INTEGER NOT NULL)',
    );
    for (const group of groups) {
      for (const row of [group.keep, ...group.duplicates])
        db.prepare(
          'INSERT OR IGNORE INTO release_history_backup VALUES(?,?,?,?)',
        ).run(row.id, group.release, JSON.stringify(row), Date.now());
      db.prepare(
        "UPDATE messages SET channel='Releases',text=? WHERE id=?",
      ).run(group.text, group.keep.id);
      for (const row of group.duplicates)
        db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
    }
  }
  console.log(
    JSON.stringify({
      applied: apply,
      releases: groups.length,
      moved: groups.filter((g) => g.keep.channel !== 'Releases').length,
      duplicatesConsolidated: groups.reduce(
        (n, g) => n + g.duplicates.length,
        0,
      ),
    }),
  );
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
