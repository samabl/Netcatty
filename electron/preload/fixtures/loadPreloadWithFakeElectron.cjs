"use strict";

function loadPreloadWithFakeElectron(options = {}) {
  const handlers = new Map();
  const listenerCounts = new Map();
  const sent = [];
  let exposedApi = null;
  const fakeElectron = {
    ipcRenderer: {
      on(channel, handler) {
        handlers.set(channel, handler);
        listenerCounts.set(channel, (listenerCounts.get(channel) || 0) + 1);
      },
      send(channel, payload) {
        sent.push({ channel, payload });
        options.onSend?.(channel, payload);
      },
      async invoke(channel, payload) {
        if (channel === "netcatty:local:start") {
          return { sessionId: payload?.sessionId };
        }
        return null;
      },
    },
    contextBridge: {
      exposeInMainWorld(_name, value) {
        exposedApi = value;
      },
    },
    webUtils: {
      getPathForFile(file) {
        return file?.path ?? "";
      },
    },
  };

  const electronPath = require.resolve("electron");
  const preloadPath = require.resolve("../../preload.cjs");
  const previousElectron = require.cache[electronPath];
  const previousWindow = global.window;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: fakeElectron,
  };
  delete require.cache[preloadPath];
  global.window = {
    location: { origin: "app://netcatty" },
    netcatty: undefined,
  };

  require(preloadPath);

  return {
    api: exposedApi,
    handlers,
    listenerCounts,
    sent,
    cleanup() {
      delete require.cache[preloadPath];
      if (previousElectron) {
        require.cache[electronPath] = previousElectron;
      } else {
        delete require.cache[electronPath];
      }
      if (previousWindow === undefined) {
        delete global.window;
      } else {
        global.window = previousWindow;
      }
    },
  };
}

module.exports = { loadPreloadWithFakeElectron };
