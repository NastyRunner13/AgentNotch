// Isolated native resize + renderer regression check. No watchers or user data.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { springOmega, stepSpringAxis, isSpringSettled } = require('../src/main/lib/notch-motion');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-motion-')));
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 600, height: 560, frame: false, transparent: true, resizable: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const failures = new Set();
  try {
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const {app:ui} = await import('./app.js');
      await document.fonts.ready;
      ui.isExpanded = true; ui.updateNotchClass(); ui.render();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const sample = async label => {
      const state = await window.webContents.executeJavaScript(`(() => {
        const shell = document.getElementById('app');
        const bar = document.getElementById('notch-bar');
        const right = bar.querySelector('.notch-bar-right').getBoundingClientRect();
        const clippedCounts = [...bar.querySelectorAll('.stat-num')].filter(el => {
          if (!el.getClientRects().length) return false;
          const count = el.getBoundingClientRect(), pill = el.parentElement.getBoundingClientRect();
          return count.left < pill.left || count.right > pill.right;
        }).length;
        return {viewport:innerHeight, shell:shell.getBoundingClientRect().height,
          clippedCounts,
          width:innerWidth, right:right.right, panelInert:document.getElementById('notch-panel').inert,
          working:shell.classList.contains('laser-active'),
          labelDisplay:getComputedStyle(document.querySelector('#stat-running .stat-label')).display,
          usageHeight:document.getElementById('usage-bar').getBoundingClientRect().height};
      })()`);
      if (Math.abs(state.shell - state.viewport) > 1) failures.add(`${label}: shell snapped to ${state.shell}px while window is ${state.viewport}px`);
      if (state.right > state.width - 8) failures.add(`${label}: bar controls overflow (${Math.round(state.right)}px in ${state.width}px)`);
      if (state.clippedCounts) failures.add(`${label}: status counts escaped their pills`);
      if (state.labelDisplay === 'none') failures.add(`${label}: pill labels abruptly removed from layout`);
      return state;
    };
    const toggle = async expanded => {
      const before = await sample('before toggle');
      await window.webContents.executeJavaScript(`(async () => {
        const {app:ui} = await import('./app.js'); ui.isExpanded=${expanded}; ui.updateNotchClass();
      })()`);
      const state = await sample(expanded ? 'open' : 'close');
      assert.equal(state.panelInert, !expanded, 'Panel interaction must follow the requested state');
      assert.equal(state.working, before.working, 'Toggling dropped the working indicator');
      assert.equal(state.usageHeight, before.usageHeight, 'Usage strip shifted the panel during a toggle');
    };
    let w = 600, h = 560, vw = 0, vh = 0;
    const resize = async (expanded, maxFrames = 100) => {
      await toggle(expanded);
      const tw = expanded ? 600 : 420, th = expanded ? 560 : 40;
      const omega = springOmega(expanded ? 0.4 : 0.3);
      for (let frame = 0; frame < maxFrames; frame++) {
        ({pos:w, vel:vw} = stepSpringAxis(w, vw, tw, 1 / 60, omega));
        ({pos:h, vel:vh} = stepSpringAxis(h, vh, th, 1 / 60, omega));
        window.setBounds({width:Math.round(w), height:Math.round(h)});
        await new Promise(resolve => setTimeout(resolve, 17));
        await sample(`${expanded ? 'opening' : 'closing'} frame ${frame}`);
        if (isSpringSettled(w, vw, tw) && isSpringSettled(h, vh, th)) {
          w = tw; h = th; vw = 0; vh = 0;
          window.setBounds({width:w, height:h});
          break;
        }
      }
    };
    await resize(false);
    await resize(true);
    await resize(false, 5);
    await resize(true, 5);
    await resize(false);
    await window.webContents.executeJavaScript(`(async () => {
      const {app:ui}=await import('./app.js');
      ui.sessions=Array.from({length:6},(_,i)=>({id:'busy-'+i,agent:'Codex',
        status:i<4?'needs-attention':i===4?'working':'idle',userPrompt:'Check the notch',taskName:'Motion check'}));
      ui.focusMode=true; ui.renderNotchBar(); ui.updateLaserState();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await sample('busy collapsed bar with focus mode');
    if (process.env.AGENT_NOTCH_SCREENSHOT) {
      fs.writeFileSync(process.env.AGENT_NOTCH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features:[{name:'prefers-reduced-motion',value:'reduce'}]
    });
    await toggle(true);
    window.setBounds({width:600,height:560});
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await sample('reduced motion open');
    const reducedOpen = await window.webContents.executeJavaScript(`(() => {
      const panel=document.getElementById('notch-panel');
      return {opacity:getComputedStyle(panel).opacity,duration:getComputedStyle(panel).transitionDuration,
        state:document.getElementById('app').className,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};
    })()`);
    assert.equal(reducedOpen.opacity, '1', JSON.stringify(reducedOpen));
    await toggle(false);
    window.setBounds({width:420,height:40});
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await sample('reduced motion close');
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.getElementById('notch-panel')).opacity`), '0');
    window.webContents.debugger.detach();
    assert.equal(failures.size, 0, [...failures].slice(0, 12).join('\n'));
    console.log('Notch open, close, reversal, busy bar, indicators, and reduced motion passed');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
});
