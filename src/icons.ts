// All iconography is inline SVG on currentColor — crisp at any zoom level.
const svg = (body: string, stroke = true) =>
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" ${
    stroke
      ? 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"'
      : 'fill="currentColor"'
  }>${body}</svg>`;

export const icons = {
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  chevron: svg('<path d="m6 3.75 4.25 4.25L6 12.25" stroke-width="1.6"/>'),
  // A true cog silhouette (24-unit viewBox) so it reads as a gear, not a sun.
  gear:
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  sun: svg(
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/>'
  ),
  moon: svg('<path d="M13.4 9.5A5.5 5.5 0 0 1 6.5 2.6a5.5 5.5 0 1 0 6.9 6.9Z"/>'),
  code: svg('<path d="m5.5 5.5-3 2.5 3 2.5"/><path d="m10.5 5.5 3 2.5-3 2.5"/><path d="M9.2 3.6 6.8 12.4"/>'),
  keyboard: svg(
    '<rect x="1.75" y="4" width="12.5" height="8" rx="1.4"/><path d="M4 6.4h0M6.2 6.4h0M8.4 6.4h0M10.6 6.4h0M4 8.6h0M12 6.4h0M5.5 9.9h5" stroke-width="1.6"/>'
  ),
  // Import: arrow into a tray. Export: arrow out of a tray.
  importFile: svg('<path d="M8 2.5v7M5 6.7 8 9.7l3-3"/><path d="M2.5 10.5v2c0 .55.45 1 1 1h9c.55 0 1-.45 1-1v-2"/>'),
  exportFile: svg('<path d="M8 9.5v-7M5 5.3 8 2.3l3 3"/><path d="M2.5 10.5v2c0 .55.45 1 1 1h9c.55 0 1-.45 1-1v-2"/>'),
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3"/>'),
  // Pushpin (name-pin toggle) and a chain link (linked-file indicator).
  pin: svg('<path d="M9.5 2.5 13.5 6.5M11 4 7.5 7.5l-3 .6-.8.8 4.4 4.4.8-.8.6-3L14 6"/><path d="M6 10 2.5 13.5"/>'),
  link: svg('<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/>'),
  // Close buffer: an x boxed in, so it reads as "close this buffer" in the
  // toolbar rather than repeating the bare x that closes a tab from its own row.
  closeBuffer: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.6"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  // Find & replace: the find lens plus the swap arrows that make it a replace.
  replace: svg(
    '<circle cx="6.5" cy="6.5" r="3.75"/><path d="m9.4 9.4 1.4 1.4"/><path d="M9 13h4.5m-1.6-1.6L13.5 13l-1.6 1.6"/>'
  ),
  // Cloud (the Remote tab): other machines' buffers live "up there".
  cloud: svg('<path d="M11.4 12.5H5.9a3.4 3.4 0 1 1 .65-6.74 4 4 0 0 1 7.75 1.34 2.7 2.7 0 0 1-2.9 5.4Z"/>'),
  cloudUp: svg(
    '<path d="M11.4 12.5H5.9a3.4 3.4 0 1 1 .65-6.74 4 4 0 0 1 7.75 1.34 2.7 2.7 0 0 1-2.9 5.4Z"/><path d="M8 12.5V7.2M6.2 9l1.8-1.8L9.8 9"/>'
  ),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
};
