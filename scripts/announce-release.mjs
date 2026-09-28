import { DatabaseSync } from 'node:sqlite';
import { releaseTimestamp } from './release-format.mjs';

const [release, summary, flag] = process.argv.slice(2);
const prepare = release === '--prepare-channel';
if (!prepare && flag !== '--significant') {
  console.log(
    JSON.stringify({ skipped: true, reason: 'Routine deployments are quiet.' }),
  );
  process.exit(0);
}
if (
  !prepare &&
  (!/^[a-f0-9]{7,40}$/.test(release || '') ||
    !summary?.trim() ||
    summary.length > 1500)
)
  throw Error(
    'Usage: announce-release.mjs <commit> <summary> --significant | --prepare-channel',
  );
const db = new DatabaseSync(`${process.env.DATA_DIR || '/data'}/nexus.sqlite`);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
try {
  db.exec(
    'CREATE TABLE IF NOT EXISTS deployment_announcements(release TEXT PRIMARY KEY, created_at INTEGER NOT NULL, channels INTEGER NOT NULL)',
  );
  const prior = prepare
    ? undefined
    : db
        .prepare('SELECT * FROM deployment_announcements WHERE release=?')
        .get(release);
  if (prior) console.log(JSON.stringify({ alreadyAnnounced: true, ...prior }));
  else {
    const admin = db
      .prepare(
        'SELECT id FROM users WHERE is_admin=1 AND disabled=0 ORDER BY id LIMIT 1',
      )
      .get();
    if (!admin) throw Error('No active administrator for release attribution');
    const existing = db
      .prepare('SELECT name,archived,visibility FROM channels WHERE name=?')
      .get('Releases');
    if (existing && (existing.archived || existing.visibility !== 'public'))
      throw Error(
        'Releases is archived or non-public; resolve its configuration explicitly.',
      );
    if (!existing) {
      if (
        db
          .prepare('SELECT 1 FROM deleted_channels WHERE name=?')
          .get('Releases')
      )
        throw Error(
          'Releases was deleted; restore it explicitly before announcing.',
        );
      db.prepare(
        "INSERT INTO channels(name,owner_id,visibility,description) VALUES(?,?,'public',?)",
      ).run(
        'Releases',
        admin.id,
        'Major updates and significant Nexus features. Routine fixes stay quiet.',
      );
      db.prepare(
        "INSERT INTO channel_members(channel,user_id,role) VALUES(?,?,'owner')",
      ).run('Releases', admin.id);
    }
    if (prepare)
      console.log(JSON.stringify({ prepared: true, channel: 'Releases' }));
    else {
      const now = Date.now();
      const text = `Nexus release (${releaseTimestamp(now)}): ${summary.trim()} Refresh your browser or reopen Nexus to load the update. Release ${release}.`;
      db.prepare(
        "INSERT INTO messages(user_id,channel,text,created_at,kind) VALUES(?,?,?,?,'event')",
      ).run(admin.id, 'Releases', text, now);
      db.prepare('INSERT INTO deployment_announcements VALUES(?,?,?)').run(
        release,
        now,
        1,
      );
      console.log(JSON.stringify({ release, channels: ['Releases'] }));
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
