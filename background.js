"use strict";

const WIKI_SIGNUP = "https://www.wiki-masters.com/signup";
const MAIL_URL = "https://10minutemail.com/";
const handledWindows = new Set();
const configuringWindows = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForIncognitoTabs(windowId, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const win = await chrome.windows.get(windowId);
      if (!win.incognito) return [];
      const tabs = await chrome.tabs.query({windowId});
      if (tabs.length > 0) return tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    } catch {
      return [];
    }
    await sleep(100);
  }
  return [];
}


async function closeAllIncognitoWindows() {
  const windows = await chrome.windows.getAll();
  const incognitoWindows = windows.filter(win =>
    win?.incognito && win.id != null && win.id !== chrome.windows.WINDOW_ID_NONE
  );

  let closed = 0;
  for (const win of incognitoWindows) {
    try {
      await chrome.windows.remove(win.id);
      closed++;
    } catch (error) {
      (() => {})(`[WikiMasters Pack Hunter] Impossible de fermer la fenêtre privée ${win.id} :`, error);
    }
  }

  return closed;
}

async function openPrivateTabs(windowId) {
  if (configuringWindows.has(windowId) || handledWindows.has(windowId)) return;
  configuringWindows.add(windowId);

  try {
    const win = await chrome.windows.get(windowId);
    if (!win.incognito) return;

    const tabs = await waitForIncognitoTabs(windowId);
    if (!tabs.length) return;

    // Configure the first existing tab as 10MinuteMail.
    const mailTab = tabs[0];
    await chrome.tabs.update(mailTab.id, {
      url: MAIL_URL,
      active: false
    });

    await sleep(200);

    // Re-query after navigation because Chrome/Next can replace tab state.
    const currentTabs = await chrome.tabs.query({windowId});
    const wikiTabs = currentTabs.filter(tab => {
      try {
        const u = new URL(tab.url || "");
        return u.protocol === "https:" &&
          (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") &&
          u.pathname === "/signup";
      } catch {
        return false;
      }
    });

    // Idempotent setup: if another event already created WikiMasters,
    // reuse the first tab and remove duplicate signup tabs.
    let wikiTab = wikiTabs[0] || null;
    for (const duplicate of wikiTabs.slice(1)) {
      try {
        await chrome.tabs.remove(duplicate.id);
      } catch {}
    }

    if (!wikiTab) {
      wikiTab = await chrome.tabs.create({
        windowId,
        url: WIKI_SIGNUP,
        active: true
      });
    } else {
      await chrome.tabs.update(wikiTab.id, {active: true});
    }

    if (wikiTab?.id) {
      try {
        await chrome.windows.update(windowId, {focused: true});
      } catch {}
    }

    handledWindows.add(windowId);
  } catch (error) {
    (() => {})("[WikiMasters Pack Hunter] Impossible de configurer la fenêtre privée :", error);
  } finally {
    configuringWindows.delete(windowId);
  }
}

chrome.windows.onCreated.addListener(window => {
  if (window?.incognito) {
    handledWindows.delete(window.id);
    // Give Chrome a moment to finish creating the first tab.
    setTimeout(() => openPrivateTabs(window.id), 250);
  }
});

chrome.windows.onRemoved.addListener(windowId => {
  handledWindows.delete(windowId);
  configuringWindows.delete(windowId);
});

// A 10MinuteMail content script sends a WikiMasters verification code here.
// The code is forwarded only to WikiMasters tabs in the SAME browser window.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "wmph" || msg.action !== "closeAllIncognitoWindows") return;

  closeAllIncognitoWindows()
    .then(closed => sendResponse({ok: true, closed}))
    .catch(error => {
      (() => {})("[WikiMasters Pack Hunter] Erreur fermeture fenêtres privées :", error);
      sendResponse({ok: false, error: String(error)});
    });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "wmph_email_code" || !msg.code) return;

  (async () => {
    try {
      const sourceWindowId = sender?.tab?.windowId ?? msg.sourceWindowId;
      if (sourceWindowId == null) {
        sendResponse({ok:false, error:"Fenêtre source inconnue"});
        return;
      }

      const tabs = await chrome.tabs.query({windowId: sourceWindowId});
      const targets = tabs.filter(tab => {
        try {
          const u = new URL(tab.url || "");
          return u.protocol === "https:" &&
            (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com");
        } catch {
          return false;
        }
      });

      let sent = 0;
      for (const tab of targets) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "wmph",
            action: "fillOtp",
            code: String(msg.code)
          });
          sent++;
        } catch {}
      }

      sendResponse({ok:true, sent});
    } catch (error) {
      (() => {})("[WikiMasters Pack Hunter] Erreur transfert OTP :", error);
      sendResponse({ok:false, error:String(error)});
    }
  })();

  return true;
});

// A 10MinuteMail page also sends the generated mailbox address.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "wmph_email_address" || !msg.email) return;

  (async () => {
    try {
      const sourceWindowId = sender?.tab?.windowId ?? msg.sourceWindowId;
      if (sourceWindowId == null) {
        sendResponse({ok:false, error:"Fenêtre source inconnue"});
        return;
      }

      const tabs = await chrome.tabs.query({windowId: sourceWindowId});
      const targets = tabs.filter(tab => {
        try {
          const u = new URL(tab.url || "");
          return u.protocol === "https:" &&
            (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") &&
            u.pathname.startsWith("/signup");
        } catch {
          return false;
        }
      });

      let sent = 0;
      for (const tab of targets) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "wmph",
            action: "fillSignup",
            email: String(msg.email),
            delay: msg.delay
          });
          sent++;
        } catch {}
      }
      sendResponse({ok:true, sent});
    } catch (error) {
      (() => {})("[WikiMasters Pack Hunter] Erreur transfert adresse :", error);
      sendResponse({ok:false, error:String(error)});
    }
  })();

  return true;
});


// V4 — relais du compte privé vers les onglets WikiMasters publics.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'wmph_trade' || msg.action !== 'sourceReady') return;
  (async () => {
    try {
      const tabs = await chrome.tabs.query({});
      const targets = tabs.filter(tab => {
        if (!tab?.id || tab.incognito) return false;
        try {
          const u = new URL(tab.url || '');
          return u.protocol === 'https:' && (u.hostname === 'www.wiki-masters.com' || u.hostname === 'wiki-masters.com');
        } catch { return false; }
      });
      let sent = 0;
      for (const tab of targets) {
        try {
          await chrome.tabs.sendMessage(tab.id, {type:'wmph', action:'acceptFriendRequest', sourceId:msg.sourceId, targetUsername:msg.targetUsername || '', accepted:!!msg.accepted});
          sent++;
        } catch {}
      }
      sendResponse({ok:true, sent});
    } catch (error) { sendResponse({ok:false,error:String(error)}); }
  })();
  return true;
});
