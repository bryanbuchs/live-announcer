const MESSAGE_TYPE_GET_DOMAIN_STATE = "liveAnnouncer:getDomainState";
const MESSAGE_TYPE_SET_ENABLED = "liveAnnouncer:setEnabled";
const IMPLICIT_LIVE_ROLE_TO_POLITENESS = {
  alert: "assertive",
  status: "polite",
  log: "polite",
  timer: "off",
  marquee: "off",
};
const TRACKED_REGION_SELECTOR = [
  "[aria-live]",
  '[role="alert"]',
  '[role="status"]',
  '[role="log"]',
  '[role="timer"]',
  '[role="marquee"]',
].join(", ");
const TOAST_DURATION_MS = 4500;
const ANNOUNCEMENT_SETTLE_MS = 180;
const REGION_MIN_ANNOUNCEMENT_INTERVAL_MS = 900;
const MAX_TOAST_TEXT_LENGTH = 280;
const MAX_STACKED_TOASTS = 6;
const EXTENSION_UI_ATTRIBUTE = "data-live-announcer-ui";
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
  toastContainer: null,
};


/**
 * isExpectedMessagingError
 * checks whether a runtime messaging error matches known, expected disconnect cases
 * that happen when the content script cannot reach the background script.
 * these cases can occur during extension reloads or transient browser states.
 * matching errors are treated as non-actionable and skipped from error logging.
 */
function isExpectedMessagingError(error) {
  return (
    typeof error?.message === "string" &&
    (error.message.includes("Could not establish connection") ||
      error.message.includes("The message port closed before a response was received"))
  );
}

/**
 * normalizeText
 * converts arbitrary text into a stable comparison format by collapsing repeated
 * whitespace into a single space and trimming outer whitespace.
 * this keeps announcement comparisons consistent across small DOM formatting changes.
 */
function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * getRoleValue
 * reads an element's role attribute and normalizes it for comparison logic.
 * returns a lowercased, trimmed role string, or an empty string when absent.
 */
function getRoleValue(element) {
  const role = element.getAttribute("role");
  return role ? role.trim().toLowerCase() : "";
}

/**
 * getAriaLiveValue
 * reads an element's aria-live attribute and normalizes it for behavior checks.
 * returns a lowercased, trimmed value, or an empty string when the attribute is missing.
 */
function getAriaLiveValue(element) {
  const liveValue = element.getAttribute("aria-live");
  return liveValue ? liveValue.trim().toLowerCase() : "";
}

/**
 * getEffectivePoliteness
 * resolves the final politeness mode for an element by prioritizing explicit
 * aria-live values and falling back to implicit live-region role defaults.
 * returns an empty string when the element is not treated as a live region.
 */
function getEffectivePoliteness(element) {
  const explicitLiveValue = getAriaLiveValue(element);

  if (explicitLiveValue) {
    return explicitLiveValue;
  }

  const role = getRoleValue(element);
  return IMPLICIT_LIVE_ROLE_TO_POLITENESS[role] ?? "";
}

/**
 * isLiveRegionElement
 * determines whether an element participates in live-region tracking by checking
 * if it resolves to any effective politeness value.
 */
function isLiveRegionElement(element) {
  return Boolean(getEffectivePoliteness(element));
}

/**
 * getRegionText
 * extracts and normalizes visible text content from a tracked live-region element.
 * normalization keeps deduplication and rate-limiting comparisons deterministic.
 */
function getRegionText(regionElement) {
  return normalizeText(regionElement.textContent ?? "");
}

/**
 * getOrCreateRegionLabel
 * returns a stable label for a region element used in toast output.
 * prefers an explicit element id and otherwise assigns an incrementing synthetic label.
 * labels are cached per element so repeated announcements keep the same identifier.
 */
function getOrCreateRegionLabel(regionElement) {
  const existingLabel = observerState.regionLabelByElement.get(regionElement);

  if (existingLabel) {
    return existingLabel;
  }

  const explicitId = regionElement.getAttribute("id");
  const label = explicitId ? `#${explicitId}` : `region-${observerState.nextRegionIndex++}`;

  observerState.regionLabelByElement.set(regionElement, label);
  return label;
}

/**
 * isExtensionUiNode
 * checks whether a node belongs to UI elements injected by this extension.
 * this prevents the observer from reacting to its own toast DOM updates.
 */
function isExtensionUiNode(node) {
  if (node instanceof Element) {
    return Boolean(node.closest(`[${EXTENSION_UI_ATTRIBUTE}="true"]`));
  }

  if (node instanceof CharacterData && node.parentElement) {
    return Boolean(node.parentElement.closest(`[${EXTENSION_UI_ATTRIBUTE}="true"]`));
  }

  return false;
}

/**
 * getToastContainer
 * returns the shared toast container element, creating it on first use.
 * the container is attached to the document root and marked so mutation handlers
 * can ignore extension-owned UI nodes.
 */
function getToastContainer() {
  if (observerState.toastContainer?.isConnected) {
    return observerState.toastContainer;
  }

  const containerElement = document.createElement("section");
  containerElement.className = "live-announcer-toast-container";
  containerElement.setAttribute(EXTENSION_UI_ATTRIBUTE, "true");
  containerElement.setAttribute("aria-label", "ARIA live announcements");
  document.documentElement.append(containerElement);
  observerState.toastContainer = containerElement;
  return containerElement;
}

/**
 * renderToast
 * renders one toast announcement with politeness metadata, dismiss controls,
 * and automatic timeout cleanup.
 * while rendering, it also enforces the configured maximum stack size.
 */
function renderToast(messageText, politeness) {
  if (!observerState.enabled) {
    return;
  }

  const toastContainer = getToastContainer();
  const toastElement = document.createElement("article");
  toastElement.className = "live-announcer-toast";
  toastElement.dataset.politeness = politeness;
  toastElement.setAttribute(EXTENSION_UI_ATTRIBUTE, "true");

  const headerRowElement = document.createElement("header");
  headerRowElement.className = "live-announcer-toast-header";

  const headerElement = document.createElement("p");
  headerElement.className = "live-announcer-toast-label";
  headerElement.textContent = `aria-live (${politeness})`;

  const dismissButtonElement = document.createElement("button");
  dismissButtonElement.className = "live-announcer-toast-dismiss";
  dismissButtonElement.type = "button";
  dismissButtonElement.textContent = "Dismiss";
  dismissButtonElement.setAttribute("aria-label", "Dismiss live announcement");

  const bodyElement = document.createElement("p");
  bodyElement.className = "live-announcer-toast-text";
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

  dismissButtonElement.addEventListener("click", () => {
    window.clearTimeout(autoDismissTimer);
    toastElement.remove();
  });
}

/**
 * announceRegionUpdate
 * evaluates a region change and emits a toast only when it passes all filters:
 * not extension UI, live politeness enabled, non-empty text, not a duplicate,
 * and outside the per-region announcement cooldown window.
 */
function announceRegionUpdate(regionElement) {
  if (isExtensionUiNode(regionElement)) {
    return;
  }

  if (!observerState.trackedRegions.has(regionElement)) {
    observerState.trackedRegions.add(regionElement);
  }

  const politeness = getEffectivePoliteness(regionElement);

  if (!politeness || politeness === "off") {
    return;
  }

  const normalizedText = getRegionText(regionElement);

  if (!normalizedText) {
    return;
  }

  const previousText = observerState.lastTextByRegion.get(regionElement) ?? "";

  if (previousText === normalizedText) {
    return;
  }

  const currentTime = Date.now();
  const lastAnnouncementTime = observerState.lastAnnouncementTimeByRegion.get(regionElement) ?? 0;

  if (currentTime - lastAnnouncementTime < REGION_MIN_ANNOUNCEMENT_INTERVAL_MS) {
    observerState.lastTextByRegion.set(regionElement, normalizedText);
    return;
  }

  observerState.lastAnnouncementTimeByRegion.set(regionElement, currentTime);
  observerState.lastTextByRegion.set(regionElement, normalizedText);
  const regionLabel = getOrCreateRegionLabel(regionElement);
  const toastText = `${regionLabel}: ${normalizedText}`;
  renderToast(toastText, politeness);
}

/**
 * scheduleRegionAnnouncement
 * debounces rapid region mutations by resetting any pending timer for the same region
 * and scheduling a delayed announcement evaluation after a short settle period.
 */
function scheduleRegionAnnouncement(regionElement) {
  if (isExtensionUiNode(regionElement)) {
    return;
  }

  const existingTimer = observerState.pendingAnnouncementTimerByRegion.get(regionElement);

  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const scheduledTimer = window.setTimeout(() => {
    observerState.pendingAnnouncementTimerByRegion.delete(regionElement);
    announceRegionUpdate(regionElement);
  }, ANNOUNCEMENT_SETTLE_MS);

  observerState.pendingAnnouncementTimerByRegion.set(regionElement, scheduledTimer);
}

/**
 * trackRegion
 * adds a live region to the tracked set and stores its current normalized text
 * as baseline state so only future text changes can trigger announcements.
 */
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

/**
 * untrackRegion
 * removes a region from active tracking and clears any pending announcement timer
 * associated with that element to prevent stale delayed announcements.
 */
function untrackRegion(regionElement) {
  const pendingTimer = observerState.pendingAnnouncementTimerByRegion.get(regionElement);

  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    observerState.pendingAnnouncementTimerByRegion.delete(regionElement);
  }

  observerState.trackedRegions.delete(regionElement);
}

/**
 * scanAndTrackRegions
 * scans a root node subtree for live regions and registers each match.
 * it supports both full-document scans and incremental scans for newly added nodes.
 */
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

  rootNode.querySelectorAll(TRACKED_REGION_SELECTOR).forEach((element) => {
    if (!isExtensionUiNode(element)) {
      trackRegion(element);
    }
  });
}

/**
 * findClosestLiveRegion
 * finds the nearest ancestor live region for a mutation target node.
 * supports both Element and CharacterData nodes and ignores extension UI trees.
 * returns null when no eligible live region ancestor exists.
 */
function findClosestLiveRegion(node) {
  if (isExtensionUiNode(node)) {
    return null;
  }

  if (node instanceof Element) {
    const regionElement = node.closest(TRACKED_REGION_SELECTOR);
    return regionElement && !isExtensionUiNode(regionElement) ? regionElement : null;
  }

  if (node instanceof CharacterData && node.parentElement) {
    const regionElement = node.parentElement.closest(TRACKED_REGION_SELECTOR);
    return regionElement && !isExtensionUiNode(regionElement) ? regionElement : null;
  }

  return null;
}

/**
 * handleAttributeMutation
 * processes role/aria-live attribute changes by updating tracking membership.
 * when an element becomes a live region it is tracked and scheduled for evaluation;
 * when it no longer qualifies it is removed from tracking.
 */
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

/**
 * handleChildListMutation
 * processes subtree additions/removals to keep region tracking accurate.
 * newly added nodes are scanned for regions, removed nodes are untracked,
 * and the closest affected live region is scheduled for a debounced announcement check.
 */
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

/**
 * handleMutationRecords
 * dispatches MutationObserver records to the appropriate handlers based on type.
 * attribute records flow through attribute-specific logic, while child and character
 * mutations share subtree handling.
 */
function handleMutationRecords(mutationRecords) {
  mutationRecords.forEach((mutationRecord) => {
    if (mutationRecord.type === "attributes") {
      handleAttributeMutation(mutationRecord);
      return;
    }

    if (mutationRecord.type === "childList" || mutationRecord.type === "characterData") {
      handleChildListMutation(mutationRecord);
    }
  });
}

/**
 * clearPendingAnnouncementTimers
 * cancels all outstanding per-region debounce timers and resets timer state storage.
 * this is used when disabling observation to avoid delayed work after shutdown.
 */
function clearPendingAnnouncementTimers() {
  observerState.pendingAnnouncementTimerByRegion.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  observerState.pendingAnnouncementTimerByRegion = new Map();
}

/**
 * removeToastContainer
 * removes the extension toast container from the DOM when present and clears
 * the cached reference so future rendering can recreate it on demand.
 */
function removeToastContainer() {
  if (observerState.toastContainer?.isConnected) {
    observerState.toastContainer.remove();
  }

  observerState.toastContainer = null;
}

/**
 * resetObserverTracking
 * resets all region-tracking collections to their initial empty state.
 * this clears deduplication history and synthetic region labels between enabled sessions.
 */
function resetObserverTracking() {
  observerState.trackedRegions = new Set();
  observerState.lastTextByRegion = new WeakMap();
  observerState.lastAnnouncementTimeByRegion = new WeakMap();
  observerState.regionLabelByElement = new WeakMap();
  observerState.nextRegionIndex = 1;
}

/**
 * startObserver
 * starts live-region monitoring when the extension is enabled and not already running.
 * performs an initial region scan, then attaches a MutationObserver for ongoing updates.
 */
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
    attributeFilter: ["aria-live", "role"],
  });
}

/**
 * stopObserver
 * fully shuts down observation by disconnecting the MutationObserver, clearing timers,
 * removing extension UI, resetting tracking state, and marking the observer as stopped.
 */
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

/**
 * setExtensionEnabled
 * applies the requested enabled state and transitions observer lifecycle accordingly.
 * enabling starts monitoring immediately, while disabling performs full observer teardown.
 */
function setExtensionEnabled(nextEnabled) {
  observerState.enabled = Boolean(nextEnabled);

  if (observerState.enabled) {
    startObserver();
    return;
  }

  stopObserver();
}

/**
 * requestInitialEnabledState
 * asks the background script whether this hostname is enabled and applies that state.
 * on expected transient messaging errors, it suppresses noisy logs; on other failures,
 * it logs an error and falls back to disabled behavior.
 */
function requestInitialEnabledState() {
  return browser.runtime
    .sendMessage({
      type: MESSAGE_TYPE_GET_DOMAIN_STATE,
    })
    .then((response) => {
      const enabled = Boolean(response?.enabled);
      setExtensionEnabled(enabled);
    })
    .catch((error) => {
      if (!isExpectedMessagingError(error)) {
        console.error("Live Announcer failed to read domain state", error);
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
