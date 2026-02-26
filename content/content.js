/**
 * Content Script - AWS Console Time Keeper
 *
 * Detects AWS service from URL, parses time ranges, and injects time ranges
 * back into URLs for supported services.
 *
 * Supported services:
 *  - CloudWatch Metrics (hash-based JSURL graph param)
 *  - CloudWatch Logs Insights (queryDetail param with $-encoded JSURL)
 *  - CloudWatch Generic (hash-based JSURL state with timeRange)
 *  - X-Ray (timeRange query param)
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Service Detection
  // ---------------------------------------------------------------------------

  function detectService() {
    var url = window.location.href;
    var pathname = window.location.pathname;
    var hash = window.location.hash;

    if (pathname.includes("/cloudwatch") && hash.includes("metricsV2")) {
      return "cloudwatch-metrics";
    }
    if (pathname.includes("/cloudwatch") && hash.includes("logsV2:log-groups") && hash.includes("logs-insights")) {
      return "cloudwatch-logs-insights";
    }
    // Broader match for Logs Insights (different URL patterns across regions)
    // queryDetail may appear as literal or $3D-encoded
    if (pathname.includes("/cloudwatch") && (hash.includes("logs-insights") || hash.includes("logsV2") && (hash.includes("queryDetail") || hash.includes("queryDetail$3D")))) {
      return "cloudwatch-logs-insights";
    }
    // CloudWatch Log Events: logsV2:log-groups with $3Fstart$3D pattern
    if (pathname.includes("/cloudwatch") && hash.includes("logsV2:log-groups") && (hash.includes("$3Fstart$3D") || hash.includes("?start="))) {
      return "cloudwatch-logs";
    }
    if (pathname.includes("/xray") || pathname.includes("/x-ray")) {
      return "xray";
    }
    if (pathname.includes("/cloudwatch")) {
      // Generic CloudWatch pages with JSURL state after '?'
      // e.g. #home:?~(timeRange~1814400000)
      //      #home:dashboards/ApplicationELB?~(timeRange~43200000)
      if (hash.includes("?~(")) {
        return "cloudwatch-generic";
      }
      return "cloudwatch-other";
    }
    if (url.includes(".console.aws.amazon.com")) {
      return "unknown";
    }
    return "not-aws";
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  /**
   * Format epoch ms as ISO-like datetime string in JST (no timezone suffix).
   * AWS Console expects local time strings without 'Z' in many places.
   * e.g. "2025-02-26T09:30:00.000"
   */
  function toJSTString(epochMs) {
    var s = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Asia/Tokyo",
    }).format(new Date(epochMs));
    // "sv-SE" gives "YYYY-MM-DD HH:MM:SS" → convert to ISO-like format
    return s.replace(" ", "T") + ".000";
  }

  /**
   * Parse ISO 8601 duration (e.g., PT3H, PT1H30M) to milliseconds.
   */
  function parseDuration(dur) {
    if (!dur) return null;
    var match = dur.match(/^-?PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!match) return null;
    var hours = parseInt(match[1] || "0", 10);
    var minutes = parseInt(match[2] || "0", 10);
    var seconds = parseInt(match[3] || "0", 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  /**
   * Convert relative duration string to absolute start/end.
   */
  function relativeToAbsolute(durationStr) {
    var ms = parseDuration(durationStr.replace(/^-/, ""));
    if (!ms) return null;
    var now = Date.now();
    return { start: now - ms, end: now };
  }

  /**
   * CloudWatch Metrics parser.
   * URL hash: #metricsV2:graph=~(...)
   * The graph param is JSURL-encoded and contains start/end fields.
   */
  function parseCloudWatchMetrics() {
    try {
      var hash = window.location.hash;
      var graphMatch = hash.match(/graph=([^&;]*)/);
      if (!graphMatch) return null;

      var graphStr = graphMatch[1];
      var graphObj = window.JSURL.tryParse(graphStr, null);
      if (!graphObj) return null;

      var result = { source: "CloudWatch Metrics" };

      // Absolute time: start and end are ISO strings or epoch
      if (graphObj.start && graphObj.end) {
        var startVal = graphObj.start;
        var endVal = graphObj.end;

        // Check if relative duration (e.g., "-PT3H")
        if (typeof startVal === "string" && startVal.startsWith("-P")) {
          var range = relativeToAbsolute(startVal);
          if (range) {
            result.start = range.start;
            result.end = range.end;
            result.raw = { type: "relative", duration: startVal };
          }
        } else {
          // Absolute values - could be ISO string or epoch ms
          result.start = typeof startVal === "string" ? new Date(startVal).getTime() : startVal;
          result.end = typeof endVal === "string" ? new Date(endVal).getTime() : endVal;
          result.raw = { type: "absolute" };
        }

        if (result.start && result.end && !isNaN(result.start) && !isNaN(result.end)) {
          return result;
        }
      }

      // Try period-based (relative)
      if (graphObj.period) {
        var range2 = relativeToAbsolute(graphObj.period);
        if (range2) {
          return {
            start: range2.start,
            end: range2.end,
            source: "CloudWatch Metrics",
            raw: { type: "relative", duration: graphObj.period },
          };
        }
      }

      return null;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Metrics parse error:", e);
      return null;
    }
  }

  /**
   * CloudWatch Logs Insights parser.
   * Two URL hash formats:
   *   Format A: queryDetail=<$-encoded JSURL>  (= is literal, value is $→% encoded)
   *   Format B: queryDetail$3D<raw JSURL>       (= is $3D-encoded, value is raw JSURL)
   */
  function parseCloudWatchLogsInsights() {
    try {
      var hash = window.location.hash;
      var obj = null;

      // Format A: queryDetail=<$-encoded value>
      var qdMatchA = hash.match(/queryDetail=([^&;]*)/);
      if (qdMatchA) {
        var encoded = qdMatchA[1].replace(/\$/g, "%");
        try {
          var decoded = decodeURIComponent(encoded);
          obj = window.JSURL.tryParse(decoded, null);
        } catch (e) {}
      }

      // Format B: queryDetail$3D<raw JSURL>
      if (!obj) {
        var qdMatchB = hash.match(/queryDetail\$3D([^&;]*)/i);
        if (qdMatchB) {
          obj = window.JSURL.tryParse(qdMatchB[1], null);
        }
      }

      if (!obj) return null;

      var result = { source: "CloudWatch Logs Insights" };

      // timeType: "RELATIVE" or "ABSOLUTE"
      // Note: end can be 0 (meaning "now" in relative mode), so use != null instead of truthiness
      if (obj.start != null && obj.end != null) {
        if (obj.timeType === "RELATIVE" || (typeof obj.start === "number" && obj.start < 0)) {
          // Relative: start is negative seconds from now
          var startSec = typeof obj.start === "number" ? obj.start : parseInt(obj.start, 10);
          var now = Date.now();
          result.start = now + startSec * 1000;
          result.end = now;
          result.raw = { type: "relative", seconds: startSec };
        } else {
          // Absolute: epoch seconds
          var s = typeof obj.start === "number" ? obj.start : parseInt(obj.start, 10);
          var e = typeof obj.end === "number" ? obj.end : parseInt(obj.end, 10);
          // If values are in seconds (< 10 billion), convert to ms
          if (s < 1e12) s *= 1000;
          if (e < 1e12) e *= 1000;
          result.start = s;
          result.end = e;
          result.raw = { type: "absolute" };
        }
        return result;
      }

      // Check for editorString with time info
      if (obj.unit && obj.value) {
        // Custom relative format
        var multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
        var mult = multipliers[obj.unit] || 1000;
        var ms = parseInt(obj.value, 10) * mult;
        var now2 = Date.now();
        result.start = now2 - ms;
        result.end = now2;
        result.raw = { type: "relative", unit: obj.unit, value: obj.value };
        return result;
      }

      return null;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Logs Insights parse error:", e);
      return null;
    }
  }

  /**
   * X-Ray parser.
   * URL query: ?timeRange=PT1H or ?timeRange=START~END
   */
  function parseXRay() {
    try {
      var params = new URLSearchParams(window.location.search);
      var hash = window.location.hash;

      // Also check hash params (X-Ray sometimes uses hash-based routing)
      var timeRange = params.get("timeRange");
      if (!timeRange && hash) {
        var hashMatch = hash.match(/timeRange=([^&]*)/);
        if (hashMatch) timeRange = hashMatch[1];
      }

      if (!timeRange) return null;

      var result = { source: "X-Ray" };

      if (timeRange.includes("~")) {
        // Absolute: START~END (ISO 8601 or epoch)
        var parts = timeRange.split("~");
        result.start = new Date(parts[0]).getTime();
        result.end = new Date(parts[1]).getTime();
        if (isNaN(result.start) || isNaN(result.end)) return null;
        result.raw = { type: "absolute" };
      } else {
        // Relative duration (e.g., PT1H)
        var range = relativeToAbsolute(timeRange);
        if (!range) return null;
        result.start = range.start;
        result.end = range.end;
        result.raw = { type: "relative", duration: timeRange };
      }

      return result;
    } catch (e) {
      console.warn("[TimeKeeper] X-Ray parse error:", e);
      return null;
    }
  }

  /**
   * CloudWatch Log Events parser.
   * Hash: #logsV2:log-groups/log-group/<group>/log-events/<stream>$3Fstart$3D<time>$26end$3D<time>
   * Decoded: ?start=<ms>&end=<ms>
   * start/end: negative = relative ms from now, large positive = epoch ms
   */
  function parseCloudWatchLogs() {
    try {
      var hash = window.location.hash;
      // Normalize $-encoded delimiters
      var normalized = hash.replace(/\$3F/gi, "?").replace(/\$3D/gi, "=").replace(/\$26/gi, "&");

      var startMatch = normalized.match(/[?&]start=(-?\d+)/);
      if (!startMatch) return null;

      var startVal = parseInt(startMatch[1], 10);
      var endVal = null;
      var endMatch = normalized.match(/[?&]end=(-?\d+)/);
      if (endMatch) endVal = parseInt(endMatch[1], 10);

      var result = { source: "CloudWatch Logs" };
      var now = Date.now();

      if (startVal < 0) {
        // Relative: negative milliseconds from now
        result.start = now + startVal;
        result.end = endVal != null && endVal < 0 ? now + endVal : now;
        result.raw = { type: "relative", startMs: startVal, endMs: endVal };
      } else {
        // Absolute: epoch milliseconds
        result.start = startVal;
        result.end = endVal != null ? endVal : now;
        result.raw = { type: "absolute" };
      }

      if (isNaN(result.start) || isNaN(result.end)) return null;
      return result;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Logs parse error:", e);
      return null;
    }
  }

  /**
   * CloudWatch Generic parser.
   * Many CloudWatch pages use hash format: #<section>:?~(<jsurl-state>)
   * e.g. #home:?~(timeRange~1814400000)
   *      #home:?~(timeRange~181440000       ← no closing paren
   *      #home:?~(timeRange~(start~'2024-01-01T00:00:00Z~end~'2024-01-02T00:00:00Z))
   * timeRange as number = relative duration in milliseconds from now.
   * timeRange as object = absolute start/end.
   */
  function parseCloudWatchGeneric() {
    try {
      var hash = window.location.hash;
      // Find '?~(' to locate JSURL state in hash
      // e.g. #home:?~(...)  or  #home:dashboards/Foo?~(...)
      var qIdx = hash.indexOf("?~(");
      if (qIdx < 0) return null;
      var stateStr = hash.substring(qIdx + 1); // everything after '?'
      if (!stateStr) return null;

      var stateObj = window.JSURL.tryParse(stateStr, null);
      if (!stateObj || stateObj.timeRange === undefined) return null;

      var tr = stateObj.timeRange;
      var result = { source: "CloudWatch" };

      if (typeof tr === "number") {
        // Relative: milliseconds duration from now
        var now = Date.now();
        result.start = now - tr;
        result.end = now;
        result.raw = { type: "relative", durationMs: tr };
      } else if (Array.isArray(tr) && tr.length === 2) {
        // Absolute: [startEpochMs, endEpochMs]
        result.start = tr[0];
        result.end = tr[1];
        result.raw = { type: "absolute-array" };
      } else if (typeof tr === "object" && tr.start && tr.end) {
        // Absolute: { start, end } as ISO strings or epoch
        result.start = typeof tr.start === "string" ? new Date(tr.start).getTime() : tr.start;
        result.end = typeof tr.end === "string" ? new Date(tr.end).getTime() : tr.end;
        result.raw = { type: "absolute" };
      } else {
        return null;
      }

      if (isNaN(result.start) || isNaN(result.end)) return null;
      return result;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Generic parse error:", e);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Injectors
  // ---------------------------------------------------------------------------

  /**
   * Inject time range into CloudWatch Metrics URL.
   */
  function injectCloudWatchMetrics(timeRange) {
    try {
      var hash = window.location.hash;
      var graphMatch = hash.match(/graph=([^&;]*)/);
      if (!graphMatch) return false;

      var graphStr = graphMatch[1];
      var graphObj = window.JSURL.tryParse(graphStr, null);
      if (!graphObj) return false;

      // Set absolute time
      graphObj.start = toJSTString(timeRange.start);
      graphObj.end = toJSTString(timeRange.end);

      var newGraphStr = window.JSURL.stringify(graphObj);
      var newHash = hash.replace(/graph=[^&;]*/, "graph=" + newGraphStr);
      window.location.hash = newHash;
      return true;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Metrics inject error:", e);
      return false;
    }
  }

  /**
   * Inject time range into CloudWatch Logs Insights URL.
   * Handles both Format A (queryDetail=<$-encoded>) and Format B (queryDetail$3D<raw JSURL>).
   */
  function injectCloudWatchLogsInsights(timeRange) {
    try {
      var hash = window.location.hash;
      var obj = null;
      var isFormatB = false;

      // Detect format and parse existing state
      var qdMatchA = hash.match(/queryDetail=([^&;]*)/);
      if (qdMatchA) {
        var encoded = qdMatchA[1].replace(/\$/g, "%");
        try {
          obj = window.JSURL.tryParse(decodeURIComponent(encoded), null);
        } catch (e) {}
      }

      if (!obj) {
        var qdMatchB = hash.match(/queryDetail\$3D([^&;]*)/i);
        if (qdMatchB) {
          obj = window.JSURL.tryParse(qdMatchB[1], null);
          isFormatB = true;
        }
      }

      if (!obj) return false;

      // Set absolute time (epoch seconds)
      obj.start = Math.floor(timeRange.start / 1000);
      obj.end = Math.floor(timeRange.end / 1000);
      obj.timeType = "ABSOLUTE";

      var newJsurl = window.JSURL.stringify(obj);

      if (isFormatB) {
        // Format B: queryDetail$3D<raw JSURL>
        var newHash = hash.replace(/queryDetail\$3D[^&;]*/i, "queryDetail$3D" + newJsurl);
        window.location.hash = newHash;
      } else {
        // Format A: queryDetail=<$-encoded JSURL>
        var newEncoded = encodeURIComponent(newJsurl).replace(/%/g, "$");
        var newHash = hash.replace(/queryDetail=[^&;]*/, "queryDetail=" + newEncoded);
        window.location.hash = newHash;
      }
      return true;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Logs Insights inject error:", e);
      return false;
    }
  }

  /**
   * Inject time range into CloudWatch Log Events URL.
   */
  function injectCloudWatchLogs(timeRange) {
    try {
      var hash = window.location.hash;
      var startMs = timeRange.start;
      var endMs = timeRange.end;

      // Detect encoding style: $3F/$3D or literal ?/=
      var uses$Encoding = hash.includes("$3F") || hash.includes("$3D");

      if (uses$Encoding) {
        // Replace or append $3F-encoded params
        var newHash = hash;
        if (newHash.match(/\$3Fstart\$3D-?\d+/i)) {
          newHash = newHash.replace(/\$3Fstart\$3D-?\d+/i, "$3Fstart$3D" + startMs);
        }
        if (newHash.match(/\$26end\$3D-?\d+/i)) {
          newHash = newHash.replace(/\$26end\$3D-?\d+/i, "$26end$3D" + endMs);
        } else if (newHash.includes("$3Fstart$3D")) {
          // Append end param
          newHash = newHash.replace(/(\$3Fstart\$3D-?\d+)/i, "$1$26end$3D" + endMs);
        }
        window.location.hash = newHash.replace(/^#/, "");
      } else {
        // Literal ?/= encoding
        var normalized = hash;
        normalized = normalized.replace(/([?&])start=-?\d+/, "$1start=" + startMs);
        if (normalized.match(/[?&]end=-?\d+/)) {
          normalized = normalized.replace(/([?&])end=-?\d+/, "$1end=" + endMs);
        } else {
          normalized = normalized.replace(/(\?start=-?\d+)/, "$1&end=" + endMs);
        }
        window.location.hash = normalized.replace(/^#/, "");
      }
      return true;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Logs inject error:", e);
      return false;
    }
  }

  /**
   * Inject time range into X-Ray URL.
   */
  function injectXRay(timeRange) {
    try {
      var startISO = toJSTString(timeRange.start);
      var endISO = toJSTString(timeRange.end);
      var newTimeRange = startISO + "~" + endISO;

      var url = new URL(window.location.href);

      // Check both search params and hash
      if (url.searchParams.has("timeRange")) {
        url.searchParams.set("timeRange", newTimeRange);
        window.location.href = url.toString();
        return true;
      }

      var hash = url.hash;
      if (hash.includes("timeRange=")) {
        url.hash = hash.replace(/timeRange=[^&]*/, "timeRange=" + newTimeRange);
        window.location.href = url.toString();
        return true;
      }

      // Append timeRange if not present
      if (hash) {
        url.hash = hash + "&timeRange=" + newTimeRange;
      } else {
        url.searchParams.set("timeRange", newTimeRange);
      }
      window.location.href = url.toString();
      return true;
    } catch (e) {
      console.warn("[TimeKeeper] X-Ray inject error:", e);
      return false;
    }
  }

  /**
   * Inject time range into CloudWatch Generic URL (hash JSURL state).
   */
  function injectCloudWatchGeneric(timeRange) {
    try {
      var hash = window.location.hash;
      var qIdx = hash.indexOf("?~(");
      if (qIdx < 0) return false;

      var prefix = hash.substring(0, qIdx + 1); // everything up to and including '?'
      var stateStr = hash.substring(qIdx + 1);
      var stateObj = window.JSURL.tryParse(stateStr, null);
      if (!stateObj) stateObj = {};

      // Use array format [startMs, endMs] — matches CloudWatch's absolute time URL format
      stateObj.timeRange = [timeRange.start, timeRange.end];

      var newStateStr = window.JSURL.stringify(stateObj);
      window.location.hash = prefix.replace(/^#/, "") + newStateStr;
      return true;
    } catch (e) {
      console.warn("[TimeKeeper] CloudWatch Generic inject error:", e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handler
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    switch (message.action) {
      case "detect-service":
        sendResponse({ service: detectService() });
        break;

      case "capture-time": {
        var service = detectService();
        var timeRange = null;

        switch (service) {
          case "cloudwatch-metrics":
            timeRange = parseCloudWatchMetrics();
            break;
          case "cloudwatch-logs-insights":
            timeRange = parseCloudWatchLogsInsights();
            break;
          case "cloudwatch-logs":
            timeRange = parseCloudWatchLogs();
            break;
          case "cloudwatch-generic":
            timeRange = parseCloudWatchGeneric();
            break;
          case "xray":
            timeRange = parseXRay();
            break;
        }

        if (timeRange) {
          timeRange.capturedAt = Date.now();
          sendResponse({ success: true, timeRange: timeRange });
        } else {
          sendResponse({
            success: false,
            error: service === "unknown" || service === "not-aws"
              ? "This AWS service is not supported for automatic time capture. Use manual input."
              : "Could not extract time range from current page URL.",
            service: service,
          });
        }
        break;
      }

      case "apply-time": {
        var svc = detectService();
        var tr = message.timeRange;
        var applied = false;

        switch (svc) {
          case "cloudwatch-metrics":
            applied = injectCloudWatchMetrics(tr);
            break;
          case "cloudwatch-logs-insights":
            applied = injectCloudWatchLogsInsights(tr);
            break;
          case "cloudwatch-logs":
            applied = injectCloudWatchLogs(tr);
            break;
          case "cloudwatch-generic":
            applied = injectCloudWatchGeneric(tr);
            break;
          case "xray":
            applied = injectXRay(tr);
            break;
        }

        if (applied) {
          sendResponse({ success: true });
        } else {
          sendResponse({
            success: false,
            error: svc === "unknown" || svc === "not-aws"
              ? "This AWS service is not supported for automatic time application."
              : "Could not apply time range to current page URL.",
            service: svc,
          });
        }
        break;
      }

      default:
        sendResponse({ error: "Unknown action: " + message.action });
    }

    // Return true to indicate async response
    return true;
  });
})();
