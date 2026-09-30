// Isolated responsiveness check with synthetic data; never reads agent history.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { scanUsageHistoryAsync } = require('../src/main/usage/usage-backfill');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-performance-'));
app.setPath('userData', path.join(temp, 'electron'));
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 600, height: 560,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  let timer;
  try {
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    const renderer = await window.webContents.executeJavaScript(`(async () => {
      const {app:ui} = await import('./app.js');
      await document.fonts.ready;
      const results = [];
      const originals = ui.sessions;
      for (const count of [5, 25]) {
        ui.sessions = Array.from({length:count}, (_,i) => ({...originals[i % originals.length], id:'perf-'+i}));
        ui.isExpanded = true; ui.updateNotchClass(); ui.render();
        const times = [];
        for (let i=0; i<20; i++) {
          ui.sessions[0] = {...ui.sessions[0], lastMessage:'Progress '+i};
          const start=performance.now(); ui.render();
          document.getElementById('app').getBoundingClientRect();
          times.push(performance.now()-start);
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        times.sort((a,b)=>a-b);
        results.push({sessions:count, medianUpdateMs:times[10], maxUpdateMs:times.at(-1)});
      }
      return results;
    })()`);
    console.log('Renderer updates:', JSON.stringify(renderer));

    const fixture = path.join(temp, 'session.jsonl');
    fs.writeFileSync(fixture, (JSON.stringify({type:'progress', padding:'x'.repeat(1000)})+'\n').repeat(20000));
    let callbacks = 0, maxGap = 0, last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; callbacks++;
    }, 5);
    const result = await scanUsageHistoryAsync({ codexSessionsDir:temp,
      claudeProjectsDir:path.join(temp,'missing'), antigravityBrainDir:path.join(temp,'missing'),
      grokLogPath:path.join(temp,'missing'), opencodeDbPaths:[] });
    clearInterval(timer);
    assert.equal(result.files, 1);
    assert.ok(callbacks > 0, 'History scan blocked main-thread callbacks');
    console.log('Electron history worker:', JSON.stringify({callbacks, maxCallbackGapMs:Math.round(maxGap)}));
    fs.unlinkSync(fixture);
    window.destroy();
    app.exit(0);
  } catch (error) {
    clearInterval(timer);
    console.error(error.stack || error);
    app.exit(1);
  }
});
