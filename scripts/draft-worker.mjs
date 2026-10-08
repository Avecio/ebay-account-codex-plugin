import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ebayCreateSellerHubDraft,
  ebayGetFeedResult,
  ebayGetFeedTask,
  ebayListStagedPhotos,
  ebayUploadStagedPhoto,
} from "./ebay-client.mjs";

const CREATE_CONFIRMATION = "create ebay draft";

function plainName(value, field) {
  const raw = String(value ?? "").trim();
  if (
    !raw ||
    basename(raw) !== raw ||
    raw === "." ||
    raw === ".." ||
    raw.includes("/") ||
    raw.includes("\\")
  ) {
    throw new Error(`${field} must be one plain name without a path.`);
  }
  return raw;
}

function validateJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("Job must be a JSON object.");
  }
  if (job.version !== 1) throw new Error("Unsupported job version.");
  if (job.action !== "create_draft") {
    throw new Error("Only action=create_draft is allowed.");
  }
  if (job.confirm !== true || job.confirmationText !== CREATE_CONFIRMATION) {
    throw new Error(`Draft jobs require confirm=true and confirmationText="${CREATE_CONFIRMATION}".`);
  }

  const photoGroup = plainName(job.photoGroup, "photoGroup");
  const draft = job.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("draft must be an object.");
  }
  if ("photoUrls" in draft) {
    throw new Error("photoUrls are not accepted in queued jobs; photos must come from photoGroup.");
  }

  const categoryId = String(draft.categoryId ?? "").trim();
  if (!/^\d+$/.test(categoryId)) throw new Error("draft.categoryId must be numeric.");
  if (!draft.title || String(draft.title).length > 80) {
    throw new Error("draft.title is required and must be 80 characters or fewer.");
  }
  if (!Number.isFinite(Number(draft.buyerPrice)) || Number(draft.buyerPrice) <= 0) {
    throw new Error("draft.buyerPrice must be positive.");
  }

  const sku = draft.sku === undefined || draft.sku === null
    ? null
    : String(draft.sku).trim();
  if (sku && sku.length > 100) throw new Error("draft.sku must be 100 characters or fewer.");

  return {
    jobId: plainName(job.jobId || `job-${Date.now()}`, "jobId"),
    photoGroup,
    draft: {
      ...draft,
      sku: sku || undefined,
      categoryId,
      buyerPrice: Number(draft.buyerPrice),
      quantity: Number.isInteger(draft.quantity) && draft.quantity > 0 ? draft.quantity : 1,
      marketplaceId: "EBAY_GB",
    },
  };
}

function normalizedIdentity(job) {
  return {
    jobId: job.jobId.toLowerCase(),
    photoGroup: job.photoGroup.toLowerCase(),
    sku: job.draft.sku ? String(job.draft.sku).trim().toLowerCase() : null,
  };
}

function receiptName(job) {
  const identity = normalizedIdentity(job);
  const digest = createHash("sha256")
    .update(JSON.stringify({ photoGroup: identity.photoGroup, sku: identity.sku }))
    .digest("hex")
    .slice(0, 24);
  return `${digest}.json`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function findDuplicateReceipt(receiptsDir, job) {
  const identity = normalizedIdentity(job);
  const names = (await readdir(receiptsDir)).filter((name) => name.toLowerCase().endsWith(".json"));

  for (const name of names) {
    try {
      const receipt = JSON.parse(await readFile(join(receiptsDir, name), "utf8"));
      const sameJob = String(receipt.jobId || "").toLowerCase() === identity.jobId;
      const sameGroup = String(receipt.photoGroup || "").toLowerCase() === identity.photoGroup;
      const sameSku = identity.sku &&
        String(receipt.sku || "").trim().toLowerCase() === identity.sku;
      if (sameJob || sameGroup || sameSku) return receipt;
    } catch {
      // Ignore an unreadable stale receipt instead of taking action on it.
    }
  }
  return null;
}

async function writeReceipt(receiptsDir, job, patch) {
  const path = join(receiptsDir, receiptName(job));
  const current = await pathExists(path)
    ? JSON.parse(await readFile(path, "utf8"))
    : {};
  const next = {
    ...current,
    jobId: job.jobId,
    photoGroup: job.photoGroup,
    sku: job.draft.sku || null,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function waitForTask(config, taskId, timeoutMs = 120000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    latest = await ebayGetFeedTask(config, taskId, { marketplaceId: "EBAY_GB" });
    const status = String(latest?.status || "").toUpperCase();
    if (status === "COMPLETED" || status === "COMPLETED_WITH_ERROR" || status === "FAILED") {
      return latest;
    }
    await sleep(2000);
  }
  return latest;
}

function draftLinkFromResult(resultText = "") {
  const match = String(resultText).match(
    /(https:\/\/www\.ebay\.co\.uk\/sl\/list\?[^",\r\n]*draft_id=(\d+)[^",\r\n]*)/i,
  );
  return {
    draftUrl: match?.[1] || null,
    draftId: match?.[2] || null,
  };
}

async function archivePhotoGroup(config, group) {
  const source = join(config.photoStagingDir, group);
  const archiveRoot = join(config.photoStagingDir, "_completed");
  await mkdir(archiveRoot, { recursive: true });

  let destination = join(archiveRoot, group);
  if (await pathExists(destination)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    destination = join(archiveRoot, `${group}__${stamp}`);
  }

  await rename(source, destination);
  return destination;
}

async function processJob(config, dirs, processingPath, originalName) {
  const parsed = JSON.parse(await readFile(processingPath, "utf8"));
  const job = validateJob(parsed);

  const duplicate = await findDuplicateReceipt(dirs.receipts, job);
  if (duplicate) {
    throw new Error(
      `Duplicate draft blocked for photoGroup="${job.photoGroup}"` +
      (job.draft.sku ? ` sku="${job.draft.sku}"` : "") +
      (duplicate.taskId ? ` existingTaskId="${duplicate.taskId}"` : "") +
      ".",
    );
  }

  const staged = await ebayListStagedPhotos(config, { group: job.photoGroup });
  if (!staged.files.length) throw new Error(`No staged photos found in group "${job.photoGroup}".`);
  if (staged.files.length > 24) throw new Error("eBay supports at most 24 photos per draft.");

  const uploads = [];
  for (const file of staged.files) {
    const uploaded = await ebayUploadStagedPhoto(config, file.fileName, { group: job.photoGroup });
    if (!uploaded.imageUrl) {
      throw new Error(`eBay did not return an image URL for ${file.fileName}.`);
    }
    uploads.push(uploaded);
  }

  const draft = await ebayCreateSellerHubDraft(config, {
    ...job.draft,
    photoUrls: uploads.map((entry) => entry.imageUrl),
  });

  // Write the receipt immediately after eBay accepts draft creation. This is
  // deliberately before polling so a crash/retry cannot silently create a duplicate.
  await writeReceipt(dirs.receipts, job, {
    state: "DRAFT_SUBMITTED",
    taskId: draft.taskId,
    submittedAt: new Date().toISOString(),
  });

  const task = await waitForTask(config, draft.taskId);
  const taskStatus = String(task?.status || "").toUpperCase();
  const successCount = task?.uploadSummary?.successCount ?? task?.successCount ?? null;
  const failureCount = task?.uploadSummary?.failureCount ?? task?.failureCount ?? null;

  let draftId = null;
  let draftUrl = null;
  if (taskStatus === "COMPLETED" || taskStatus === "COMPLETED_WITH_ERROR") {
    try {
      const feedResult = await ebayGetFeedResult(config, draft.taskId, { marketplaceId: "EBAY_GB" });
      ({ draftId, draftUrl } = draftLinkFromResult(feedResult.resultText));
    } catch {
      // A draft may still be valid even if the result file is briefly unavailable.
    }
  }

  const successful = taskStatus === "COMPLETED" && (successCount === null || successCount > 0);
  if (!successful) {
    await writeReceipt(dirs.receipts, job, {
      state: "DRAFT_SUBMITTED_NOT_CONFIRMED",
      taskId: draft.taskId,
      taskStatus: taskStatus || null,
      successCount,
      failureCount,
      draftId,
      draftUrl,
    });
    throw new Error(
      `eBay draft task did not complete cleanly. taskId=${draft.taskId} status=${taskStatus || "UNKNOWN"}.`,
    );
  }

  const archivedPhotoPath = await archivePhotoGroup(config, job.photoGroup);

  await writeReceipt(dirs.receipts, job, {
    state: "COMPLETED",
    taskId: draft.taskId,
    taskStatus,
    successCount,
    failureCount,
    draftId,
    draftUrl,
    archivedPhotoPath,
    completedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    jobId: job.jobId,
    sourceJobFile: originalName,
    photoGroup: job.photoGroup,
    sku: job.draft.sku || null,
    photoOrder: staged.files.map((file) => file.fileName),
    uploadedImageCount: uploads.length,
    taskId: draft.taskId,
    uploadStatus: draft.status,
    pricing: draft.pricing,
    taskStatus: taskStatus || null,
    successCount,
    failureCount,
    draftId,
    draftUrl,
    archivedPhotoPath,
    createdAt: new Date().toISOString(),
    note: "Unpublished Seller Hub draft only. This worker has no publish action.",
  };
}

async function ensureFolders(root) {
  const dirs = {
    pending: join(root, "pending"),
    processing: join(root, "processing"),
    completed: join(root, "completed"),
    failed: join(root, "failed"),
    receipts: join(root, "receipts"),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

async function processPending(config, dirs) {
  const names = (await readdir(dirs.pending))
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  for (const name of names) {
    const safeName = plainName(name, "job file");
    const pendingPath = join(dirs.pending, safeName);
    const processingPath = join(dirs.processing, safeName);

    try {
      await rename(pendingPath, processingPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    try {
      const result = await processJob(config, dirs, processingPath, safeName);
      const resultName = safeName.replace(/\.json$/i, ".result.json");
      await writeFile(join(dirs.completed, resultName), JSON.stringify(result, null, 2), "utf8");
      await rename(processingPath, join(dirs.completed, safeName));
      console.log(JSON.stringify({
        ok: true,
        component: "draft-worker",
        job: safeName,
        sku: result.sku,
        taskId: result.taskId,
        draftUrl: result.draftUrl,
        status: result.taskStatus,
      }));
    } catch (error) {
      const failure = {
        ok: false,
        sourceJobFile: safeName,
        error: error?.message || String(error),
        failedAt: new Date().toISOString(),
      };
      const resultName = safeName.replace(/\.json$/i, ".result.json");
      await writeFile(join(dirs.failed, resultName), JSON.stringify(failure, null, 2), "utf8");
      await rename(processingPath, join(dirs.failed, safeName));
      console.error(JSON.stringify({
        ok: false,
        component: "draft-worker",
        job: safeName,
        error: failure.error,
      }));
    }
  }
}

export async function startDraftJobWorker(config) {
  if (!config.enableDraftWorker) return;
  if (!config.enableDraftTools) {
    throw new Error("EBAY_ENABLE_DRAFT_WORKER=true requires EBAY_ENABLE_DRAFT_TOOLS=true.");
  }
  if (config.enableWriteTools) {
    throw new Error("Draft worker refuses to start while EBAY_ENABLE_WRITE_TOOLS=true.");
  }

  const dirs = await ensureFolders(config.draftJobDir);
  console.log(JSON.stringify({
    ok: true,
    component: "draft-worker",
    mode: "UNPUBLISHED_DRAFT_ONLY",
    jobDir: config.draftJobDir,
    duplicateProtection: true,
    photoArchive: join(config.photoStagingDir, "_completed"),
  }));

  for (;;) {
    await processPending(config, dirs);
    await sleep(2000);
  }
}
