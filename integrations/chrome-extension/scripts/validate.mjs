import { accessSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
const expectedPermissions = ["activeTab", "tabs", "tabGroups", "storage", "notifications"];
const expectedSizes = [16, 32, 48, 128];
const problems = [];

if (manifest.manifest_version !== 3) {
  problems.push("manifest_version must be 3");
}

for (const permission of expectedPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    problems.push(`missing permission: ${permission}`);
  }
}

if (!manifest.commands?.["save-current-page"]) {
  problems.push("missing save-current-page command");
}

for (const relativePath of [
  manifest.background?.service_worker,
  manifest.options_page,
  "service-worker.js",
  "options.html",
  "options.css",
  "options.js",
]) {
  if (!relativePath) {
    problems.push("manifest references an empty path");
    continue;
  }

  try {
    accessSync(`${root}/${relativePath}`);
  } catch {
    problems.push(`missing file: ${relativePath}`);
  }
}

for (const size of expectedSizes) {
  const relativePath = manifest.icons?.[String(size)];

  if (!relativePath) {
    problems.push(`missing ${size}px manifest icon`);
    continue;
  }

  try {
    const png = readFileSync(`${root}/${relativePath}`);
    const signature = png.subarray(0, 8).toString("hex");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);

    if (signature !== "89504e470d0a1a0a") {
      problems.push(`${relativePath} is not a PNG`);
    }

    if (width !== size || height !== size) {
      problems.push(`${relativePath} is ${width}x${height}, expected ${size}x${size}`);
    }
  } catch {
    problems.push(`missing or unreadable icon: ${relativePath}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log("Chrome extension manifest and packaged files are valid.");
}
