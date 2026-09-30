const { parentPort, workerData } = require('node:worker_threads');
const { scanUsageHistory } = require('./usage-backfill');

parentPort.postMessage(scanUsageHistory(workerData));
