'use strict';

const { createDisposablePreview } = require('../lib/pandit-upload-preview');

if (process.env.NODE_ENV === 'production') throw new Error('Disposable preview launcher refuses NODE_ENV=production.');
const port = Number(process.env.PORT || 3218);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const preview = createDisposablePreview({ ttlMs: 2 * 60 * 60 * 1000 });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await preview.cleanup(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
preview.start(port, '0.0.0.0').then(address => {
  console.log(`Disposable Pandit preview listening on http://0.0.0.0:${address.port}`);
  console.log(`Synthetic login: ${preview.account.email} / ${preview.account.password}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
