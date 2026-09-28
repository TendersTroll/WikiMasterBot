(() => {
  "use strict";

  // Le content script est chargé sur WikiMasters pour pouvoir détecter les
  // navigations SPA. L'automatisation des paquets fonctionne sur /pulls,
  // avec /pull comme étape de démarrage après validation manuelle.
  const WIKI_HOSTS = new Set(["www.wiki-masters.com", "wiki-masters.com"]);
  if (!WIKI_HOSTS.has(location.hostname)) return;

  const STORAGE_KEY = "wmph_settings";
  const DEFAULTS = {
    enabled: true,
    pollMs: 120,
    actionDelay: 250,
    viewDelay: 180,
    retryDelay: 500,
    navigationDelay: 150,
    signupFillDelay: 150,
    signupSubmitDelay: 150,
    signupButtonPollMs: 75,
    signupButtonTimeoutMs: 15000,
    otpSubmitDelay: 150
  };

  let settings = {...DEFAULTS};
  let halted = false;
  let busy = false;
  let observer = null;
  let timer = null;
  let navigationTimer = null;
  let lastUrl = location.href;
  let inPulls = false;
  let inPullStartup = false;
  let startupListenerInstalled = false;
  let startupValidated = false;
  let startupWaitingForPack = false;
  let startupWatchTimer = null;
  let startupGateObserver = null;
  let urlWatcher = null;
  let startupUserGestureAt = 0;

  const state = { status: "Repos", packs: 0 };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  const normalize = s => (s || "").replace(/\s+/g, " ").trim();

  function isWikiMastersPage() {
    return WIKI_HOSTS.has(location.hostname);
  }

  function isPullsPage() {
    const url = new URL(location.href);
    return isWikiMastersPage() && url.pathname.startsWith("/pulls");
  }

  function isPullStartupPage() {
    const url = new URL(location.href);
    return isWikiMastersPage() && /^\/pull\/?$/.test(url.pathname);
  }

  function findStartupGate() {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')].find(input => {
      const label = input.closest("label");
      return /je ne suis pas un robot/i.test(normalize(label?.innerText || ""));
    });
    if (!checkbox) return {checkbox: null, button: null};

    const container = checkbox.closest("div.relative") || checkbox.closest("label")?.parentElement;
    const buttons = [...(container || document).querySelectorAll("button")].filter(isVisible);
    const button = buttons.find(btn => normalize(btn.innerText || btn.textContent) === "Continuer") || null;
    return {checkbox, button};
  }

  function findStartupContinueButton() {
    return findStartupGate().button;
  }

  function startAfterStartupGate() {
    if (!isWikiMastersPage() || !startupValidated) return;

    startupWaitingForPack = true;
    inPullStartup = false;
    inPulls = isPullsPage();
    setStatus("Validation manuelle détectée — démarrage...");

    if (startupWatchTimer) clearTimeout(startupWatchTimer);

    const startedAt = Date.now();
    const timeout = 20000;
    const poll = Math.max(50, Number(settings.pollMs) || 120);

    const watch = () => {
      if (!isWikiMastersPage() || !startupValidated) return;

      // Si Next.js nous a réellement envoyé vers /pulls, le reset de navigation
      // prendra le relais. Si l'URL reste /pull, on attend simplement que React
      // ait remplacé la vérification par l'interface de paquet.
      if (isPullsPage()) {
        startupWaitingForPack = false;
        resetForNavigation();
        return;
      }

      const open = findOpenPackButton();
      if (isPullStartupPage() && open && !open.disabled) {
        startupWaitingForPack = false;
        inPulls = true;
        inPullStartup = false;
        state.status = settings.enabled ? "Recherche d'un pack..." : "Arrêté";
        renderOverlay();
        if (settings.enabled && !busy && !halted) runLoop();
        return;
      }

      if (Date.now() - startedAt < timeout) {
        startupWatchTimer = setTimeout(watch, poll);
      } else {
        startupWaitingForPack = false;
        setStatus("Validation OK — interface de paquet introuvable");
      }
    };

    watch();
  }

  function installStartupGateSensor() {
    // Install the listener once for the lifetime of the content script. The
    // page is a Next.js SPA, so the DOM nodes for /pull can be destroyed and
    // recreated many times.
    if (startupListenerInstalled) return;
    startupListenerInstalled = true;

    document.addEventListener("change", event => {
      if (!isPullStartupPage()) return;
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input || input.type !== "checkbox") return;
      const label = input.closest("label");
      if (!/je ne suis pas un robot/i.test(normalize(label?.innerText || ""))) return;

      // Record a real user gesture so a DOM mutation alone can never be
      // mistaken for completion of the verification gate.
      if (event.isTrusted) startupUserGestureAt = Date.now();

      if (input.checked) {
        startupValidated = false;
        inPullStartup = true;
        setStatus("Vérification cochée — clique sur Continuer");
      } else {
        startupValidated = false;
        inPullStartup = true;
        setStatus("En attente de validation manuelle");
      }
    }, true);

    document.addEventListener("click", event => {
      if (!isPullStartupPage()) return;
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (!target) return;

      const {checkbox} = findStartupGate();
      const buttonText = normalize(target.innerText || target.textContent);
      if (!checkbox || !checkbox.checked || buttonText !== "Continuer" || target.disabled) return;

      // Observe only the user's actual click. The extension never triggers
      // the verification checkbox or Continue button itself.
      startupUserGestureAt = Date.now();
      startupValidated = true;
      setStatus("Validation manuelle détectée");
      startAfterStartupGate();
    }, true);

    if (startupGateObserver) startupGateObserver.disconnect();
    startupGateObserver = new MutationObserver(() => {
      if (!isPullStartupPage()) return;

      const {checkbox, button} = findStartupGate();
      if (checkbox) {
        inPullStartup = true;
        if (checkbox.checked && button && !button.disabled) {
          setStatus("Vérification prête — clique sur Continuer");
        } else if (!checkbox.checked) {
          setStatus("En attente de validation manuelle");
        }
        return;
      }

      // The gate may disappear after the user's click before Next.js updates
      // the URL. Treat that DOM transition as a secondary sensor only for a
      // short window after a real user gesture.
      if (!startupValidated && startupUserGestureAt && Date.now() - startupUserGestureAt < 3000 && findOpenPackButton()) {
        startupValidated = true;
        startAfterStartupGate();
      }
    });

    const observe = () => {
      if (document.documentElement) {
        startupGateObserver.observe(document.documentElement, {
          subtree:true,
          childList:true,
          attributes:true,
          attributeFilter:["disabled", "class", "checked"]
        });
      }
    };
    observe();
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function allButtons() {
    return [...document.querySelectorAll("button")].filter(isVisible);
  }

  function findOpenPackButton() {
    const img = [...document.querySelectorAll('img[alt="Ouvrir un paquet"]')].find(isVisible);
    if (img) {
      const btn = img.closest("button");
      if (btn && !btn.disabled) return btn;
    }
    return allButtons().find(btn => {
      const t = normalize(btn.innerText);
      return /^Ouvrir$/.test(t) && !btn.disabled && !/pack pro/i.test(btn.parentElement?.innerText || "");
    }) || null;
  }

  function findContinueButton() {
    return allButtons().find(btn => normalize(btn.innerText) === "Continuer") || null;
  }

  function findMoreCardsButton() {
    return allButtons().find(btn => /^Encore \d+ carte/.test(normalize(btn.innerText))) || null;
  }

  function viewerIsOpen() {
    return !!findContinueButton() || !!findMoreCardsButton() || !!document.querySelector(".legendary-shimmer-sheen");
  }

  function legendaryFound() {
    if ([...document.querySelectorAll(".legendary-shimmer-sheen")].some(isVisible)) return true;

    const candidates = [...document.querySelectorAll("div")].filter(el => {
      if (!isVisible(el)) return false;
      if (normalize(el.textContent) !== "L") return false;
      const cls = typeof el.className === "string" ? el.className : "";
      return cls.includes("absolute") && cls.includes("top-2") && cls.includes("left-2");
    });
    return candidates.some(el => {
      const card = el.closest(".rounded-2xl");
      return !!card && !!card.querySelector("h3");
    });
  }

  function findNextButton() {
    for (const btn of allButtons()) {
      if (btn.querySelector('polyline[points="9 18 15 12 9 6"]')) return btn;
    }
    const more = findMoreCardsButton();
    if (more) {
      const row = more.parentElement;
      if (row) {
        const btns = [...row.querySelectorAll("button")].filter(isVisible);
        if (btns.length) return btns[btns.length - 1];
      }
    }
    return null;
  }

  function setStatus(status) {
    state.status = status;
    renderOverlay();
  }

  function makeOverlay() {
    if (document.getElementById("wmph-overlay")) return;
    const box = document.createElement("div");
    box.id = "wmph-overlay";
    box.innerHTML = `
      <div id="wmph-title">Pack Hunter</div>
      <div id="wmph-status">Repos</div>
      <div id="wmph-packs">Packs parcourus : 0</div>
      <button id="wmph-toggle" type="button">—</button>
    `;
    Object.assign(box.style, {
      position:"fixed", right:"16px", bottom:"16px", zIndex:"2147483647", width:"220px",
      padding:"12px", borderRadius:"12px", background:"rgba(15,23,42,.96)", color:"#fff",
      font:"13px/1.4 system-ui,sans-serif", boxShadow:"0 10px 35px rgba(0,0,0,.35)",
      border:"1px solid rgba(255,255,255,.12)"
    });
    Object.assign(box.querySelector("#wmph-title").style, {fontWeight:"700", marginBottom:"5px"});
    Object.assign(box.querySelector("#wmph-status").style, {color:"#94a3b8", marginBottom:"3px"});
    Object.assign(box.querySelector("#wmph-packs").style, {color:"rgba(255,255,255,.65)", fontSize:"12px", marginBottom:"9px"});
    Object.assign(box.querySelector("#wmph-toggle").style, {width:"100%", border:"0", borderRadius:"8px", padding:"8px", cursor:"pointer", fontWeight:"700"});

    box.querySelector("#wmph-toggle").addEventListener("click", async () => {
      if (!inPulls) return;
      if (halted) {
        halted = false;
        settings.enabled = true;
        await saveSettings();
        setStatus("Recherche d'un pack...");
        runLoop();
      } else {
        settings.enabled = !settings.enabled;
        await saveSettings();
        if (!settings.enabled) {
          busy = false;
          setStatus("Arrêté");
          clearScheduled();
        } else {
          setStatus("Recherche d'un pack...");
          runLoop();
        }
      }
    });
    document.documentElement.appendChild(box);
    renderOverlay();
  }

  function renderOverlay() {
    const box = document.getElementById("wmph-overlay");
    if (!box) return;
    const status = box.querySelector("#wmph-status");
    const packs = box.querySelector("#wmph-packs");
    const button = box.querySelector("#wmph-toggle");

    packs.textContent = `Packs parcourus : ${state.packs}`;
    if (inPullStartup) {
      status.textContent = "En attente de validation manuelle";
      status.style.color = "#fbbf24";
      button.textContent = "Attente de validation";
      button.style.background = "#475569";
      button.style.color = "#fff";
      button.disabled = true;
    } else if (!inPulls) {
      status.textContent = "Repos — hors /pulls";
      status.style.color = "#94a3b8";
      button.textContent = "Aller dans /pulls";
      button.style.background = "#475569";
      button.style.color = "#fff";
      button.disabled = true;
    } else if (halted) {
      status.textContent = state.status;
      status.style.color = "#f87171";
      button.textContent = "Reprendre";
      button.style.background = "#ef4444";
      button.style.color = "#fff";
      button.disabled = false;
    } else if (settings.enabled) {
      status.textContent = state.status;
      status.style.color = "#4ade80";
      button.textContent = "Arrêter";
      button.style.background = "#22c55e";
      button.style.color = "#052e16";
      button.disabled = false;
    } else {
      status.textContent = "Arrêté";
      status.style.color = "#fbbf24";
      button.textContent = "Démarrer";
      button.style.background = "#f59e0b";
      button.style.color = "#1c1917";
      button.disabled = false;
    }
  }

  function clearScheduled() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (navigationTimer) clearTimeout(navigationTimer);
    navigationTimer = null;
    if (startupWatchTimer) clearTimeout(startupWatchTimer);
    startupWatchTimer = null;
  }

  async function saveSettings() {
    await chrome.storage.local.set({[STORAGE_KEY]: settings});
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    settings = {...DEFAULTS, ...(data[STORAGE_KEY] || {})};
  }

  function stopOnLegendary() {
    settings.enabled = false;
    halted = true;
    busy = false;
    clearScheduled();
    saveSettings().catch(() => {});
    setStatus("🟡 Légendaire trouvée — arrêt");
  }

  async function waitForPackResult(timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!inPulls || !settings.enabled || halted) return false;
      if (legendaryFound() || viewerIsOpen()) return true;
      await sleep(settings.pollMs);
    }
    return false;
  }

  async function inspectCurrentCard() {
    await sleep(settings.viewDelay);
    if (!inPulls || !settings.enabled || halted) return false;
    if (legendaryFound()) { stopOnLegendary(); return false; }

    const more = findMoreCardsButton();
    if (more) {
      const next = findNextButton();
      if (!next || next.disabled) {
        setStatus("Attente de la prochaine carte...");
        await sleep(settings.retryDelay);
        return true;
      }
      next.click();
      await sleep(settings.viewDelay);
      return true;
    }

    const cont = findContinueButton();
    if (cont) {
      cont.click();
      state.packs++;
      renderOverlay();
      await sleep(settings.actionDelay);
      return true;
    }
    return true;
  }

  async function runLoop() {
    if (busy || !inPulls || !settings.enabled || halted) return;
    busy = true;
    try {
      while (inPulls && settings.enabled && !halted) {
        if (legendaryFound()) { stopOnLegendary(); break; }

        if (viewerIsOpen()) {
          setStatus("Analyse du pack...");
          if (!(await inspectCurrentCard())) break;
          continue;
        }

        const open = findOpenPackButton();
        if (open && !open.disabled) {
          setStatus("Ouverture du pack...");
          open.click();
          const appeared = await waitForPackResult();
          if (!appeared && inPulls && settings.enabled) {
            setStatus("Attente du résultat...");
            await sleep(settings.retryDelay);
          }
          continue;
        }

        if (document.body.innerText.includes("Sanction anti-triche")) {
          settings.enabled = false;
          halted = true;
          await saveSettings();
          setStatus("Arrêt : restriction anti-triche");
          break;
        }

        const body = normalize(document.body.innerText);
        setStatus(/Aucun paquet|paquets disponibles/i.test(body) ? "Aucun pack disponible" : "Recherche d'un pack...");
        await sleep(settings.retryDelay);
      }
    } finally {
      busy = false;
      renderOverlay();
    }
  }

  function resetForNavigation() {
    clearScheduled();
    busy = false;
    halted = false;
    inPulls = isPullsPage();
    inPullStartup = isPullStartupPage();
    startupWaitingForPack = false;
    startupUserGestureAt = 0;

    // Keep the global startup sensor alive across SPA route changes.
    if (!inPullStartup) startupValidated = false;
    installStartupGateSensor();

    state.status = inPulls
      ? (settings.enabled ? "Recherche d'un pack..." : "Arrêté")
      : (inPullStartup ? "En attente de validation manuelle" : "Repos");
    renderOverlay();

    if (inPulls && settings.enabled) {
      timer = setTimeout(() => runLoop(), Math.max(0, Number(settings.navigationDelay) || 150));
    }
  }

  function checkUrlChange() {
    const current = location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    if (navigationTimer) clearTimeout(navigationTimer);
    const delay = Math.max(0, Number(settings.navigationDelay) || 150);
    navigationTimer = setTimeout(resetForNavigation, delay);
  }

  function installNavigationHooks() {
    if (installNavigationHooks._installed) return;
    installNavigationHooks._installed = true;

    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    history.pushState = function(...args) {
      const result = originalPush.apply(this, args);
      queueMicrotask(checkUrlChange);
      return result;
    };
    history.replaceState = function(...args) {
      const result = originalReplace.apply(this, args);
      queueMicrotask(checkUrlChange);
      return result;
    };

    window.addEventListener("popstate", checkUrlChange, true);
    window.addEventListener("hashchange", checkUrlChange, true);

    if (urlWatcher) clearInterval(urlWatcher);
    urlWatcher = setInterval(checkUrlChange, 100);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    settings = {...DEFAULTS, ...(changes[STORAGE_KEY].newValue || {})};
    renderOverlay();
    if (inPulls && settings.enabled && !halted) {
      clearScheduled();
      timer = setTimeout(runLoop, settings.navigationDelay);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "wmph") return;
    if (msg.action === "fillOtp") {
      const filled = fillOtp(msg.code);
      sendResponse({filled});
      return true;
    }
    if (msg.action === "fillSignup") {
      fillSignup(msg.email, Number(msg.delay ?? settings.signupFillDelay) || 0)
        .then(filled => sendResponse({filled}));
      return true;
    }
    if (msg.action === "getState") {
      sendResponse({enabled:settings.enabled, halted, status:state.status, packs:state.packs, inPulls, settings});
      return true;
    }
    if (msg.action === "toggle") {
      settings.enabled = !settings.enabled;
      if (!settings.enabled) { clearScheduled(); setStatus("Arrêté"); }
      else if (inPulls) { halted = false; setStatus("Recherche d'un pack..."); runLoop(); }
      saveSettings().then(() => sendResponse({enabled:settings.enabled, halted, status:state.status, packs:state.packs, inPulls, settings}));
      return true;
    }
    if (msg.action === "updateSettings") {
      settings = {...settings, ...(msg.settings || {})};
      saveSettings().then(() => {
        if (inPulls && settings.enabled && !halted) { clearScheduled(); timer = setTimeout(runLoop, settings.navigationDelay); }
        sendResponse({settings});
      });
      return true;
    }
    if (msg.action === "resetSettings") {
      settings = {...DEFAULTS};
      saveSettings().then(() => sendResponse({settings}));
      return true;
    }
  });

  async function fillSignup(email, delay = settings.signupFillDelay) {
    if (!email || !isSignupPage()) return false;

    const value = String(email).trim();
    const at = value.indexOf("@");
    if (at <= 0 || at === value.length - 1) return false;

    const username = value.slice(0, at);
    const requiredEmail = value;

    // WikiMasters currently requires a username between 3 and 24 characters.
    // Use the generated mailbox local-part exactly as requested.
    if (username.length < 3 || username.length > 24) return false;

    if (delay > 0) await sleep(delay);

    const usernameInput = document.querySelector("#username") || document.querySelector('input[autocomplete="username"]');
    const emailInput = document.querySelector("#email") || document.querySelector('input[type="email"][autocomplete="email"]');
    const passwordInput = document.querySelector("#password") || document.querySelector('input[type="password"][autocomplete="new-password"]');
    if (!usernameInput || !emailInput || !passwordInput) return false;

    setReactInputValue(usernameInput, username);
    setReactInputValue(emailInput, requiredEmail);
    setReactInputValue(passwordInput, requiredEmail);

    const checks = [...document.querySelectorAll('#signup-form input[type="checkbox"], form input[type="checkbox"]')];
    let checked = 0;
    for (const checkbox of checks) {
      if (!checkbox.checked && !checkbox.disabled) {
        checkbox.click();
        checked++;
      }
    }

    const filled = usernameInput.value === username && emailInput.value === requiredEmail && passwordInput.value === requiredEmail && checks.every(c => c.checked || c.disabled);

    // The signup button is rendered before the form becomes submittable.
    // Wait until the site itself has enabled the button, then click it once.
    if (filled) {
      waitForCreateAccountButton();
    }

    return filled;
  }

  function waitForCreateAccountButton() {
    const delay = Math.max(0, Number(settings.signupSubmitDelay) || 150);
    const poll = Math.max(25, Number(settings.signupButtonPollMs) || 75);
    const timeout = Math.max(1000, Number(settings.signupButtonTimeoutMs) || 15000);

    setTimeout(() => {
      const startedAt = Date.now();
      let clicked = false;

      const isClickable = (button) => {
        if (!button || !document.contains(button) || !isSignupPage()) return false;
        if (button.disabled) return false;
        if (button.getAttribute("aria-disabled") === "true") return false;

        const style = getComputedStyle(button);
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;

        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const check = () => {
        if (clicked || !isSignupPage()) return;

        // React can replace the button after validation/Turnstile changes, so
        // never keep a reference from an earlier render.
        const button = [...document.querySelectorAll("button[type=\"submit\"]")].find(btn => {
          const text = normalize(btn.innerText || btn.textContent);
          return /cr[ée]er\s+mon\s+compte/i.test(text);
        }) || [...document.querySelectorAll("button")].find(btn => {
          const text = normalize(btn.innerText || btn.textContent);
          return /cr[ée]er\s+mon\s+compte/i.test(text);
        });

        if (isClickable(button)) {
          clicked = true;
          button.click();
          return;
        }

        if (Date.now() - startedAt < timeout) {
          setTimeout(check, poll);
        }
      };

      check();
    }, delay);
  }

  function isSignupPage() {
    try {
      return isWikiMastersPage() && new URL(location.href).pathname.startsWith("/signup");
    } catch { return false; }
  }

  function setReactInputValue(input, value) {
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
    } catch {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.dispatchEvent(new Event("change", {bubbles:true}));
    input.dispatchEvent(new Event("blur", {bubbles:true}));
  }

  function fillOtp(code) {
    if (!code) return false;
    const input = document.querySelector("#signup-otp-code") || document.querySelector('input[name="otp"]');
    if (!input || input.disabled || input.readOnly) return false;

    const value = String(code).trim();
    if (!/^\d{6,12}$/.test(value)) return false;

    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
    } catch {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.dispatchEvent(new Event("change", {bubbles:true}));
    input.dispatchEvent(new Event("blur", {bubbles:true}));
    input.focus();

    // Once the verification code has been filled, automatically submit the
    // "Vérifier et continuer" form. We deliberately do not interact with
    // the Cloudflare/Turnstile challenge itself; the site remains responsible
    // for validating that challenge.
    const submitButton = [...document.querySelectorAll("button")].find(btn => {
      if (!isVisible(btn) || btn.disabled) return false;
      const text = normalize(btn.innerText || btn.textContent);
      return /v[ée]rifier\s+et\s+continuer/i.test(text);
    });

    if (submitButton) {
      const delay = Math.max(0, Number(settings.otpSubmitDelay) || 150);

      // The button can become visible before React enables it. Instead of
      // clicking once after a fixed delay, wait until it is genuinely
      // clickable. This avoids losing the submission because the form state
      // has not finished updating yet.
      setTimeout(() => {
        const startedAt = Date.now();
        const maxWait = 10000;
        const checkEvery = 75;

        const isActuallyClickable = (btn) => {
          if (!btn || !document.contains(btn) || !isSignupPage()) return false;
          if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
          if (!isVisible(btn)) return false;

          const style = getComputedStyle(btn);
          if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;

          const rect = btn.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const waitForClickable = () => {
          if (!isSignupPage()) return;

          // React may replace the button after the OTP changes. Always find
          // the current button again instead of keeping a stale DOM reference.
          const currentButton = [...document.querySelectorAll("button")].find(btn => {
            const text = normalize(btn.innerText || btn.textContent);
            return /v[ée]rifier\s+et\s+continuer/i.test(text);
          });

          if (isActuallyClickable(currentButton)) {
            currentButton.click();
            return;
          }

          if (Date.now() - startedAt < maxWait) {
            setTimeout(waitForClickable, checkEvery);
          }
        };

        waitForClickable();
      }, delay);
    }

    return true;
  }


  // ================= V4 — transfert de cartes =================
  let tradeRunner = null;
  let tradeBusy = false;
  let tradeStatus = "Prêt.";

  async function tradeRequest(path, body) {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {"Content-Type":"application/json"},
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = [data.error, data.message, data.code].filter(v => typeof v === "string").join(" / ").slice(0, 600);
      throw new Error((body ? "POST " : "GET ") + path + " — HTTP " + response.status + " : " + (detail || "requête refusée"));
    }
    return data;
  }

  function reactPropsV4(el) {
    if (!el) return null;
    for (const key of Object.keys(el)) if (key.startsWith("__reactProps$")) {
      try { return el[key]; } catch {}
    }
    return null;
  }

  function containsUserIdV4(el, sourceId) {
    const seen = new Set();
    let node = el;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const props = reactPropsV4(node);
      if (!props) continue;
      const stack = [props];
      while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        for (const [k,v] of Object.entries(value)) {
          if ((k === "id" || k.endsWith("_id")) && String(v) === String(sourceId)) return true;
          if (v && typeof v === "object" && seen.size < 1000) stack.push(v);
        }
      }
    }
    return false;
  }

  async function acceptIncomingFriendV4(sourceId) {
    if (!sourceId || !isWikiMastersPage()) return false;
    const labels = [/^accepter$/i, /^accepter la demande$/i, /^accept$/i, /^accept request$/i];
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const button = [...document.querySelectorAll("button")].find(btn => {
        if (!isVisible(btn) || btn.disabled) return false;
        const text = normalize(btn.innerText || btn.textContent);
        return labels.some(rx => rx.test(text)) && containsUserIdV4(btn, sourceId);
      });
      if (button) {
        button.click();
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function startTradeV4(username) {
    if (tradeBusy) throw new Error("Un transfert est déjà en cours.");
    username = String(username || "").trim();
    if (!username) throw new Error("Renseigne le pseudo exact du compte principal.");
    tradeBusy = true;
    tradeStatus = "Démarrage…";
    tradeRunner = new WMPHTradeRunner({
      request: tradeRequest,
      report: text => { tradeStatus = text; },
      sleep,
      journal: {
        get: async key => (await chrome.storage.local.get(key))[key],
        set: (key,value) => chrome.storage.local.set({[key]:value}),
        remove: key => chrome.storage.local.remove(key)
      }
    });
    try {
      await tradeRunner.run(username);
    } catch (error) {
      tradeStatus = (tradeRunner.sent ? tradeRunner.sent + " carte(s) déjà proposée(s). " : "") + error.message;
    } finally {
      tradeBusy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "wmph") return;
    if (msg.action === "tradeStart") {
      startTradeV4(msg.username).then(() => sendResponse({ok:true})).catch(error => sendResponse({ok:false,error:String(error)}));
      return true;
    }
    if (msg.action === "tradeState") {
      sendResponse({ok:true,busy:tradeBusy,status:tradeStatus});
      return;
    }
    if (msg.action === "acceptFriendRequest") {
      if (sender?.tab?.incognito) { sendResponse({ok:false,error:"Onglet privé refusé."}); return; }
      acceptIncomingFriendV4(msg.sourceId).then(ok => sendResponse({ok,accepted:ok})).catch(error => sendResponse({ok:false,error:String(error)}));
      return true;
    }
  });

  async function init() {
    // Install navigation monitoring as early as possible so a Next.js/SPA
    // transition to /pull is detected without requiring a manual reload.
    installNavigationHooks();
    installStartupGateSensor();
    await loadSettings();

    const startDomWork = () => {
      try {
        makeOverlay();
        inPulls = isPullsPage();
        inPullStartup = isPullStartupPage();

        if (observer) observer.disconnect();
        observer = new MutationObserver(() => {
          if (isPullStartupPage()) {
            inPullStartup = true;
            installStartupGateSensor();
          }
          if (!inPulls || !settings.enabled || busy || halted) return;
          clearScheduled();
          timer = setTimeout(runLoop, Math.max(0, Number(settings.pollMs) || 120));
        });
        if (document.documentElement) {
          observer.observe(document.documentElement, {
            subtree:true,
            childList:true,
            attributes:true,
            attributeFilter:["disabled","class"]
          });
        }

        resetForNavigation();
      } catch (error) {
        (()=>{})("[WikiMasters Pack Hunter] DOM init error", error);
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startDomWork, {once:true});
    } else {
      startDomWork();
    }
  }

  init().catch(err => {
    (()=>{})("[WikiMasters Pack Hunter]", err);
    setStatus("Erreur d'initialisation");
  });
})();

// v2.8 market price support
