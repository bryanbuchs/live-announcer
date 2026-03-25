const DOMAIN_SETTINGS_STORAGE_KEY = "enabledHostnamesByDomain";
const MESSAGE_TYPE_GET_DOMAIN_STATE = "liveAnnouncer:getDomainState";
const MESSAGE_TYPE_SET_ENABLED = "liveAnnouncer:setEnabled";
const ACTION_ICON_PATHS = {
  enabled: {
    16: "icon-enbabled.svg",
    32: "icon-enbabled.svg",
  },
  disabled: {
    16: "icon-disabled.svg",
    32: "icon-disabled.svg",
  },
};

/**
 * getHostnameFromUrl
 * parses a URL string and returns a normalized hostname key for persistence.
 * only http/https URLs are accepted; unsupported protocols and invalid values
 * return an empty string so callers can treat the tab as non-actionable.
 */
function getHostnameFromUrl(urlValue) {
  if (typeof urlValue !== "string" || !urlValue) {
    return "";
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return "";
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return "";
  }

  return parsedUrl.hostname.toLowerCase();
}

/**
 * isExpectedMessagingError
 * identifies known message-send failures that occur when a tab does not currently
 * host the content script connection.
 * these expected failures are ignored to avoid noisy error reporting.
 */
function isExpectedMessagingError(error) {
  return (
    typeof error?.message === "string" && error.message.includes("Could not establish connection")
  );
}

/**
 * readDomainSettings
 * reads persisted hostname flags from extension local storage and guarantees
 * an object-shaped return value for downstream access.
 * invalid or missing stored data is normalized to an empty object.
 */
async function readDomainSettings() {
  const storedValues = await browser.storage.local.get(DOMAIN_SETTINGS_STORAGE_KEY);
  const rawSettings = storedValues[DOMAIN_SETTINGS_STORAGE_KEY];

  if (typeof rawSettings !== "object" || rawSettings === null || Array.isArray(rawSettings)) {
    return {};
  }

  return rawSettings;
}

/**
 * writeDomainSettings
 * persists the full hostname settings object into extension local storage
 * under the shared domain settings key.
 */
async function writeDomainSettings(domainSettings) {
  await browser.storage.local.set({
    [DOMAIN_SETTINGS_STORAGE_KEY]: domainSettings,
  });
}

/**
 * isDomainEnabled
 * returns whether a hostname is currently enabled in persisted settings.
 * empty hostnames always resolve to false.
 */
async function isDomainEnabled(hostname) {
  if (!hostname) {
    return false;
  }

  const domainSettings = await readDomainSettings();
  return Boolean(domainSettings[hostname]);
}

/**
 * setDomainEnabled
 * updates persisted state for a single hostname.
 * enabled hostnames are stored as true, and disabled hostnames are removed
 * so missing entries continue to represent the default-off state.
 */
async function setDomainEnabled(hostname, isEnabled) {
  if (!hostname) {
    return;
  }

  const domainSettings = await readDomainSettings();

  if (isEnabled) {
    domainSettings[hostname] = true;
  } else {
    delete domainSettings[hostname];
  }

  await writeDomainSettings(domainSettings);
}

/**
 * setActionStateForTab
 * sets toolbar action availability, icon, and title for an actionable tab
 * using the current enabled state of that tab's hostname.
 */
async function setActionStateForTab(tabId, hostname, isEnabled) {
  await browser.action.enable(tabId);
  await browser.action.setIcon({
    tabId,
    path: isEnabled ? ACTION_ICON_PATHS.enabled : ACTION_ICON_PATHS.disabled,
  });
  await browser.action.setTitle({
    tabId,
    title: isEnabled ? `Live Announcer: on for ${hostname}` : `Live Announcer: off for ${hostname}`,
  });
}

/**
 * setActionUnavailableForTab
 * disables the toolbar action for tabs that cannot be mapped to an actionable
 * hostname (for example non-http(s) pages) and applies unavailable UI metadata.
 */
async function setActionUnavailableForTab(tabId) {
  await browser.action.disable(tabId);
  await browser.action.setIcon({
    tabId,
    path: ACTION_ICON_PATHS.disabled,
  });
  await browser.action.setTitle({
    tabId,
    title: "Live Announcer: unavailable on this page",
  });
}

/**
 * updateActionForTab
 * recomputes and applies toolbar action state for one tab by deriving its hostname
 * and resolving whether that hostname is enabled.
 * non-actionable tabs receive the unavailable action state.
 */
async function updateActionForTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) {
    return;
  }

  const hostname = getHostnameFromUrl(tab.url);

  if (!hostname) {
    await setActionUnavailableForTab(tab.id);
    return;
  }

  const isEnabled = await isDomainEnabled(hostname);
  await setActionStateForTab(tab.id, hostname, isEnabled);
}

/**
 * syncActionForHostname
 * refreshes toolbar action state for all open tabs that share the same hostname.
 * this keeps icon/title state synchronized across multiple tabs of one domain.
 */
async function syncActionForHostname(hostname) {
  const allTabs = await browser.tabs.query({});
  const targetTabs = allTabs.filter((tab) => getHostnameFromUrl(tab.url) === hostname);
  await Promise.all(targetTabs.map((tab) => updateActionForTab(tab)));
}

/**
 * syncActionForAllTabs
 * refreshes toolbar action state for every open tab.
 * this is used during initialization so existing tabs immediately reflect persisted state.
 */
async function syncActionForAllTabs() {
  const allTabs = await browser.tabs.query({});
  await Promise.all(allTabs.map((tab) => updateActionForTab(tab)));
}

/**
 * notifyDomainTabs
 * sends a runtime toggle message to all tabs matching a hostname so content scripts
 * can apply enabled-state changes immediately without reload.
 * expected messaging disconnect errors are suppressed per tab.
 */
async function notifyDomainTabs(hostname, isEnabled) {
  const allTabs = await browser.tabs.query({});
  const targetTabs = allTabs.filter(
    (tab) => Number.isInteger(tab.id) && getHostnameFromUrl(tab.url) === hostname,
  );

  await Promise.all(
    targetTabs.map((tab) =>
      browser.tabs
        .sendMessage(tab.id, {
          type: MESSAGE_TYPE_SET_ENABLED,
          enabled: isEnabled,
        })
        .catch((error) => {
          if (!isExpectedMessagingError(error)) {
            console.error(`Live Announcer failed to notify tab ${tab.id}`, error);
          }
        }),
    ),
  );
}

/**
 * handleActionClick
 * handles toolbar icon clicks by toggling the active tab's hostname state,
 * persisting the new value, syncing toolbar UI across matching tabs,
 * and notifying matching content scripts about the updated state.
 */
async function handleActionClick(tab) {
  if (!tab || !Number.isInteger(tab.id)) {
    return;
  }

  const hostname = getHostnameFromUrl(tab.url);

  if (!hostname) {
    return;
  }

  const currentlyEnabled = await isDomainEnabled(hostname);
  const nextEnabled = !currentlyEnabled;
  await setDomainEnabled(hostname, nextEnabled);
  await Promise.all([syncActionForHostname(hostname), notifyDomainTabs(hostname, nextEnabled)]);
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== MESSAGE_TYPE_GET_DOMAIN_STATE) {
    return undefined;
  }

  const senderUrl = sender.tab?.url ?? sender.url ?? "";
  const hostname = getHostnameFromUrl(senderUrl);
  return isDomainEnabled(hostname).then((enabled) => ({
    enabled,
    hostname,
  }));
});

browser.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((error) => {
    console.error("Live Announcer failed to handle action click", error);
  });
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs
    .get(tabId)
    .then((tab) => updateActionForTab(tab))
    .catch((error) => {
      console.error("Live Announcer failed to update action on activate", error);
    });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  updateActionForTab(tab).catch((error) => {
    console.error("Live Announcer failed to update action on tab update", error);
  });
});

browser.tabs.onCreated.addListener((tab) => {
  updateActionForTab(tab).catch((error) => {
    console.error("Live Announcer failed to update action on tab create", error);
  });
});

syncActionForAllTabs().catch((error) => {
  console.error("Live Announcer failed to initialize action state", error);
});
