/**
 * JSURL - A compact URL-friendly JSON encoding.
 * Adapted from https://github.com/Sage/jsurl (MIT License)
 *
 * Copyright (c) 2011 Bruno Jouhier
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 */
(function () {
  "use strict";

  var JSURL = {};

  // Encode characters that are not URL-safe
  var _encodeMap = {
    "'": "!",
    "!": "'",
  };

  function _encode(ch) {
    if (_encodeMap[ch]) return _encodeMap[ch];
    var code = ch.charCodeAt(0);
    if (code <= 0x7f) {
      return "*" + code.toString(16).toUpperCase();
    }
    return "**" + code.toString(16).toUpperCase();
  }

  function _stringify(v) {
    if (v === undefined) return "";
    if (v === null) return "~null";
    switch (typeof v) {
      case "number":
        return isFinite(v) ? "~" + v : "~null";
      case "boolean":
        return "~" + v;
      case "string":
        return (
          "~'" +
          v.replace(/[!'*]/g, _encode).replace(/%/g, "*25")
        );
      case "object":
        if (Array.isArray(v)) {
          return "~(" + v.map(function (item) {
            return _stringify(item) || "~null";
          }).join("") + ")";
        } else {
          var pairs = [];
          Object.keys(v).forEach(function (key) {
            var val = _stringify(v[key]);
            if (val) {
              pairs.push(
                key.replace(/[!'*%]/g, _encode) + val
              );
            }
          });
          return "~(" + pairs.join("~") + ")";
        }
      default:
        return "";
    }
  }

  function _parse(str, pos) {
    pos = pos || { i: 0 };
    var ch = str.charAt(pos.i);

    if (!ch) return undefined;

    if (ch === "~") {
      pos.i++;
      ch = str.charAt(pos.i);

      if (ch === "(") {
        // Object or Array
        pos.i++;
        if (str.charAt(pos.i) === ")") {
          pos.i++;
          // Determine if empty array or empty object
          // In JSURL, ~() is empty array when preceded by nothing specific
          return [];
        }

        // Peek ahead to determine array vs object
        // Arrays have values starting with ~, objects have key~value pairs
        var isArray = str.charAt(pos.i) === "~";

        if (isArray) {
          var arr = [];
          do {
            arr.push(_parse(str, pos));
          } while (str.charAt(pos.i) !== ")" && pos.i < str.length);
          pos.i++; // skip )
          return arr;
        } else {
          var obj = {};
          do {
            // Parse key
            var key = "";
            while (pos.i < str.length) {
              ch = str.charAt(pos.i);
              if (ch === "~" || ch === ")" || ch === "(") break;
              if (ch === "!") {
                pos.i++;
                key += "'";
              } else if (ch === "*") {
                pos.i++;
                if (str.charAt(pos.i) === "*") {
                  pos.i++;
                  var code = str.substring(pos.i, pos.i + 4);
                  key += String.fromCharCode(parseInt(code, 16));
                  pos.i += 4;
                } else {
                  var code2 = str.substring(pos.i, pos.i + 2);
                  key += String.fromCharCode(parseInt(code2, 16));
                  pos.i += 2;
                }
              } else {
                key += ch;
                pos.i++;
              }
            }
            // Parse value
            obj[key] = _parse(str, pos);

            // Skip separator ~
            if (str.charAt(pos.i) === "~" && str.charAt(pos.i + 1) !== "(" && str.charAt(pos.i + 1) !== "'" && str.charAt(pos.i + 1) !== "n" && str.charAt(pos.i + 1) !== "t" && str.charAt(pos.i + 1) !== "f" && !(str.charAt(pos.i + 1) >= "0" && str.charAt(pos.i + 1) <= "9") && str.charAt(pos.i + 1) !== "-") {
              pos.i++;
            }
          } while (str.charAt(pos.i) !== ")" && pos.i < str.length);
          pos.i++; // skip )
          return obj;
        }
      } else if (ch === "'") {
        // String
        pos.i++;
        var s = "";
        while (pos.i < str.length) {
          ch = str.charAt(pos.i);
          if (ch === "~" || ch === ")") break;
          if (ch === "!") {
            pos.i++;
            s += "'";
          } else if (ch === "*") {
            pos.i++;
            if (str.charAt(pos.i) === "*") {
              pos.i++;
              var hexCode = str.substring(pos.i, pos.i + 4);
              s += String.fromCharCode(parseInt(hexCode, 16));
              pos.i += 4;
            } else if (str.charAt(pos.i) === "2" && str.charAt(pos.i + 1) === "5") {
              s += "%";
              pos.i += 2;
            } else {
              var hexCode2 = str.substring(pos.i, pos.i + 2);
              s += String.fromCharCode(parseInt(hexCode2, 16));
              pos.i += 2;
            }
          } else {
            s += ch;
            pos.i++;
          }
        }
        return s;
      } else if (ch === "n") {
        // null
        if (str.substring(pos.i, pos.i + 4) === "null") {
          pos.i += 4;
          return null;
        }
      } else if (ch === "t") {
        // true
        if (str.substring(pos.i, pos.i + 4) === "true") {
          pos.i += 4;
          return true;
        }
      } else if (ch === "f") {
        // false
        if (str.substring(pos.i, pos.i + 5) === "false") {
          pos.i += 5;
          return false;
        }
      } else {
        // Number
        var numStr = "";
        while (pos.i < str.length) {
          ch = str.charAt(pos.i);
          if (ch === "~" || ch === ")") break;
          numStr += ch;
          pos.i++;
        }
        return Number(numStr);
      }
    }

    return undefined;
  }

  JSURL.stringify = function (v) {
    return _stringify(v);
  };

  JSURL.parse = function (str) {
    if (!str) return undefined;
    return _parse(str, { i: 0 });
  };

  JSURL.tryParse = function (str, defaultValue) {
    try {
      return JSURL.parse(str) || defaultValue;
    } catch (e) {
      return defaultValue;
    }
  };

  // Expose globally for content script access
  if (typeof window !== "undefined") {
    window.JSURL = JSURL;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.JSURL = JSURL;
  }
})();
