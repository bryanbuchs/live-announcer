const DOMAIN_SETTINGS_STORAGE_KEY = 'enabledHostnamesByDomain';
const MESSAGE_TYPE_GET_DOMAIN_STATE = 'liveAnnouncer:getDomainState';
const MESSAGE_TYPE_SET_ENABLED = 'liveAnnouncer:setEnabled';
const ACTION_ICON_PATHS = {
  enabled: {
    16: 'icon-enbabled.svg',
    32: 'icon-enbabled.svg'
  },
  disabled: {
    16: 'icon-disabled.svg',
    32: 'icon-disabled.svg'
  }
};

function getHostnameFromUrl(urlValue) {
  if (typeof urlValue !== 'string' || !urlValue) {
    return '';
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return '';
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return '';
  }

  return parsedUrl.hostname.toLowerCase();
}

function isExpectedMessagingError(error) {
  return (
    typeof error?.message === 'string' &&
    error.message.includes('Could not establish connection')
  );
}

async function readDomainSettings() {
  const storedValues = await browser.storage.local.get(DOMAIN_SETTINGS_STORAGE_KEY);
  const rawSettings = storedValues[DOMAIN_SETTINGS_STORAGE_KEY];

  if (typeof rawSettings !== 'object' || rawSettings === null || Array.isArray(rawSettings)) {
    return {};
  }

  return rawSettings;
}

async function writeDomainSettings(domainSettings) {
  await browser.storage.local.set({
    [DOMAIN_SETTINGS_STORAGE_KEY]: domainSettings
  });
}

async function isDomainEnabled(hostname) {
  if (!hostname) {
    return false;
  }

  const domainSettings = await readDomainSettings();
  return Boolean(domainSettings[hostname]);
}

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

async function setActionStateForTab(tabId, hostname, isEnabled) {
  await browser.action.enable(tabId);
  await browser.action.setIcon({
    tabId,
    path: isEnabled ? ACTION_ICON_PATHS.enabled : ACTION_ICON_PATHS.disabled
  });
  await browser.action.setTitle({
    tabId,
    title: isEnabled
      ? `Live Announcer: on for ${hostname}`
      : `Live Announcer: off for ${hostname}`
  });
}

async function setActionUnavailableForTab(tabId) {
  await browser.action.disable(tabId);
  await browser.action.setIcon({
    tabId,
    path: ACTION_ICON_PATHS.disabled
  });
  await browser.action.setTitle({
    tabId,
    title: 'Live Announcer: unavailable on this page'
  });
}

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

async function syncActionForHostname(hostname) {
  const allTabs = await browser.tabs.query({});
  const targetTabs = allTabs.filter((tab) => getHostnameFromUrl(tab.url) === hostname);
  await Promise.all(targetTabs.map((tab) => updateActionForTab(tab)));
}

async function syncActionForAllTabs() {
  const allTabs = await browser.tabs.query({});
  await Promise.all(allTabs.map((tab) => updateActionForTab(tab)));
}

async function notifyDomainTabs(hostname, isEnabled) {
  const allTabs = await browser.tabs.query({});
  const targetTabs = allTabs.filter(
    (tab) => Number.isInteger(tab.id) && getHostnameFromUrl(tab.url) === hostname
  );

  await Promise.all(
    targetTabs.map((tab) =>
      browser.tabs
        .sendMessage(tab.id, {
          type: MESSAGE_TYPE_SET_ENABLED,
          enabled: isEnabled
        })
        .catch((error) => {
          if (!isExpectedMessagingError(error)) {
            console.error(`Live Announcer failed to notify tab ${tab.id}`, error);
          }
        })
    )
  );
}

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
  await Promise.all([
    syncActionForHostname(hostname),
    notifyDomainTabs(hostname, nextEnabled)
  ]);
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== MESSAGE_TYPE_GET_DOMAIN_STATE) {
    return undefined;
  }

  const senderUrl = sender.tab?.url ?? sender.url ?? '';
  const hostname = getHostnameFromUrl(senderUrl);
  return isDomainEnabled(hostname).then((enabled) => ({
    enabled,
    hostname
  }));
});

browser.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((error) => {
    console.error('Live Announcer failed to handle action click', error);
  });
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs
    .get(tabId)
    .then((tab) => updateActionForTab(tab))
    .catch((error) => {
      console.error('Live Announcer failed to update action on activate', error);
    });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') {
    return;
  }

  updateActionForTab(tab).catch((error) => {
    console.error('Live Announcer failed to update action on tab update', error);
  });
});

browser.tabs.onCreated.addListener((tab) => {
  updateActionForTab(tab).catch((error) => {
    console.error('Live Announcer failed to update action on tab create', error);
  });
});

syncActionForAllTabs().catch((error) => {
  console.error('Live Announcer failed to initialize action state', error);
});
