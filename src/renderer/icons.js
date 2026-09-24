'use strict';
// Ícones SVG inline (traço usa currentColor para herdar a cor do botão).

(() => {
  const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  window.ICONS = {
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    globe: svg('<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.7 1.6 2.5 3.5 2.5 5.8S9.7 12.2 8 13.8M8 2.2C6.3 3.8 5.5 5.7 5.5 8s.8 4.2 2.5 5.8"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5h-1v-8h8v1"/>'),
    external: svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1"/>'),
    log: svg('<path d="M4 1.8h5.5L12.5 4.8v9.4H4z"/><path d="M9.5 1.8v3h3M6 8h4.5M6 10.5h4.5"/>'),
    refresh: svg('<path d="M13.2 6.5A5.3 5.3 0 0 0 3.3 5M2.8 9.5a5.3 5.3 0 0 0 9.9 1.5"/><path d="M13.5 2.5v4h-4M2.5 13.5v-4h4"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>'),
    trash: svg('<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/>'),
    gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>'),
    warn: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.1"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    inspect: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.8 13.8"/>'),
  };
})();
