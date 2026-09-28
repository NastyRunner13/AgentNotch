// Isolated renderer smoke tests. Never starts agent watchers or loads user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-renderer-'));
app.setPath('userData', temp);
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 600, height: 560, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && !event.message.includes("'frame-ancestors' is ignored")) errors.push(event.message);
  });
  try {
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { app: ui } = await import('./app.js');
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      ui.isExpanded = true; ui.updateNotchClass(); ui.render();
      await document.fonts.ready;
      check(document.fonts.check('13px "IBM Plex Sans"'), 'New font did not load');
      const card = document.querySelector('.session-card');
      check(card, 'No mock sessions rendered');
      const id = card.dataset.sessionId;
      const session = ui.sessions.find(s => s.id === id);
      card.click();
      if (card.classList.contains('expanded')) card.click();
      check(!card.classList.contains('expanded'), 'Card did not collapse');
      session.durationFormatted = 'changed duration'; ui.renderSessions();
      check(document.querySelector('[data-session-id="'+id+'"]') === card, 'Card replaced during refresh');
      check(!card.classList.contains('expanded'), 'Closed card reopened');
      const button = card.querySelector('button');
      if (button) {
        button.focus(); session.durationFormatted = 'another duration'; ui.renderSessions();
        check(document.activeElement === button, 'Control lost focus during refresh');
        ui.sessions.push({...session, id:'new-while-focused', status:'working', taskName:'New incoming task'});
        ui.renderSessions();
        check(document.querySelector('[data-session-id="new-while-focused"]'), 'New sessions hidden while a control is focused');
        check(document.activeElement === button, 'Incoming card stole focus');
        button.blur();
      }
      ui.switchView('analytics'); await ui.loadAnalytics();
      // switchView may have already started the request.
      while (ui._analyticsLoading) await new Promise(r => setTimeout(r, 5));
      check(document.querySelector('.usage-chart'), 'Usage chart missing');
      const plot = document.querySelector('[data-usage-focus="burn"]');
      plot.focus(); plot.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));
      const selected = ui.usageChartState.burnDay;
      check(selected, 'Burn chart does not inspect with keyboard');
      ui.usageStats.updatedAt++; ui.renderAnalytics();
      check(ui.usageChartState.burnDay === selected, 'Chart selection reset');
      check(document.activeElement.dataset.usageFocus === 'burn', 'Chart focus lost on refresh');
      ui.analyticsSection = 'performance';
      const now = Date.now(), date = new Date(now);
      const day = date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
      ui.performanceStats = { enabled:true, coverageStart:now-86400000, updatedAt:now, incompleteObservations:1,
        days:[{day,agent:'Codex',workMs:3600000,waitMs:180000,attentionEpisodes:2,completedEpisodes:3}],
        episodes:[{day,agent:'Codex',workMs:1200000,complete:true}] };
      ui.renderAnalytics();
      check(document.querySelector('.performance-summary'), 'Performance summary missing');
      check(document.querySelector('.performance-summary').textContent.includes('20m'), 'Wrong episode median');
      ui.analyticsSection='insights'; ui.renderAnalytics();
      check(document.getElementById('analytics-content').textContent.includes('heuristic'), 'Insights lacks provenance');
      ui.analyticsSection='usage'; ui.renderAnalytics();
      check(!document.querySelector('.usage-data-table').textContent.includes('NaN'), 'Invalid chart values');
      document.activeElement.blur();
      document.getElementById('view-analytics').scrollTop=0;
      return { font: getComputedStyle(document.body).fontFamily, cards:ui.sessions.length, selected };
    })()`);
    assert.equal(errors.length, 0, errors.join('\n'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.getElementById('notch-panel')).opacity`), '1');
    if (process.env.AGENT_NOTCH_SCREENSHOT) {
      fs.writeFileSync(process.env.AGENT_NOTCH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      for (const section of ['performance', 'sessions']) {
        await window.webContents.executeJavaScript(`(async () => {const {app:ui}=await import('./app.js'); if ('${section}'==='sessions') ui.switchView('sessions'); else {ui.analyticsSection='${section}';ui.renderAnalytics();document.getElementById('view-analytics').scrollTop=0;}})()`);
        await new Promise(resolve => setTimeout(resolve, 300));
        fs.writeFileSync(process.env.AGENT_NOTCH_SCREENSHOT.replace(/\.png$/, `-${section}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    for (const zoom of [1, 1.25, 1.5, 2]) {
      window.webContents.setZoomFactor(zoom);
      await window.webContents.executeJavaScript(`(async () => {
        const {app:ui}=await import('./app.js'); ui.analyticsSection='usage'; ui.switchView('analytics'); ui.renderAnalytics();
        const view=document.getElementById('view-analytics');
        if (view.scrollWidth > view.clientWidth + 1) throw new Error('Horizontal overflow at zoom ${zoom}: '+view.scrollWidth+'/'+view.clientWidth+' '+JSON.stringify([...view.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>view.getBoundingClientRect().right).slice(0,8).map(e=>[e.className,e.getBoundingClientRect().right])));
        if (document.querySelector('.analytics-filters').scrollWidth > view.clientWidth) throw new Error('Filters overflow at zoom ${zoom}');
      })()`);
    }
    window.webContents.setZoomFactor(1);
    const stress = await window.webContents.executeJavaScript(`(async () => {
      const {app:ui}=await import('./app.js'); ui.switchView('sessions');
      document.activeElement.blur();
      ui.sessions=Array.from({length:20},(_,i)=>({...ui.sessions[0],id:'stress-'+i,status:'working',taskName:'Long-running task '+i,question:null,permissionRequest:null}));
      ui.renderSessions();
      const first=document.querySelector('#sessions-list .session-card');
      const started=performance.now();
      for(let tick=0;tick<20;tick++) {ui.sessions.forEach(s=>s.durationFormatted=tick+'s');ui.renderSessions();}
      if(document.querySelector('#sessions-list .session-card')!==first) throw new Error('Stress update replaced persistent card');
      return Math.round(performance.now()-started);
    })()`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#sessions-list .session-laser-beam')).animationName`), 'none');
    window.webContents.debugger.detach();
    console.log('20 updates across 20 cards:', stress, 'ms; reduced motion and 100–200% zoom passed');
    console.log('Renderer smoke checks passed:', JSON.stringify(result));
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
});
