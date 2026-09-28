/** Patch rendered content without replacing focused controls or animated cards. */
export function reconcileChildren(parent, source, { preserveOrder = false, preserveNode = null } = {}) {
  const key = (node) => node.nodeType !== 1 ? `#${node.nodeType}`
    : `${node.tagName}|${node.id || ''}|${node.dataset.sessionId || ''}|${node.dataset.requestId || ''}|${node.dataset.foldKey || ''}|${node.getAttribute('name') || ''}|${node.classList[0] || ''}`;
  const remaining = [...parent.childNodes];
  const incoming = [...source.childNodes];
  let cursor = parent.firstChild;
  for (const next of incoming) {
    const current = remaining.find(node => key(node) === key(next));
    if (!current) {
      parent.insertBefore(next, preserveOrder ? null : cursor);
      continue;
    }
    remaining.splice(remaining.indexOf(current), 1);
    if (!preserveOrder && current !== cursor) {
      // Modern Chromium's moveBefore preserves focus and in-flight animations.
      if (parent.moveBefore) parent.moveBefore(current, cursor);
      else parent.insertBefore(current, cursor);
    }
    if (current === preserveNode) { cursor = current.nextSibling; continue; }
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    } else {
      const isCard = current.classList.contains('session-card');
      const previousStatus = current.dataset.status;
      const previousAttention = current.dataset.attentionEpisode;
      const expanded = isCard && current.classList.contains('expanded');
      const entering = isCard && current.classList.contains('card-enter');
      const menu = current.classList.contains('snooze-menu');
      const toggle = current.classList.contains('btn-snooze');
      const preserve = name => ['value', 'checked', 'selected'].includes(name)
        || name === 'data-motion-visible'
        || (name === 'aria-expanded' && (isCard || toggle)) || (menu && name === 'hidden');
      for (const attr of [...current.attributes]) {
        if (!next.hasAttribute(attr.name) && !preserve(attr.name)) current.removeAttribute(attr.name);
      }
      for (const attr of [...next.attributes]) {
        if (!preserve(attr.name) && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      }
      if (isCard) {
        current.classList.toggle('expanded', expanded);
        current.classList.toggle('card-enter', entering);
        current.classList.toggle('card-static', !entering);
      }
      reconcileChildren(current, next);
      if (isCard && !matchMedia('(prefers-reduced-motion: reduce)').matches &&
          ((previousStatus !== 'idle' && current.dataset.status === 'idle') ||
           (current.classList.contains('attention') && previousAttention !== current.dataset.attentionEpisode))) {
        current.querySelector('.session-status-text')?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200 });
      }
    }
    cursor = current.nextSibling;
  }
  for (const node of remaining) {
    const hadFocus = node.nodeType === 1 && node.contains(document.activeElement);
    if (parent.id === 'sessions-list' && node.nodeType === 1 && node.classList.contains('session-card') &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const rect = node.getBoundingClientRect();
      const exit = node.cloneNode(true);
      exit.inert = true;
      exit.setAttribute('aria-hidden', 'true');
      exit.removeAttribute('data-session-id');
      exit.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      Object.assign(exit.style, { position: 'fixed', pointerEvents: 'none', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '20', margin: '0' });
      document.body.append(exit);
      exit.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }],
        { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).finished.then(() => exit.remove(), () => exit.remove());
    }
    node.remove();
    if (hadFocus) parent.querySelector('[tabindex="0"], button')?.focus({ preventScroll: true });
  }
}
