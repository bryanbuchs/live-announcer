const DEBUG_PREFIX = '[live-announcer]';
const MESSAGE_TYPE_GET_DOMAIN_STATE = 'liveAnnouncer:getDomainState';
const MESSAGE_TYPE_SET_ENABLED = 'liveAnnouncer:setEnabled';
const IMPLICIT_LIVE_ROLE_TO_POLITENESS = {
  alert: 'assertive',
  status: 'polite',
  log: 'polite',
  timer: 'off',
  marquee: 'off'
};
const TRACKED_REGION_SELECTOR = [
  '[aria-live]',
  '[role="alert"]',
  '[role="status"]',
  '[role="log"]',
  '[role="timer"]',
  '[role="marquee"]'
].join(', ');
const TOAST_DURATION_MS = 4500;
const ANNOUNCEMENT_SETTLE_MS = 180;
const REGION_MIN_ANNOUNCEMENT_INTERVAL_MS = 900;
const MAX_TOAST_TEXT_LENGTH = 280;
const MAX_STACKED_TOASTS = 6;
const EXTENSION_UI_ATTRIBUTE = 'data-live-announcer-ui';
const observerState = {
  enabled: false,
  started: false,
  mutationObserver: null,
  trackedRegions: new Set(),
  lastTextByRegion: new WeakMap(),
  lastAnnouncementTimeByRegion: new WeakMap(),
  pendingAnnouncementTimerByRegion: new Map(),
  regionLabelByElement: new WeakMap(),
  nextRegionIndex: 1,
  toastContainer: null
};

function isExpectedMessagingError(error) {
  return (
    typeof error?.message === 'string' &&
    (
      error.message.includes('Could not establish connection') ||
      error.message.includes('The message port closed before a response was received')
    )
  );
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function getRoleValue(element) {
  const role = element.getAttribute('role');
  return role ? role.trim().toLowerCase() : '';
}

function getAriaLiveValue(element) {
  const liveValue = element.getAttribute('aria-live');
  return liveValue ? liveValue.trim().toLowerCase() : '';
}

function getEffectivePoliteness(element) {
  const explicitLiveValue = getAriaLiveValue(element);

  if (explicitLiveValue) {
    return explicitLiveValue;
  }

  const role = getRoleValue(element);
  return IMPLICIT_LIVE_ROLE_TO_POLITENESS[role] ?? '';
}

function isLiveRegionElement(element) {
  return Boolean(getEffectivePoliteness(element));
}

function getRegionText(regionElement) {
  return normalizeText(regionElement.textContent ?? '');
}

function getOrCreateRegionLabel(regionElement) {
  const existingLabel = observerState.regionLabelByElement.get(regionElement);

  if (existingLabel) {
    return existingLabel;
  }

  const explicitId = regionElement.getAttribute('id');
  const label = explicitId
    ? `#${explicitId}`
    : `region-${observerState.nextRegionIndex++}`;

  observerState.regionLabelByElement.set(regionElement, label);
  return label;
}

function isExtensionUiNode(node) {
  if (node instanceof Element) {
    return Boolean(node.closest(`[${EXTENSION_UI_ATTRIBUTE}="true"]`));
  }

  if (node instanceof CharacterData && node.parentElement) {
    return Boolean(node.parentElement.closest(`[${EXTENSION_UI_ATTRIBUTE}="true"]`));
  }

  return false;
}

function getToastContainer() {
  if (observerState.toastContainer?.isConnected) {
    return observerState.toastContainer;
  }

  const containerElement = document.createElement('section');
  containerElement.className = 'live-announcer-toast-container';
  containerElement.setAttribute(EXTENSION_UI_ATTRIBUTE, 'true');
  containerElement.setAttribute('aria-label', 'ARIA live announcements');
  document.documentElement.append(containerElement);
  observerState.toastContainer = containerElement;
  return containerElement;
}

function renderToast(messageText, politeness) {
  if (!observerState.enabled) {
    return;
  }

  const toastContainer = getToastContainer();
  const toastElement = document.createElement('article');
  toastElement.className = 'live-announcer-toast';
  toastElement.dataset.politeness = politeness;
  toastElement.setAttribute(EXTENSION_UI_ATTRIBUTE, 'true');

  const headerRowElement = document.createElement('header');
  headerRowElement.className = 'live-announcer-toast-header';

  const headerElement = document.createElement('p');
  headerElement.className = 'live-announcer-toast-label';
  headerElement.textContent = `aria-live (${politeness})`;

  const dismissButtonElement = document.createElement('button');
  dismissButtonElement.className = 'live-announcer-toast-dismiss';
  dismissButtonElement.type = 'button';
  dismissButtonElement.textContent = 'Dismiss';
  dismissButtonElement.setAttribute('aria-label', 'Dismiss live announcement');

  const bodyElement = document.createElement('p');
  bodyElement.className = 'live-announcer-toast-text';
  bodyElement.textContent = messageText.slice(0, MAX_TOAST_TEXT_LENGTH);

  headerRowElement.append(headerElement, dismissButtonElement);
  toastElement.append(headerRowElement, bodyElement);
  toastContainer.prepend(toastElement);

  while (toastContainer.children.length > MAX_STACKED_TOASTS) {
    toastContainer.lastElementChild?.remove();
  }

  const autoDismissTimer = window.setTimeout(() => {
    toastElement.remove();
  }, TOAST_DURATION_MS);

  dismissButtonElement.addEventListener('click', () => {
    window.clearTimeout(autoDismissTimer);
    toastElement.remove();
  });
}

function announceRegionUpdate(regionElement) {
  if (isExtensionUiNode(regionElement)) {
    return;
  }

  if (!observerState.trackedRegions.has(regionElement)) {
    observerState.trackedRegions.add(regionElement);
  }

  const politeness = getEffectivePoliteness(regionElement);

  if (!politeness || politeness === 'off') {
    return;
  }

  const normalizedText = getRegionText(regionElement);

  if (!normalizedText) {
    return;
  }

  const previousText = observerState.lastTextByRegion.get(regionElement) ?? '';

  if (previousText === normalizedText) {
    return;
  }

  const currentTime = Date.now();
  const lastAnnouncementTime =
    observerState.lastAnnouncementTimeByRegion.get(regionElement) ?? 0;

  if (
    currentTime - lastAnnouncementTime <
    REGION_MIN_ANNOUNCEMENT_INTERVAL_MS
  ) {
    observerState.lastTextByRegion.set(regionElement, normalizedText);
    return;
  }

  observerState.lastAnnouncementTimeByRegion.set(regionElement, currentTime);
  observerState.lastTextByRegion.set(regionElement, normalizedText);
  const regionLabel = getOrCreateRegionLabel(regionElement);
  const toastText = `${regionLabel}: ${normalizedText}`;
  renderToast(toastText, politeness);
}

function scheduleRegionAnnouncement(regionElement) {
  if (isExtensionUiNode(regionElement)) {
    return;
  }

  const existingTimer =
    observerState.pendingAnnouncementTimerByRegion.get(regionElement);

  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const scheduledTimer = window.setTimeout(() => {
    observerState.pendingAnnouncementTimerByRegion.delete(regionElement);
    announceRegionUpdate(regionElement);
  }, ANNOUNCEMENT_SETTLE_MS);

  observerState.pendingAnnouncementTimerByRegion.set(
    regionElement,
    scheduledTimer
  );
}

function trackRegion(regionElement) {
  if (isExtensionUiNode(regionElement)) {
    return;
  }

  if (observerState.trackedRegions.has(regionElement)) {
    return;
  }

  observerState.trackedRegions.add(regionElement);
  observerState.lastTextByRegion.set(regionElement, getRegionText(regionElement));
}

function untrackRegion(regionElement) {
  const pendingTimer = observerState.pendingAnnouncementTimerByRegion.get(regionElement);

  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    observerState.pendingAnnouncementTimerByRegion.delete(regionElement);
  }

  observerState.trackedRegions.delete(regionElement);
}

function scanAndTrackRegions(rootNode) {
  if (!(rootNode instanceof Element || rootNode instanceof Document)) {
    return;
  }

  if (rootNode instanceof Element && isExtensionUiNode(rootNode)) {
    return;
  }

  if (rootNode instanceof Element && isLiveRegionElement(rootNode)) {
    trackRegion(rootNode);
  }

  rootNode
    .querySelectorAll(TRACKED_REGION_SELECTOR)
    .forEach((element) => {
      if (!isExtensionUiNode(element)) {
        trackRegion(element);
      }
    });
}

function findClosestLiveRegion(node) {
  if (isExtensionUiNode(node)) {
    return null;
  }

  if (node instanceof Element) {
    const regionElement = node.closest(TRACKED_REGION_SELECTOR);
    return regionElement && !isExtensionUiNode(regionElement)
      ? regionElement
      : null;
  }

  if (node instanceof CharacterData && node.parentElement) {
    const regionElement =
      node.parentElement.closest(TRACKED_REGION_SELECTOR);
    return regionElement && !isExtensionUiNode(regionElement)
      ? regionElement
      : null;
  }

  return null;
}

function handleAttributeMutation(mutationRecord) {
  if (!(mutationRecord.target instanceof Element)) {
    return;
  }

  const targetElement = mutationRecord.target;

  if (isExtensionUiNode(targetElement)) {
    return;
  }

  if (isLiveRegionElement(targetElement)) {
    trackRegion(targetElement);
    scheduleRegionAnnouncement(targetElement);
    return;
  }

  untrackRegion(targetElement);
}

function handleChildListMutation(mutationRecord) {
  mutationRecord.addedNodes.forEach((addedNode) => {
    scanAndTrackRegions(addedNode);
  });

  mutationRecord.removedNodes.forEach((removedNode) => {
    if (!(removedNode instanceof Element)) {
      return;
    }

    if (observerState.trackedRegions.has(removedNode)) {
      untrackRegion(removedNode);
    }

    removedNode
      .querySelectorAll(TRACKED_REGION_SELECTOR)
      .forEach((regionElement) => untrackRegion(regionElement));
  });

  const regionElement = findClosestLiveRegion(mutationRecord.target);

  if (regionElement) {
    scheduleRegionAnnouncement(regionElement);
  }
}

function handleMutationRecords(mutationRecords) {
  mutationRecords.forEach((mutationRecord) => {
    if (mutationRecord.type === 'attributes') {
      handleAttributeMutation(mutationRecord);
      return;
    }

    if (mutationRecord.type === 'childList' || mutationRecord.type === 'characterData') {
      handleChildListMutation(mutationRecord);
    }
  });
}

function clearPendingAnnouncementTimers() {
  observerState.pendingAnnouncementTimerByRegion.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  observerState.pendingAnnouncementTimerByRegion = new Map();
}

function removeToastContainer() {
  if (observerState.toastContainer?.isConnected) {
    observerState.toastContainer.remove();
  }

  observerState.toastContainer = null;
}

function resetObserverTracking() {
  observerState.trackedRegions = new Set();
  observerState.lastTextByRegion = new WeakMap();
  observerState.lastAnnouncementTimeByRegion = new WeakMap();
  observerState.regionLabelByElement = new WeakMap();
  observerState.nextRegionIndex = 1;
}

function startObserver() {
  if (observerState.started || !observerState.enabled) {
    return;
  }

  observerState.started = true;
  scanAndTrackRegions(document);

  observerState.mutationObserver = new MutationObserver(handleMutationRecords);
  observerState.mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-live', 'role']
  });

  console.info(
    `${DEBUG_PREFIX} watching ${observerState.trackedRegions.size} live region(s) in main document`
  );
}

function stopObserver() {
  if (observerState.mutationObserver) {
    observerState.mutationObserver.disconnect();
    observerState.mutationObserver = null;
  }

  clearPendingAnnouncementTimers();
  removeToastContainer();
  resetObserverTracking();
  observerState.started = false;
}

function setExtensionEnabled(nextEnabled) {
  observerState.enabled = Boolean(nextEnabled);

  if (observerState.enabled) {
    startObserver();
    return;
  }

  stopObserver();
}

function requestInitialEnabledState() {
  return browser.runtime
    .sendMessage({
      type: MESSAGE_TYPE_GET_DOMAIN_STATE
    })
    .then((response) => {
      const enabled = Boolean(response?.enabled);
      setExtensionEnabled(enabled);
      console.info(`${DEBUG_PREFIX} domain state initialized: ${enabled ? 'on' : 'off'}`);
    })
    .catch((error) => {
      if (!isExpectedMessagingError(error)) {
        console.error(`${DEBUG_PREFIX} failed to read domain state`, error);
      }

      setExtensionEnabled(false);
    });
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MESSAGE_TYPE_SET_ENABLED) {
    return undefined;
  }

  setExtensionEnabled(Boolean(message.enabled));
  return Promise.resolve({ ok: true });
});

requestInitialEnabledState();
