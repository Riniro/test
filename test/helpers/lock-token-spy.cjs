// Preload for the CLI process tests (NODE_OPTIONS=--require): records every lock token the process
// writes, so that a test can prove the token is absent from stdout, stderr and the journal.
// Not a test: node --test finds none here and passes it.
//
// The token is learned at the one place it is created on disk: the atomic rename of owner.json.
// Nothing about the product is changed; the call itself stays real.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const log = process.env.LOCK_SPY_LOG;
if (log) {
  const real = fs.renameSync;
  fs.renameSync = function renameSync(from, to, ...rest) {
    try {
      if (path.basename(String(to)) === 'owner.json') {
        const token = JSON.parse(fs.readFileSync(from, 'utf8')).token;
        if (typeof token === 'string' && token) fs.appendFileSync(log, token + '\n');
      }
    } catch { /* the spy never breaks the call it watches */ }
    return real.call(this, from, to, ...rest);
  };
}
