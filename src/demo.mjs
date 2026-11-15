import { fixture } from './samples.mjs';
import { preview } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture();
const store = new Inbox();
try {
  const result = await preview(source, store);
  console.log(JSON.stringify({ result, evidence: store.evidence() }, null, 2));
} finally { store.close(); await source.close(); }
