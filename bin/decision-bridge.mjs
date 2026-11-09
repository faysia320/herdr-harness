import { readFileSync } from 'node:fs';
import { decisionStore } from '../core/decision-store.js';
try { process.stdout.write(`${JSON.stringify(decisionStore(JSON.parse(readFileSync(0, 'utf8'))))}\n`); }
catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
