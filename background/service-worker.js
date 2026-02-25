/**
 * Service Worker - AWS Console Time Keeper
 *
 * Manages chrome.storage.local for time range persistence,
 * updates the extension badge, and handles keyboard shortcuts.
 *
 * Storage schema:
 *   currentTimeRange: { start, end, source, capturedAt, raw? }
 *   timeRangeHistory: [ ...max 5 entries ]
 */
(function () {
  "use strict";

  var MAX_HISTORY = 5;
  var AWS_ORANGE = "#FF9900";

  // ---------------------------------------------------------------------------
  // Storage Operations
  // ---------------------------------------------------------------------------

  async function saveTimeRange(timeRange) {
    var data = await chrome.storage.local.get(["currentTimeRange", "timeRangeHistory"]);
    var history = data.timeRangeHistory || [];

    // Push current to history if it exists
    if (data.currentTimeRange) {
      history.unshift(data.currentTimeRange);
      if (history.length > MAX_HISTORY) {
        history = history.slice(0, MAX_HISTORY);
      }
    }

    await chrome.storage.local.set({
      currentTimeRange: timeRange,
      timeRangeHistory: history,
    });

    updateBadge(true);
    return { success: true };
  }

  async function getCurrentTimeRange() {
    var data = await chrome.storage.local.get("currentTimeRange");
    return data.currentTimeRange || null;
  }

  async function getHistory() {
    var data = await chrome.storage.local.get("timeRangeHistory");
    return data.timeRangeHistory || [];
  }

  async function restoreFromHistory(index) {
    var data = await chrome.storage.local.get(["currentTimeRange", "timeRangeHistory"]);
    var history = data.timeRangeHistory || [];

    if (index < 0 || index >= history.length) {
      return { success: false, error: "Invalid history index" };
    }

    var restored = history.splice(index, 1)[0];

    // Push current to history if it exists
    if (data.currentTimeRange) {
      history.unshift(data.currentTimeRange);
      if (history.length > MAX_HISTORY) {
        history = history.slice(0, MAX_HISTORY);
      }
    }

    await chrome.storage.local.set({
      currentTimeRange: restored,
      timeRangeHistory: history,
    });

    updateBadge(true);
    return { success: true, timeRange: restored };
  }

  async function clearAll() {
    await chrome.storage.local.remove(["currentTimeRange", "timeRangeHistory"]);
    updateBadge(false);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Badge
  // ---------------------------------------------------------------------------

  function updateBadge(hasTimeRange) {
    if (hasTimeRange) {
      chrome.action.setBadgeText({ text: " " });
      chrome.action.setBadgeBackgroundColor({ color: AWS_ORANGE });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  }

  // Initialize badge on startup
  chrome.storage.local.get("currentTimeRange", function (data) {
    updateBadge(!!data.currentTimeRange);
  });

  // ---------------------------------------------------------------------------
  // Message Handler
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    switch (message.action) {
      case "save-time-range":
        saveTimeRange(message.timeRange).then(sendResponse);
        return true;

      case "get-current":
        getCurrentTimeRange().then(function (tr) {
          sendResponse({ timeRange: tr });
        });
        return true;

      case "get-history":
        getHistory().then(function (history) {
          sendResponse({ history: history });
        });
        return true;

      case "restore-from-history":
        restoreFromHistory(message.index).then(sendResponse);
        return true;

      case "clear-all":
        clearAll().then(sendResponse);
        return true;

      default:
        sendResponse({ error: "Unknown action: " + message.action });
        return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts
  // ---------------------------------------------------------------------------

  chrome.commands.onCommand.addListener(async function (command) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;
    var tab = tabs[0];

    if (command === "capture-time") {
      try {
        var response = await chrome.tabs.sendMessage(tab.id, { action: "capture-time" });
        if (response && response.success) {
          await saveTimeRange(response.timeRange);
        }
      } catch (e) {
        console.warn("[TimeKeeper] Capture shortcut error:", e);
      }
    } else if (command === "apply-time") {
      try {
        var current = await getCurrentTimeRange();
        if (current) {
          await chrome.tabs.sendMessage(tab.id, {
            action: "apply-time",
            timeRange: current,
          });
        }
      } catch (e) {
        console.warn("[TimeKeeper] Apply shortcut error:", e);
      }
    }
  });
})();
