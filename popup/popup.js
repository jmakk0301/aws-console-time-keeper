/**
 * Popup Script - AWS Console Time Keeper
 *
 * Handles UI interactions, communicates with content script and service worker.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // DOM Elements
  // ---------------------------------------------------------------------------

  var $serviceBadge = document.getElementById("service-badge");
  var $emptyState = document.getElementById("empty-state");
  var $timeDisplay = document.getElementById("time-display");
  var $startTime = document.getElementById("start-time");
  var $endTime = document.getElementById("end-time");
  var $duration = document.getElementById("duration");
  var $source = document.getElementById("source");
  var $btnCapture = document.getElementById("btn-capture");
  var $btnApply = document.getElementById("btn-apply");
  var $btnClear = document.getElementById("btn-clear");
  var $manualStart = document.getElementById("manual-start");
  var $manualEnd = document.getElementById("manual-end");
  var $btnManualSave = document.getElementById("btn-manual-save");
  var $historyCount = document.getElementById("history-count");
  var $historyList = document.getElementById("history-list");
  var $toast = document.getElementById("toast");

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function formatDateTime(epochMs) {
    if (!epochMs) return "--";
    var d = new Date(epochMs);
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function formatDuration(startMs, endMs) {
    if (!startMs || !endMs) return "--";
    var diff = Math.abs(endMs - startMs);
    var hours = Math.floor(diff / 3600000);
    var minutes = Math.floor((diff % 3600000) / 60000);
    var seconds = Math.floor((diff % 60000) / 1000);
    var parts = [];
    if (hours > 0) parts.push(hours + "h");
    if (minutes > 0) parts.push(minutes + "m");
    if (seconds > 0 || parts.length === 0) parts.push(seconds + "s");
    return parts.join(" ");
  }

  function formatRelativeTime(epochMs) {
    if (!epochMs) return "";
    var diff = Date.now() - epochMs;
    var minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    return days + "d ago";
  }

  var toastTimer = null;
  function showToast(message, type) {
    if (toastTimer) clearTimeout(toastTimer);
    $toast.textContent = message;
    $toast.className = "toast " + type;
    toastTimer = setTimeout(function () {
      $toast.classList.add("hidden");
    }, 2000);
  }

  function toLocalDatetimeString(epochMs) {
    var d = new Date(epochMs);
    // Format: YYYY-MM-DDTHH:MM:SS for datetime-local input
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return (
      d.getFullYear() + "-" +
      pad(d.getMonth() + 1) + "-" +
      pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" +
      pad(d.getSeconds())
    );
  }

  // ---------------------------------------------------------------------------
  // Service Detection
  // ---------------------------------------------------------------------------

  var serviceNames = {
    "cloudwatch-metrics": "CW Metrics",
    "cloudwatch-logs-insights": "CW Logs Insights",
    "cloudwatch-generic": "CloudWatch",
    "cloudwatch-other": "CW (limited)",
    "xray": "X-Ray",
    "unknown": "Unsupported",
    "not-aws": "Not AWS",
  };

  async function detectCurrentService() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) return "not-aws";
      var response = await chrome.tabs.sendMessage(tabs[0].id, { action: "detect-service" });
      return response ? response.service : "not-aws";
    } catch (e) {
      return "not-aws";
    }
  }

  function updateServiceBadge(service) {
    var name = serviceNames[service] || service;
    $serviceBadge.textContent = name;
    var supported = ["cloudwatch-metrics", "cloudwatch-logs-insights", "cloudwatch-generic", "xray"];
    if (supported.indexOf(service) >= 0) {
      $serviceBadge.classList.add("active");
    } else {
      $serviceBadge.classList.remove("active");
    }
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  function displayTimeRange(tr) {
    if (!tr) {
      $emptyState.classList.remove("hidden");
      $timeDisplay.classList.add("hidden");
      return;
    }

    $emptyState.classList.add("hidden");
    $timeDisplay.classList.remove("hidden");
    $startTime.textContent = formatDateTime(tr.start);
    $endTime.textContent = formatDateTime(tr.end);
    $duration.textContent = formatDuration(tr.start, tr.end);
    $source.textContent = tr.source || "Manual";

    // Pre-fill manual inputs
    $manualStart.value = toLocalDatetimeString(tr.start);
    $manualEnd.value = toLocalDatetimeString(tr.end);
  }

  async function refreshDisplay() {
    var response = await chrome.runtime.sendMessage({ action: "get-current" });
    displayTimeRange(response ? response.timeRange : null);
    await refreshHistory();
  }

  async function refreshHistory() {
    var response = await chrome.runtime.sendMessage({ action: "get-history" });
    var history = response ? response.history : [];
    $historyCount.textContent = history.length;

    if (history.length === 0) {
      $historyList.innerHTML = '<div class="empty-state-small">No history yet.</div>';
      return;
    }

    $historyList.innerHTML = "";
    history.forEach(function (item, index) {
      var div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML =
        '<div class="hi-source">' + escapeHtml(item.source || "Manual") + "</div>" +
        '<div class="hi-time">' + escapeHtml(formatDateTime(item.start)) + " - " + escapeHtml(formatDateTime(item.end)) + "</div>" +
        '<div class="hi-captured">' + escapeHtml(formatRelativeTime(item.capturedAt)) + " | " + escapeHtml(formatDuration(item.start, item.end)) + "</div>";
      div.addEventListener("click", function () {
        restoreFromHistory(index);
      });
      $historyList.appendChild(div);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function captureTime() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) {
        showToast("No active tab found", "error");
        return;
      }

      var response = await chrome.tabs.sendMessage(tabs[0].id, { action: "capture-time" });

      if (!response) {
        showToast("Cannot communicate with page. Reload and retry.", "error");
        return;
      }

      if (response.success) {
        await chrome.runtime.sendMessage({
          action: "save-time-range",
          timeRange: response.timeRange,
        });
        showToast("Time range captured!", "success");
        await refreshDisplay();
      } else {
        showToast(response.error || "Capture failed", "error");
      }
    } catch (e) {
      showToast("Cannot communicate with page. Reload and retry.", "error");
    }
  }

  async function applyTime() {
    try {
      var currentResp = await chrome.runtime.sendMessage({ action: "get-current" });
      var tr = currentResp ? currentResp.timeRange : null;

      if (!tr) {
        showToast("No time range to apply", "error");
        return;
      }

      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) {
        showToast("No active tab found", "error");
        return;
      }

      var response = await chrome.tabs.sendMessage(tabs[0].id, {
        action: "apply-time",
        timeRange: tr,
      });

      if (!response) {
        showToast("Cannot communicate with page. Reload and retry.", "error");
        return;
      }

      if (response.success) {
        showToast("Time range applied!", "success");
      } else {
        showToast(response.error || "Apply failed", "error");
      }
    } catch (e) {
      showToast("Cannot communicate with page. Reload and retry.", "error");
    }
  }

  async function clearAll() {
    await chrome.runtime.sendMessage({ action: "clear-all" });
    showToast("Cleared", "success");
    await refreshDisplay();
  }

  async function saveManualRange() {
    var startVal = $manualStart.value;
    var endVal = $manualEnd.value;

    if (!startVal || !endVal) {
      showToast("Please fill in both start and end times", "error");
      return;
    }

    var startMs = new Date(startVal).getTime();
    var endMs = new Date(endVal).getTime();

    if (isNaN(startMs) || isNaN(endMs)) {
      showToast("Invalid date format", "error");
      return;
    }

    if (startMs >= endMs) {
      showToast("Start must be before end", "error");
      return;
    }

    var timeRange = {
      start: startMs,
      end: endMs,
      source: "Manual",
      capturedAt: Date.now(),
    };

    await chrome.runtime.sendMessage({
      action: "save-time-range",
      timeRange: timeRange,
    });

    showToast("Manual range saved!", "success");
    await refreshDisplay();
  }

  async function restoreFromHistory(index) {
    var response = await chrome.runtime.sendMessage({
      action: "restore-from-history",
      index: index,
    });

    if (response && response.success) {
      showToast("Restored from history", "success");
      await refreshDisplay();
    } else {
      showToast("Failed to restore", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------

  $btnCapture.addEventListener("click", captureTime);
  $btnApply.addEventListener("click", applyTime);
  $btnClear.addEventListener("click", clearAll);
  $btnManualSave.addEventListener("click", saveManualRange);

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  (async function init() {
    var service = await detectCurrentService();
    updateServiceBadge(service);
    await refreshDisplay();
  })();
})();
