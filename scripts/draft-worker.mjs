import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ebayCreateSellerHubDraft,
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

  return {
    jobId: plainName(job.jobId || `job-${Date.now()}`, "jobId"),
    photoGroup,
    draft: {
      ...draft,
      categoryId,
      buyerPrice: Number(draft.buyerPrice),
      quantity: Number.isInteger(draft.quantity) && draft.quantity > 0 ? draft.quantity : 1,
      marketplaceId: "EBAY_GB",
    },
  };
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

async function processJob(config, processingPath, originalName) {
  const parsed = JSON.parse(await readFile(processingPath, "utf8"));
  const job = validateJob(parsed);

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
  const task = await waitForTask(config, draft.taskId);

  return {
    ok: true,
    jobId: job.jobId,
    sourceJobFile: originalName,
    photoGroup: job.photoGroup,
    uploadedImageCount: uploads.length,
    taskId: draft.taskId,
    uploadStatus: draft.status,
    pricing: draft.pricing,
    taskStatus: task?.status || null,
    successCount: task?.uploadSummary?.successCount ?? task?.successCount ?? null,
    failureCount: task?.uploadSummary?.failureCount ?? task?.failureCount ?? null,
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
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

async function processPending(config, dirs) {
  const names = (await readdir(dirs.pending))
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort();

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
      const result = await processJob(config, processingPath, safeName);
      const resultName = safeName.replace(/\.json$/i, ".result.json");
      await writeFile(join(dirs.completed, resultName), JSON.stringify(result, null, 2), "utf8");
      await rename(processingPath, join(dirs.completed, safeName));
      console.log(JSON.stringify({
        ok: true,
        component: "draft-worker",
        job: safeName,
        taskId: result.taskId,
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
  }));

  for (;;) {
    await processPending(config, dirs);
    await sleep(2000);
  }
}
