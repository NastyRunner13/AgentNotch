const { Tray, Menu, nativeImage } = require('electron');

/**
 * Creates a 16x16 tray icon programmatically using Canvas-like nativeImage.
 * No external image files needed — icons are generated as colored circles.
 */
function createTrayIcon(color = '#4ADE80', badgeCount = 0) {
  const size = 16;
  // Create a simple colored icon using raw RGBA buffer
  const buf = Buffer.alloc(size * size * 4);

  const centerX = size / 2;
  const centerY = size / 2;
  const radius = 6;

  // Parse hex color
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - centerX + 0.5;
      const dy = y - centerY + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Anti-aliased edge
        const alpha = Math.min(1, Math.max(0, radius - dist + 0.5));
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = Math.round(alpha * 255);
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }

  // Draw badge count if > 0
  if (badgeCount > 0 && badgeCount <= 9) {
    // Small dot in top-right corner
    const badgeR = 3;
    const badgeCX = size - badgeR - 1;
    const badgeCY = badgeR + 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const dx = x - badgeCX;
        const dy = y - badgeCY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= badgeR) {
          buf[idx] = 255;
          buf[idx + 1] = 255;
          buf[idx + 2] = 255;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  return nativeImage.createFromBuffer(buf, {
    width: size,
    height: size
  });
}

/**
 * @param {{ onShow: () => void, onSettings: () => void }} callbacks
 */
function createTray({ onShow, onSettings }) {
  const icon = createTrayIcon('#4ADE80');
  const tray = new Tray(icon);

  tray.setToolTip('AgentNotch — AI Agent Monitor');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show AgentNotch',
      click: () => onShow && onShow()
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => onSettings && onSettings()
    },
    { type: 'separator' },
    {
      label: 'Quit AgentNotch',
      role: 'quit'
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (onShow) onShow();
  });

  return tray;
}

function updateTrayIcon(tray, state) {
  if (!tray || tray.isDestroyed()) return;

  let color;
  if (state.hasAttention) {
    color = '#F59E0B'; // Orange for needs attention
  } else if (state.hasWorking) {
    color = '#60A5FA'; // Blue for working
  } else {
    color = '#4ADE80'; // Green for idle
  }

  const icon = createTrayIcon(color, state.activeCount);
  tray.setImage(icon);

  // Update tooltip with count
  const count = state.activeCount || 0;
  tray.setToolTip(`AgentNotch — ${count} agent${count !== 1 ? 's' : ''} active`);
}

module.exports = { createTray, updateTrayIcon };
