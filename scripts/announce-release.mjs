import { DatabaseSync } from 'node:sqlite';
const [release, summary] = process.argv.slice(2);
if (!/^[a-f0-9]{7,40}$/.test(release || '') || !summary || summary.length > 1500) throw Error('Usage: announce-release.mjs <commit> <summary>');
const db = new DatabaseSync(`${process.env.DATA_DIR || '/data'}/nexus.sqlite`);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
try {
  db.exec('CREATE TABLE IF NOT EXISTS deployment_announcements(release TEXT PRIMARY KEY, created_at INTEGER NOT NULL, channels INTEGER NOT NULL)');
  const prior = db.prepare('SELECT * FROM deployment_announcements WHERE release=?').get(release);
  if (prior) console.log(JSON.stringify({alreadyAnnounced:true,...prior}));
  else {
    const admin = db.prepare('SELECT id FROM users WHERE is_admin=1 AND disabled=0 ORDER BY id LIMIT 1').get();
    if (!admin) throw Error('No active administrator for announcement attribution');
    const channels = db.prepare('SELECT name FROM channels WHERE archived=0').all();
    const now = Date.now();
    const text = `Nexus deployment announcement: ${summary} Refresh your browser or reopen Nexus to load the update. Release ${release}.`;
    for (const channel of channels) db.prepare("INSERT INTO messages(user_id,channel,text,created_at,kind) VALUES(?,?,?,?,'event')").run(admin.id,channel.name,text,now);
    db.prepare('INSERT INTO deployment_announcements VALUES(?,?,?)').run(release,now,channels.length);
    console.log(JSON.stringify({release,channels:channels.map(c=>c.name)}));
  }
  db.exec('COMMIT');
} catch(error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
