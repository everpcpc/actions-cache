import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as path from "path";
import { Operator } from "opendal";
import { State } from "./state";
import * as fs from "fs";
import {
  findObject,
  formatSize,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  setCacheHitOutput,
  saveMatchedKey,
} from "./utils";
import { finished, pipeline } from "node:stream/promises";

process.on("uncaughtException", (e) => core.info("warning: " + e.message));

async function restoreCache() {
  try {
    const provider = core.getInput("provider", { required: true });
    const endpoint = core.getInput("endpoint");
    const bucket = core.getInput("bucket", { required: true });
    const root = core.getInput("root");
    const key = core.getInput("key", { required: true });
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");
    const restoreKeys = getInputAsArray("restore-keys");

    try {
      // Inputs are re-evaluted before the post action, so we want to store the original values
      core.saveState(State.PrimaryKey, key);

      const op = new Operator(provider, { endpoint, bucket, root });

      const compressionMethod = await utils.getCompressionMethod();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(
        await utils.createTempDirectory(),
        cacheFileName
      );

      const {
        item: obj,
        metadata,
        matchingKey,
      } = await findObject(op, key, restoreKeys, compressionMethod);
      core.debug("found cache object");
      saveMatchedKey(matchingKey);
      core.info(
        `Downloading cache from ${provider} to ${archivePath}. bucket: ${bucket}, root: ${root}, object: ${obj}`
      );
      // const rs = fs.createReadStream(archivePath);
      // const w = await op.writer(object);
      // const ws = w.createWriteStream();
      // rs.pipe(ws);
      const r = await op.reader(obj);
      const rs = r.createReadStream();
      const ws = fs.createWriteStream(archivePath);
      await pipeline(rs, ws);
      await finished(rs);
      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }
      let size = 0;
      if (metadata?.contentLength) {
        size = Number(metadata.contentLength);
      }
      core.info(`Cache Size: ${formatSize(size)} (${size} bytes)`);

      await extractTar(archivePath, compressionMethod);
      setCacheHitOutput(matchingKey === key);
      core.info(`Cache restored from ${provider} successfully`);
    } catch (e) {
      core.info(`Restore ${provider} cache failed: ${e}`);
      setCacheHitOutput(false);
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Restore cache using fallback cache");
          const fallbackMatchingKey = await cache.restoreCache(
            paths,
            key,
            restoreKeys
          );
          if (fallbackMatchingKey) {
            setCacheHitOutput(fallbackMatchingKey === key);
            core.info("Fallback cache restored successfully");
          } else {
            core.info("Fallback cache restore failed");
          }
        }
      }
    }
  } catch (e) {
    core.setFailed(`${e}`);
  }
}

restoreCache();
