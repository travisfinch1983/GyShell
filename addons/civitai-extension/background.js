/**
 * Service worker: opens the Review side panel.
 *
 * The toolbar icon opens it (openPanelOnActionClick). The page's Review button asks for it by
 * message; chrome.sidePanel.open() has to run inside the user gesture, which a message sent
 * from the click handler carries.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[ailab-civitai] setPanelBehavior failed:', e));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'openReview' || !sender.tab) return;
  chrome.sidePanel.open({ windowId: sender.tab.windowId })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      console.error('[ailab-civitai] sidePanel.open failed:', e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
  return true; // sendResponse is async
});
