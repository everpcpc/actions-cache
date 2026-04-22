import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export enum CompressionMethod {
  Gzip = "gzip",
  ZstdWithoutLong = "zstd-without-long",
  Zstd = "zstd",
}

enum CacheFilename {
  Gzip = "cache.tgz",
  Zstd = "cache.tzst",
}

const ManifestFilename = "manifest.txt";
const TarFilename = "cache.tar";
const IS_WINDOWS = process.platform === "win32";

export function getCacheFileName(compressionMethod: CompressionMethod): string {
  return compressionMethod === CompressionMethod.Gzip
    ? CacheFilename.Gzip
    : CacheFilename.Zstd;
}

export async function getCompressionMethod(): Promise<CompressionMethod> {
  let stdout = "";
  try {
    await exec.exec("zstd", ["--quiet", "--version"], {
      silent: true,
      listeners: { stdout: (data) => (stdout += data.toString()) },
    });
  } catch {
    return CompressionMethod.Gzip;
  }
  return stdout.trim() ? CompressionMethod.ZstdWithoutLong : CompressionMethod.Gzip;
}

export async function createTempDirectory(): Promise<string> {
  let tempDir = process.env["RUNNER_TEMP"] || "";
  if (!tempDir) {
    if (IS_WINDOWS) {
      tempDir = process.env["USERPROFILE"] || "C:\\";
    } else if (process.platform === "darwin") {
      tempDir = "/Users";
    } else {
      tempDir = "/home";
    }
    tempDir = path.join(tempDir, "actions", "temp");
  }
  const dest = path.join(tempDir, crypto.randomUUID());
  await io.mkdirP(dest);
  return dest;
}

export async function resolvePaths(patterns: string[]): Promise<string[]> {
  const paths: string[] = [];
  const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const globber = await glob.create(patterns.join("\n"), {
    implicitDescendants: false,
  });
  for await (const file of globber.globGenerator()) {
    const relativeFile = path
      .relative(workspace, file)
      .replace(new RegExp(`\\${path.sep}`, "g"), "/");
    core.debug(`Matched: ${relativeFile}`);
    paths.push(relativeFile === "" ? "." : relativeFile);
  }
  return paths;
}

async function getTarPath(): Promise<{ path: string; gnu: boolean }> {
  if (process.platform === "win32") {
    const gnuTar = await io.which("tar", true);
    let stdout = "";
    await exec.exec(gnuTar, ["--version"], {
      silent: true,
      listeners: { stdout: (data) => (stdout += data.toString()) },
    });
    return { path: gnuTar, gnu: stdout.toLowerCase().includes("gnu tar") };
  }
  if (process.platform === "darwin") {
    const gtar = await io.which("gtar", false);
    if (gtar) return { path: gtar, gnu: true };
    return { path: await io.which("tar", true), gnu: false };
  }
  return { path: await io.which("tar", true), gnu: true };
}

function getCompressionArgs(
  compressionMethod: CompressionMethod,
  direction: "compress" | "decompress"
): string[] {
  if (compressionMethod === CompressionMethod.Gzip) return ["-z"];
  const zstdBase =
    direction === "compress" ? "zstdmt --long=30" : "unzstd --long=30";
  const zstdWin =
    direction === "compress" ? '"zstd -T0 --long=30"' : '"zstd -d --long=30"';
  if (compressionMethod === CompressionMethod.ZstdWithoutLong) {
    const base = direction === "compress" ? "zstdmt" : "unzstd";
    const win = direction === "compress" ? '"zstd -T0"' : '"zstd -d"';
    return ["--use-compress-program", IS_WINDOWS ? win : base];
  }
  return ["--use-compress-program", IS_WINDOWS ? zstdWin : zstdBase];
}

async function execTar(args: string[], cwd?: string): Promise<void> {
  await exec.exec(args.join(" "), undefined, {
    cwd,
    env: { ...process.env, MSYS: "winsymlinks:nativestrict" },
  });
}

export async function createTar(
  archiveFolder: string,
  sourceDirectories: string[],
  compressionMethod: CompressionMethod
): Promise<void> {
  fs.writeFileSync(
    path.join(archiveFolder, ManifestFilename),
    sourceDirectories.join("\n")
  );
  const tarPath = await getTarPath();
  const cacheFileName = getCacheFileName(compressionMethod);
  const workingDirectory = (
    process.env["GITHUB_WORKSPACE"] ?? process.cwd()
  ).replace(new RegExp(`\\${path.sep}`, "g"), "/");
  const args = [
    `"${tarPath.path}"`,
    "--posix",
    "-cf",
    cacheFileName,
    "--exclude",
    cacheFileName,
    "-P",
    "-C",
    workingDirectory,
    "--files-from",
    ManifestFilename,
    ...getCompressionArgs(compressionMethod, "compress"),
  ];
  if (tarPath.gnu && process.platform === "win32") args.push("--force-local");
  if (tarPath.gnu && process.platform === "darwin")
    args.push("--delay-directory-restore");
  await execTar(args, archiveFolder);
}

export async function extractTar(
  archivePath: string,
  compressionMethod: CompressionMethod
): Promise<void> {
  const workingDirectory = (
    process.env["GITHUB_WORKSPACE"] ?? process.cwd()
  ).replace(new RegExp(`\\${path.sep}`, "g"), "/");
  await io.mkdirP(workingDirectory);
  const tarPath = await getTarPath();
  const args = [
    `"${tarPath.path}"`,
    "-xf",
    archivePath.replace(new RegExp(`\\${path.sep}`, "g"), "/"),
    "-P",
    "-C",
    workingDirectory,
    ...getCompressionArgs(compressionMethod, "decompress"),
  ];
  if (tarPath.gnu && process.platform === "win32") args.push("--force-local");
  if (tarPath.gnu && process.platform === "darwin")
    args.push("--delay-directory-restore");
  await execTar(args);
}

export async function listTar(
  archivePath: string,
  compressionMethod: CompressionMethod
): Promise<void> {
  const tarPath = await getTarPath();
  const args = [
    `"${tarPath.path}"`,
    "-tf",
    archivePath.replace(new RegExp(`\\${path.sep}`, "g"), "/"),
    "-P",
    ...getCompressionArgs(compressionMethod, "decompress"),
  ];
  await execTar(args);
}
