const COMMAND_NAME = "save-current-page";
const STORAGE_KEYS = {
  baseUrl: "aiReaderBaseUrl",
  importToken: "aiReaderPersonalImportToken",
};
const NOTIFICATION_ICON = "icons/icon128.png";
const REQUEST_TIMEOUT_MS = 25_000;

chrome.action.onClicked.addListener((tab) => {
  void saveCurrentPage(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND_NAME) {
    return;
  }

  if (tab) {
    void saveCurrentPage(tab);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
    void saveCurrentPage(activeTab);
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    void openGroupedTab(chrome.runtime.getURL("options.html"));
  }
});

async function saveCurrentPage(tab) {
  const sourceTab = readableWebTab(tab);

  if (!sourceTab) {
    await notify(
      "Page not supported",
      "Open an HTTP or HTTPS article, then try the AI Reader shortcut again.",
    );
    return;
  }

  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.baseUrl,
    STORAGE_KEYS.importToken,
  ]);
  const baseUrl = normalizeBaseUrl(settings[STORAGE_KEYS.baseUrl]);
  const importToken = stringValue(settings[STORAGE_KEYS.importToken]).trim();

  if (!baseUrl) {
    await setBadge(sourceTab.id, "!", "#b45309");
    await notify("Setup required", "Set your AI Reader URL before saving an article.");
    await openGroupedTab(chrome.runtime.getURL("options.html"), sourceTab);
    return;
  }

  await setBadge(sourceTab.id, "…", "#2563eb", false);

  try {
    if (importToken) {
      await saveWithToken({
        baseUrl,
        importToken,
        pageUrl: sourceTab.url,
        pageTitle: sourceTab.title,
      });
      await setBadge(sourceTab.id, "✓", "#15803d");
      await notify("Saved to AI Reader", sourceTab.title || sourceTab.url);
      return;
    }

    const shareUrl = new URL("/share", `${baseUrl}/`);
    shareUrl.searchParams.set("url", sourceTab.url);

    if (sourceTab.title) {
      shareUrl.searchParams.set("title", sourceTab.title);
    }

    await openGroupedTab(shareUrl.href, sourceTab);
    await setBadge(sourceTab.id, "↗", "#15803d");
    await notify(
      "Opened AI Reader",
      "Finish the save in AI Reader using your existing signed-in session.",
    );
  } catch (error) {
    await setBadge(sourceTab.id, "!", "#b91c1c");
    await notify("Could not save article", messageFromError(error));
  }
}

async function saveWithToken({ baseUrl, importToken, pageUrl, pageTitle }) {
  const originPattern = `${new URL(baseUrl).origin}/*`;
  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern],
  });

  if (!hasPermission) {
    await openGroupedTab(chrome.runtime.getURL("options.html"));
    throw new Error("Allow access to the AI Reader site from the extension settings.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(new URL("/api/import", `${baseUrl}/`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${importToken}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        url: pageUrl,
        title: pageTitle || undefined,
        source: "chrome-extension",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail =
        body && typeof body === "object" && typeof body.error === "string"
          ? body.error
          : `AI Reader returned HTTP ${response.status}.`;
      throw new Error(detail);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("AI Reader did not respond within 25 seconds.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readableWebTab(tab) {
  if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string") {
    return null;
  }

  try {
    const url = new URL(tab.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return {
      id: tab.id,
      groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
      index: typeof tab.index === "number" ? tab.index : undefined,
      title: stringValue(tab.title).trim(),
      url: url.href,
      windowId: tab.windowId,
    };
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const rawValue = stringValue(value).trim();

  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return url.origin;
  } catch {
    return "";
  }
}

async function openGroupedTab(url, sourceTab) {
  const createProperties = {
    active: true,
    url,
  };

  if (typeof sourceTab?.windowId === "number") {
    createProperties.windowId = sourceTab.windowId;
  }

  if (typeof sourceTab?.index === "number") {
    createProperties.index = sourceTab.index + 1;
  }

  const createdTab = await chrome.tabs.create(createProperties);

  if (typeof createdTab.id !== "number") {
    return createdTab;
  }

  if (typeof sourceTab?.groupId === "number" && sourceTab.groupId >= 0) {
    await chrome.tabs.group({
      groupId: sourceTab.groupId,
      tabIds: createdTab.id,
    });
    return createdTab;
  }

  const groupId = await chrome.tabs.group({ tabIds: createdTab.id });
  await chrome.tabGroups.update(groupId, {
    color: "blue",
    title: "AI Reader",
  });
  return createdTab;
}

async function setBadge(tabId, text, color, clear = true) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
    chrome.action.setBadgeText({ tabId, text }),
  ]);

  if (clear) {
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    }, 4_000);
  }
}

async function notify(title, message) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Unexpected extension error.";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
