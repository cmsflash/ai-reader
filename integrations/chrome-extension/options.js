const COMMAND_NAME = "save-current-page";
const STORAGE_KEYS = {
  baseUrl: "aiReaderBaseUrl",
  importToken: "aiReaderPersonalImportToken",
};

const form = document.querySelector("#settings-form");
const baseUrlInput = document.querySelector("#base-url");
const importTokenInput = document.querySelector("#import-token");
const statusElement = document.querySelector("#status");
const shortcutValue = document.querySelector("#shortcut-value");
const toggleTokenButton = document.querySelector("#toggle-token");
const openShortcutsButton = document.querySelector("#open-shortcuts");

void loadSettings();
void loadShortcut();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings();
});

toggleTokenButton.addEventListener("click", () => {
  const showing = importTokenInput.type === "text";
  importTokenInput.type = showing ? "password" : "text";
  toggleTokenButton.textContent = showing ? "Show" : "Hide";
});

openShortcutsButton.addEventListener("click", () => {
  void openGroupedTab("chrome://extensions/shortcuts");
});

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.baseUrl,
    STORAGE_KEYS.importToken,
  ]);
  baseUrlInput.value = stringValue(settings[STORAGE_KEYS.baseUrl]);
  importTokenInput.value = stringValue(settings[STORAGE_KEYS.importToken]);
}

async function saveSettings() {
  setStatus("");

  let baseUrl;

  try {
    baseUrl = normalizeBaseUrl(baseUrlInput.value);
  } catch (error) {
    setStatus(messageFromError(error), true);
    return;
  }

  const importToken = importTokenInput.value.trim();

  if (importToken) {
    const granted = await chrome.permissions.request({
      origins: [`${new URL(baseUrl).origin}/*`],
    });

    if (!granted) {
      setStatus("Site access is required for background token imports.", true);
      return;
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.baseUrl]: baseUrl,
    [STORAGE_KEYS.importToken]: importToken,
  });

  baseUrlInput.value = baseUrl;
  importTokenInput.value = importToken;
  setStatus(importToken ? "Saved. Background imports are enabled." : "Saved. Shares will open in AI Reader.");
}

async function loadShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === COMMAND_NAME);
  shortcutValue.textContent = command?.shortcut || "Not assigned";
}

function normalizeBaseUrl(value) {
  const rawValue = value.trim();

  if (!rawValue) {
    throw new Error("Enter your AI Reader URL.");
  }

  let url;

  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("Enter a valid AI Reader URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The AI Reader URL must use HTTP or HTTPS.");
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Enter only the AI Reader origin, without a path, query, or credentials.");
  }

  return url.origin;
}

async function openGroupedTab(url) {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const createdTab = await chrome.tabs.create({
    active: true,
    index: typeof currentTab?.index === "number" ? currentTab.index + 1 : undefined,
    url,
    windowId: currentTab?.windowId,
  });

  if (typeof createdTab.id !== "number") {
    return;
  }

  if (typeof currentTab?.groupId === "number" && currentTab.groupId >= 0) {
    await chrome.tabs.group({
      groupId: currentTab.groupId,
      tabIds: createdTab.id,
    });
    return;
  }

  const groupId = await chrome.tabs.group({ tabIds: createdTab.id });
  await chrome.tabGroups.update(groupId, {
    color: "blue",
    title: "AI Reader",
  });
}

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Unexpected settings error.";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
