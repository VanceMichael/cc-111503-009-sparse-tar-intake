import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Inbox {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
        namespace TEXT NOT NULL, identity TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(namespace,identity));`);
  }
  saveEvidence(kind, metadata, bytes) {
    const body = Buffer.from(bytes);
    const id = digest(Buffer.concat([Buffer.from(kind + JSON.stringify(metadata)), body]));
    this.db.prepare('INSERT OR IGNORE INTO evidence VALUES (?,?,?,?)')
      .run(id, kind, JSON.stringify(metadata), body);
    return id;
  }
  put(namespace, identity, value) {
    this.db.prepare('INSERT INTO receipts VALUES (?,?,?) ON CONFLICT(namespace,identity) DO UPDATE SET body=excluded.body')
      .run(namespace, identity, JSON.stringify(value));
  }
  list(namespace) {
    return this.db.prepare('SELECT identity,body FROM receipts WHERE namespace=? ORDER BY identity')
      .all(namespace).map(row => ({ identity: row.identity, ...JSON.parse(row.body) }));
  }
  evidence() {
    return this.db.prepare('SELECT id,kind,metadata,length(body) AS size FROM evidence ORDER BY id')
      .all().map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
  }
  close() { this.db.close(); }
}
