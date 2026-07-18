import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const webRoot = join(repositoryRoot, "web");
const sharedRoot = join(repositoryRoot, "shared");
const sourcePath = join(
  sharedRoot,
  "assets/source/ephemeral-sandbox-mascot.png",
);
const manifestPath = join(sharedRoot, "assets/manifest.json");
const brandDirectory = join(sharedRoot, "public/brand");
const fontDirectory = join(sharedRoot, "public/fonts");
const licenseDirectory = join(sharedRoot, "assets/licenses");
const iconDirectory = join(repositoryRoot, "desktop/src-tauri/icons");

const expectedSource = Object.freeze({
  sha256: "b940877050866fb52b9e9e1142e7cffebfc5d5c77dfca26f0da5a82e00612bd3",
  width: 1024,
  height: 1024,
  channels: 4,
  colorMode: "RGBA",
  colorSpace: "sRGB",
});

const publicImages = Object.freeze({
  png: "shared/public/brand/ephemeral-sandbox-mascot-b9408770.png",
  webp: "shared/public/brand/ephemeral-sandbox-mascot-b9408770.webp",
});

const fonts = Object.freeze([
  {
    family: "Inter",
    packageName: "@fontsource-variable/inter",
    version: "5.2.8",
    sourceFile: "files/inter-latin-wght-normal.woff2",
    outputFile: "inter-latin-100-900-v5.2.8.woff2",
    weight: "100 900",
    subset: "latin",
    licenseFile: "Inter-OFL-1.1.txt",
  },
  {
    family: "JetBrains Mono",
    packageName: "@fontsource-variable/jetbrains-mono",
    version: "5.2.8",
    sourceFile: "files/jetbrains-mono-latin-wght-normal.woff2",
    outputFile: "jetbrains-mono-latin-100-800-v5.2.8.woff2",
    weight: "100 800",
    subset: "latin",
    licenseFile: "JetBrains-Mono-OFL-1.1.txt",
  },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fromRoot(path) {
  return join(repositoryRoot, path);
}

function toRootPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function assertRepositoryPath(path, label) {
  const resolvedPath = resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, resolvedPath);
  if (
    isAbsolute(path) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} must remain inside the repository: ${path}`);
  }
  return resolvedPath;
}

async function readPackage(packageName) {
  const packagePath = join(webRoot, "node_modules", ...packageName.split("/"));
  const metadata = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
  return { packagePath, metadata };
}

async function sourceMetadata() {
  const bytes = await readFile(sourcePath);
  const digest = sha256(bytes);
  if (digest !== expectedSource.sha256) {
    throw new Error(
      `canonical mascot SHA-256 mismatch: expected ${expectedSource.sha256}, received ${digest}`,
    );
  }

  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  const actual = {
    width: metadata.width,
    height: metadata.height,
    channels: metadata.channels,
    colorMode: metadata.channels === 4 ? "RGBA" : undefined,
    colorSpace: metadata.space === "srgb" ? "sRGB" : metadata.space,
  };
  for (const [key, value] of Object.entries(expectedSource).filter(
    ([key]) => key !== "sha256",
  )) {
    if (actual[key] !== value) {
      throw new Error(
        `canonical mascot ${key} mismatch: expected ${value}, received ${actual[key]}`,
      );
    }
  }
  if (metadata.format !== "png" || metadata.depth !== "uchar" || !metadata.hasAlpha) {
    throw new Error("canonical mascot must be an 8-bit RGBA PNG");
  }

  return { bytes, metadata, digest };
}

async function generatePublicImages(sourceBytes) {
  await mkdir(brandDirectory, { recursive: true });

  const pipeline = () =>
    sharp(sourceBytes, { failOn: "error" })
      .rotate()
      .toColourspace("srgb");
  const pngBytes = await pipeline()
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
  const webpBytes = await pipeline()
    .webp({ effort: 6, lossless: true })
    .toBuffer();

  await writeFile(fromRoot(publicImages.png), pngBytes);
  await writeFile(fromRoot(publicImages.webp), webpBytes);
}

async function generateFonts() {
  await mkdir(fontDirectory, { recursive: true });
  await mkdir(licenseDirectory, { recursive: true });

  for (const font of fonts) {
    const { packagePath, metadata } = await readPackage(font.packageName);
    if (metadata.version !== font.version || metadata.license !== "OFL-1.1") {
      throw new Error(
        `${font.packageName} provenance mismatch: expected ${font.version} / OFL-1.1`,
      );
    }
    await cp(join(packagePath, font.sourceFile), join(fontDirectory, font.outputFile));
    await cp(join(packagePath, "LICENSE"), join(licenseDirectory, font.licenseFile));
  }
}

async function generateTauriIcons() {
  // Tauri's icon generator is the sole producer of packaging icons. Its input
  // is always the checked-in canonical mascot, never the one-time import path.
  await rm(iconDirectory, { force: true, recursive: true });
  await mkdir(iconDirectory, { recursive: true });

  const executable = join(
    webRoot,
    "node_modules/.bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri",
  );
  const result = spawnSync(executable, ["icon", sourcePath, "--output", iconDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `Tauri icon generation failed (${result.status ?? "signal"}):\n${result.stderr || result.stdout}`,
    );
  }
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function mimeTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".icns":
      return "image/icns";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

async function fileRecord(path, extra = {}) {
  const bytes = await readFile(path);
  const record = {
    path: toRootPath(path),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    mimeType: mimeTypeFor(path),
    ...extra,
  };

  if ([".png", ".webp"].includes(extname(path).toLowerCase())) {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    record.width = metadata.width;
    record.height = metadata.height;
  }
  return record;
}

async function createManifest(source) {
  const web = {
    png: await fileRecord(fromRoot(publicImages.png)),
    webp: await fileRecord(fromRoot(publicImages.webp)),
  };
  const fontRecords = [];
  for (const font of fonts) {
    fontRecords.push(
      await fileRecord(join(fontDirectory, font.outputFile), {
        family: font.family,
        style: "normal",
        weight: font.weight,
        subset: font.subset,
        version: font.version,
        package: font.packageName,
        license: `shared/assets/licenses/${font.licenseFile}`,
      }),
    );
  }

  const iconRecords = [];
  for (const path of await walkFiles(iconDirectory)) {
    iconRecords.push(await fileRecord(path));
  }

  const tauriPackage = await readPackage("@tauri-apps/cli");
  const manifest = {
    schemaVersion: 1,
    product: "Ephemeral Sandbox",
    source: {
      path: toRootPath(sourcePath),
      filename: "ephemeral-sandbox-mascot.png",
      importedFilename: "ChatGPT Image 2026年7月13日 20_45_46.png",
      sha256: source.digest,
      bytes: source.bytes.byteLength,
      width: source.metadata.width,
      height: source.metadata.height,
      bitDepth: 8,
      colorMode: expectedSource.colorMode,
      colorSpace: expectedSource.colorSpace,
      mimeType: "image/png",
    },
    derivatives: {
      web,
      fonts: fontRecords,
      tauriIcons: iconRecords,
    },
    generators: {
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      tauriCli: tauriPackage.metadata.version,
    },
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertMagic(bytes, mimeType, path) {
  const ascii = (start, end) => bytes.subarray(start, end).toString("ascii");
  if (
    (mimeType === "image/png" && ascii(1, 4) !== "PNG") ||
    (mimeType === "image/webp" &&
      !(ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")) ||
    (mimeType === "font/woff2" && ascii(0, 4) !== "wOF2")
  ) {
    throw new Error(`${path} does not match its declared ${mimeType} format`);
  }
}

async function verifyRecord(record) {
  const path = assertRepositoryPath(record.path, "manifest derivative path");
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (digest !== record.sha256 || bytes.byteLength !== record.bytes) {
    throw new Error(`${record.path} does not match its manifest hash/size`);
  }
  if (mimeTypeFor(path) !== record.mimeType) {
    throw new Error(`${record.path} has an incorrect MIME declaration`);
  }
  assertMagic(bytes, record.mimeType, record.path);

  if (record.width !== undefined || record.height !== undefined) {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (metadata.width !== record.width || metadata.height !== record.height) {
      throw new Error(`${record.path} does not match its manifest dimensions`);
    }
  }
}

async function verify() {
  const source = await sourceMetadata();
  const manifestText = await readFile(manifestPath, "utf8");
  if (/\/Users\/|\\Users\\/i.test(manifestText)) {
    throw new Error("asset manifest must not depend on a user-specific absolute path");
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 1 || manifest.product !== "Ephemeral Sandbox") {
    throw new Error("asset manifest schema or product name is incorrect");
  }
  if (
    manifest.source.path !== toRootPath(sourcePath) ||
    manifest.source.sha256 !== source.digest ||
    manifest.source.width !== expectedSource.width ||
    manifest.source.height !== expectedSource.height ||
    manifest.source.colorMode !== expectedSource.colorMode ||
    manifest.source.colorSpace !== expectedSource.colorSpace
  ) {
    throw new Error("asset manifest canonical source metadata is incorrect");
  }

  for (const [format, path] of Object.entries(publicImages)) {
    if (manifest.derivatives.web[format]?.path !== path) {
      throw new Error(`asset manifest must pin ${path}`);
    }
  }

  const records = [
    ...Object.values(manifest.derivatives.web),
    ...manifest.derivatives.fonts,
    ...manifest.derivatives.tauriIcons,
  ];
  await Promise.all(records.map(verifyRecord));

  const actualIconPaths = (await walkFiles(iconDirectory)).map(toRootPath);
  const manifestIconPaths = manifest.derivatives.tauriIcons.map((record) => record.path);
  if (JSON.stringify(actualIconPaths) !== JSON.stringify(manifestIconPaths)) {
    throw new Error("Tauri icon directory and manifest entries have drifted");
  }

  const fontCss = await readFile(join(webRoot, "src/index.css"), "utf8");
  for (const font of manifest.derivatives.fonts) {
    const publicUrl = `/${font.path.replace("shared/public/", "")}`;
    if (!fontCss.includes(publicUrl) || !fontCss.includes("font-display: swap")) {
      throw new Error(`web/src/index.css does not self-host ${publicUrl}`);
    }
    await stat(assertRepositoryPath(font.license, "font license path"));
  }

  try {
    await stat(join(webRoot, "public/assets/images/logo.png"));
    throw new Error("the retired robot logo must not remain a second brand source");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  process.stdout.write(
    `verified ${records.length} derivatives from ${manifest.source.sha256}\n`,
  );
}

async function verifyDist() {
  await verify();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const publicRecords = [
    ...Object.values(manifest.derivatives.web),
    ...manifest.derivatives.fonts,
  ];
  for (const record of publicRecords) {
    const publicPath = record.path.replace(/^shared\/public\//, "");
    const builtPath = join(webRoot, "dist", publicPath);
    const bytes = await readFile(builtPath);
    if (sha256(bytes) !== record.sha256) {
      throw new Error(`web/dist/${publicPath} does not match the shared asset manifest`);
    }
  }

  for (const path of await walkFiles(join(webRoot, "dist"))) {
    if (![".html", ".css", ".js", ".mjs", ".json", ".map"].includes(extname(path))) {
      continue;
    }
    const text = await readFile(path, "utf8");
    if (
      /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com|fonts\.google\.com\/icons|stitch\.withgoogle\.com/i.test(
        text,
      )
    ) {
      throw new Error(`${toRootPath(path)} contains a forbidden runtime asset dependency`);
    }
  }
  process.stdout.write(`verified ${publicRecords.length} packaged public assets\n`);
}

async function generate() {
  const source = await sourceMetadata();
  await Promise.all([generatePublicImages(source.bytes), generateFonts()]);
  await generateTauriIcons();
  await createManifest(source);
  await verify();
}

const command = process.argv[2] ?? "verify";
if (command === "generate") {
  await generate();
} else if (command === "verify") {
  await verify();
} else if (command === "verify-dist") {
  await verifyDist();
} else {
  throw new Error(`unknown asset command: ${command}`);
}
