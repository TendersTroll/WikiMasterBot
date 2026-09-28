const $ = s => document.querySelector(s);
const DEFAULTS = {enabled:true,pollMs:120,actionDelay:250,viewDelay:180,retryDelay:500,navigationDelay:150,emailPollMs:500,emailFillDelay:150,signupFillDelay:150,signupSubmitDelay:150,signupButtonPollMs:75,signupButtonTimeoutMs:15000,otpSubmitDelay:150};
let currentSettings = {...DEFAULTS};

async function activeTab() {
  const tabs = await chrome.tabs.query({active:true,currentWindow:true});
  return tabs[0];
}

function allowed(url) {
  try {
    const u = new URL(url);
    return (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") && (u.pathname === "/pull" || u.pathname.startsWith("/pulls"));
  } catch { return false; }
}

function updateInputs() {
  for (const key of ["pollMs","actionDelay","viewDelay","retryDelay","navigationDelay","emailPollMs","emailFillDelay","signupFillDelay","signupSubmitDelay","signupButtonPollMs","signupButtonTimeoutMs","otpSubmitDelay"]) {
    const el = $("#" + key);
    const out = $("#" + key + "Out");
    el.value = currentSettings[key];
    out.textContent = currentSettings[key];
  }
}

async function send(action, extra={}) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No tab");
  return chrome.tabs.sendMessage(tab.id, {type:"wmph", action, ...extra});
}

async function refresh() {
  const tab = await activeTab();
  const ok = allowed(tab?.url);
  const isStartup = (() => { try { return new URL(tab?.url || "").pathname === "/pull"; } catch { return false; } })();
  $("#site").textContent = isStartup ? "Page /pull détectée — validation manuelle requise" : (ok ? "Page /pulls détectée" : "WikiMasters : mode repos (va dans /pull ou /pulls)" );

  try {
    const state = await send("getState");
    currentSettings = {...DEFAULTS, ...(state.settings || {})};
    $("#status").textContent = state.halted ? "🟡 Légendaire trouvée — arrêt" : state.status;
    $("#packs").textContent = `Packs parcourus : ${state.packs}`;
    $("#toggle").disabled = !state.inPulls;
    $("#toggle").textContent = !state.inPulls ? "Mode repos" : (state.enabled ? "Arrêter l'automatisation" : "Démarrer l'automatisation");
  } catch {
    $("#status").textContent = ok ? "Recharge la page" : "Mode repos";
    $("#packs").textContent = "Packs parcourus : —";
    $("#toggle").disabled = true;
    $("#toggle").textContent = "Page non chargée";
  }
  updateInputs();
}

$("#toggle").addEventListener("click", async () => {
  try { await send("toggle"); } catch {}
  await refresh();
});

for (const key of ["pollMs","actionDelay","viewDelay","retryDelay","navigationDelay","emailPollMs","emailFillDelay","signupFillDelay","signupSubmitDelay","signupButtonPollMs","signupButtonTimeoutMs","otpSubmitDelay"]) {
  $("#" + key).addEventListener("input", async e => {
    currentSettings[key] = Number(e.target.value);
    $("#" + key + "Out").textContent = currentSettings[key];
    try { await send("updateSettings", {settings:{[key]:currentSettings[key]}}); } catch {}
  });
}

$("#reset").addEventListener("click", async () => {
  try {
    const result = await send("resetSettings");
    currentSettings = {...DEFAULTS, ...(result.settings || {})};
  } catch {
    currentSettings = {...DEFAULTS};
  }
  updateInputs();
  await refresh();
});

refresh();

$("#closeIncognito").addEventListener("click", async () => {
  const status = $("#closeIncognitoStatus");
  const button = $("#closeIncognito");
  button.disabled = true;
  status.textContent = "Fermeture des fenêtres privées…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "wmph",
      action: "closeAllIncognitoWindows"
    });
    if (result?.ok) {
      status.textContent = result.closed
        ? `${result.closed} fenêtre(s) privée(s) fermée(s).`
        : "Aucune fenêtre privée à fermer.";
    } else {
      status.textContent = "Impossible de fermer les fenêtres privées.";
    }
  } catch (error) {
    status.textContent = "Erreur lors de la fermeture.";
  } finally {
    button.disabled = false;
  }
});

async function refreshMarketStats(){try{const d=await chrome.storage.local.get("wmph_market_cache"),e=Object.values(d.wmph_market_cache||{}),n=Date.now(),fresh=e.filter(x=>x?.average!=null&&n-(x.updatedAt||0)<90*60*1000).length;document.querySelector("#marketStats").textContent=e.length?fresh+" prix à jour · "+e.length+" cartes en cache":"Aucun prix en cache"}catch{document.querySelector("#marketStats").textContent="Cache indisponible"}}
document.querySelector("#clearMarketCache").addEventListener("click",async()=>{const b=document.querySelector("#clearMarketCache");b.disabled=true;try{await chrome.storage.local.remove("wmph_market_cache");const t=await activeTab();if(t?.id)await chrome.tabs.sendMessage(t.id,{type:"wmph",action:"marketCacheCleared"}).catch(()=>{});document.querySelector("#marketStats").textContent="Cache vidé"}finally{b.disabled=false}});refreshMarketStats();


const tradeTargetInput=document.querySelector("#tradeTarget");
const tradeStartButton=document.querySelector("#tradeStart");
const tradeStatusBox=document.querySelector("#tradeStatus");
let tradeUiError="";
chrome.storage.local.get("wmph_trade_target").then(data=>{if(tradeTargetInput)tradeTargetInput.value=data.wmph_trade_target||"";});
tradeTargetInput?.addEventListener("input",()=>{tradeUiError="";});
async function refreshTradeUi(){try{const tab=await activeTab();if(!tab?.id)return;const s=await chrome.tabs.sendMessage(tab.id,{type:"wmph",action:"tradeState"});tradeStatusBox.textContent=tradeUiError||s.status||"Prêt.";tradeStartButton.disabled=!!s.busy;tradeTargetInput.disabled=!!s.busy;}catch{tradeStatusBox.textContent="Ouvre le popup depuis l’onglet WikiMasters du compte secondaire.";}}
tradeStartButton?.addEventListener("click",async()=>{tradeUiError="";const username=tradeTargetInput.value.trim();if(!username){tradeUiError="Renseigne le pseudo exact du compte principal.";tradeStatusBox.textContent=tradeUiError;return;}await chrome.storage.local.set({wmph_trade_target:username});try{const tab=await activeTab();const r=await chrome.tabs.sendMessage(tab.id,{type:"wmph",action:"tradeStart",username});if(r?.ok===false)throw new Error(r.error);await refreshTradeUi();}catch(e){tradeUiError=e.message||String(e);tradeStatusBox.textContent=tradeUiError;}});
refreshTradeUi();setInterval(refreshTradeUi,1000);
