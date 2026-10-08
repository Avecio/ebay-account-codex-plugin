import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

export function loadConfig() {
  const env = (process.env.EBAY_ENV || "sandbox").toLowerCase();
  const isProduction = env === "production" || env === "prod";
  const tokenStorePath = expandEnvPath(
    process.env.EBAY_TOKEN_STORE_PATH ||
      "%LOCALAPPDATA%\\Codex\\eBayAccountPlugin\\tokens.json",
  );

  return {
    env: isProduction ? "production" : "sandbox",
    host: process.env.EBAY_MCP_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.EBAY_MCP_PORT || "4318", 10),
    clientId: process.env.EBAY_CLIENT_ID || "",
    clientSecret: process.env.EBAY_CLIENT_SECRET || "",
    redirectUri: process.env.EBAY_REDIRECT_URI || "",
    mcpApiKey: process.env.EBAY_MCP_API_KEY || "",
    enableWriteTools: (process.env.EBAY_ENABLE_WRITE_TOOLS || "").toLowerCase() === "true",
    enableDraftTools: (process.env.EBAY_ENABLE_DRAFT_TOOLS || "").toLowerCase() === "true",
    scopes: splitScopes(process.env.EBAY_SCOPES).length
      ? splitScopes(process.env.EBAY_SCOPES)
      : DEFAULT_SCOPES,
    tokenStorePath,
    marketplaceAccountDeletionEndpoint: process.env.EBAY_MARKETPLACE_ACCOUNT_DELETION_ENDPOINT || "",
    marketplaceAccountDeletionVerificationToken:
      process.env.EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN || "",
    authBaseUrl: isProduction
      ? "https://auth.ebay.com/oauth2/authorize"
      : "https://auth.sandbox.ebay.com/oauth2/authorize",
    apiBaseUrl: isProduction
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com",
  };
}

export function requireOAuthConfig(config) {
  const missing = [];
  if (!config.clientId) missing.push("EBAY_CLIENT_ID");
  if (!config.clientSecret) missing.push("EBAY_CLIENT_SECRET");
  if (!config.redirectUri) missing.push("EBAY_REDIRECT_URI");
  if (missing.length) {
    throw new Error(`Missing required eBay OAuth environment variables: ${missing.join(", ")}`);
  }
}

export function buildAuthorizationUrl(config, state) {
  requireOAuthConfig(config);
  const url = new URL(config.authBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForTokens(config, code) {
  requireOAuthConfig(config);
  return tokenRequest(config, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  }));
}

export async function refreshAccessToken(config, refreshToken) {
  requireOAuthConfig(config);
  return tokenRequest(config, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: config.scopes.join(" "),
  }));
}

async function tokenRequest(config, body) {
  const response = await fetch(`${config.apiBaseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body,
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`eBay token request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return {
    ...payload,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (payload.expires_in ?? 0) * 1000).toISOString(),
  };
}

export async function loadTokens(config) {
  try {
    return JSON.parse(await readFile(config.tokenStorePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveTokens(config, tokens) {
  await mkdir(dirname(config.tokenStorePath), { recursive: true });
  await writeFile(config.tokenStorePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function getValidAccessToken(config) {
  const tokens = await loadTokens(config);
  if (!tokens?.access_token) {
    throw new Error("No eBay tokens found. Open /auth/login first and complete eBay consent.");
  }

  const expiresAt = tokens.expires_at ? Date.parse(tokens.expires_at) : 0;
  if (expiresAt && expiresAt - Date.now() > 120_000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error("The stored eBay access token expired and no refresh token is available. Run /auth/login again.");
  }

  const refreshed = await refreshAccessToken(config, tokens.refresh_token);
  const nextTokens = {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  };
  await saveTokens(config, nextTokens);
  return nextTokens.access_token;
}

export async function ebayGetActiveListings(config, {
  entriesPerPage = 25,
  pageNumber = 1,
  siteId = "3",
} = {}) {
  const accessToken = await getValidAccessToken(config);
  const gateway = config.env === "production"
    ? "https://api.ebay.com/ws/api.dll"
    : "https://api.sandbox.ebay.com/ws/api.dll";

  const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

  const response = await fetch(gateway, {
    method: "POST",
    headers: {
      "content-type": "text/xml",
      "x-ebay-api-call-name": "GetMyeBaySelling",
      "x-ebay-api-compatibility-level": "1487",
      "x-ebay-api-siteid": String(siteId),
      "x-ebay-api-iaf-token": accessToken,
    },
    body: requestXml,
  });

  const xml = await response.text();
  const ack = xmlText(xml, "Ack");
  if (!response.ok || ack === "Failure") {
    const message = xmlText(xml, "LongMessage") || xmlText(xml, "ShortMessage") || xml.slice(0, 1000);
    throw new Error(`eBay Trading API request failed (${response.status} GetMyeBaySelling): ${message}`);
  }

  const activeList = xmlBlock(xml, "ActiveList") || "";
  const itemArray = xmlBlock(activeList, "ItemArray") || "";
  const items = [...itemArray.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((match) => {
    const item = match[1];
    const currentPrice = xmlMoney(item, "CurrentPrice");
    const startPrice = xmlMoney(item, "StartPrice");
    return {
      itemId: xmlText(item, "ItemID") || null,
      title: xmlText(item, "Title") || null,
      sku: xmlText(item, "SKU") || null,
      listingType: xmlText(item, "ListingType") || null,
      currentPrice,
      startPrice,
      quantity: xmlNumber(item, "Quantity"),
      quantityAvailable: xmlNumber(item, "QuantityAvailable"),
      quantitySold: xmlNumber(item, "QuantitySold"),
      watchCount: xmlNumber(item, "WatchCount"),
      timeLeft: xmlText(item, "TimeLeft") || null,
      viewItemUrl: xmlText(item, "ViewItemURL") || null,
    };
  });

  return {
    total: xmlNumber(activeList, "TotalNumberOfEntries") ?? items.length,
    totalPages: xmlNumber(activeList, "TotalNumberOfPages") ?? null,
    pageNumber,
    entriesPerPage,
    items,
  };
}

function ebayPrivateSellerBuyerProtectionFee(itemPrice) {
  const price = Number(itemPrice);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("itemPrice must be a non-negative number.");
  }

  let fee = 0.10;
  fee += Math.min(price, 20) * 0.07;
  if (price > 20) fee += Math.min(price - 20, 280) * 0.04;
  if (price > 300) fee += Math.min(price - 300, 3700) * 0.02;
  return Math.round((fee + Number.EPSILON) * 100) / 100;
}

function sellerPriceForBuyerFacingTotal(buyerPrice) {
  const targetPence = Math.round(Number(buyerPrice) * 100);
  if (!Number.isFinite(targetPence) || targetPence <= 0) {
    throw new Error("buyerPrice must be a positive GBP amount.");
  }

  // Work in pennies so the amount the shopper sees is exact whenever eBay's
  // rounded Buyer Protection fee permits it.
  let best = null;
  const maxSellerPence = targetPence;
  for (let sellerPence = Math.max(1, targetPence - 10000); sellerPence <= maxSellerPence; sellerPence += 1) {
    const sellerPrice = sellerPence / 100;
    const feePence = Math.round(ebayPrivateSellerBuyerProtectionFee(sellerPrice) * 100);
    const visiblePence = sellerPence + feePence;
    const distance = Math.abs(visiblePence - targetPence);
    if (!best || distance < best.distance || (distance === best.distance && sellerPence > best.sellerPence)) {
      best = { sellerPence, feePence, visiblePence, distance };
      if (distance === 0) break;
    }
  }

  if (!best) throw new Error("Unable to calculate seller price.");
  return {
    buyerPrice: (targetPence / 100).toFixed(2),
    sellerItemPrice: (best.sellerPence / 100).toFixed(2),
    estimatedBuyerProtectionFee: (best.feePence / 100).toFixed(2),
    estimatedBuyerVisiblePrice: (best.visiblePence / 100).toFixed(2),
  };
}

export async function ebayCreateSellerHubDraft(config, {
  categoryId,
  title,
  sku,
  upc,
  buyerPrice,
  quantity,
  photoUrls = [],
  condition,
  conditionId,
  itemSpecifics = {},
  description,
  format,
  marketplaceId = "EBAY_GB",
} = {}) {
  if (config.env !== "production") {
    throw new Error("Seller Hub draft uploads are only available in eBay Production.");
  }

  const normalizedCategoryId = String(categoryId ?? "").trim();
  if (!/^\d+$/.test(normalizedCategoryId)) {
    throw new Error("categoryId must be a numeric eBay category ID.");
  }

  const accessToken = await getValidAccessToken(config);
  const commonHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "x-ebay-c-marketplace-id": marketplaceId,
  };

  const createResponse = await fetch(`${config.apiBaseUrl}/sell/feed/v1/task`, {
    method: "POST",
    headers: {
      ...commonHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      feedType: "FX_DRAFT",
      schemaVersion: "1.0",
    }),
  });

  const createText = await createResponse.text();
  if (!createResponse.ok) {
    throw new Error(`eBay Feed createTask failed (${createResponse.status}): ${createText || "no response body"}`);
  }

  const location = createResponse.headers.get("location") || "";
  let taskId = location.split("/").filter(Boolean).at(-1) || "";
  if (!taskId && createText) {
    try {
      const payload = JSON.parse(createText);
      taskId = payload.taskId || payload.task_id || "";
    } catch {
    }
  }
  if (!taskId) {
    throw new Error("eBay Feed createTask succeeded but no task ID was returned.");
  }

  const pricing = sellerPriceForBuyerFacingTotal(buyerPrice);

  const csv = buildSellerHubDraftCsv({
    categoryId: normalizedCategoryId,
    title,
    sku,
    upc,
    price: pricing.sellerItemPrice,
    quantity,
    photoUrls,
    condition,
    conditionId,
    itemSpecifics,
    description,
    format,
  });

  const fileName = `ebay-draft-${taskId}.csv`;
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), fileName);

  const uploadResponse = await fetch(
    `${config.apiBaseUrl}/sell/feed/v1/task/${encodeURIComponent(taskId)}/upload_file`,
    {
      method: "POST",
      headers: commonHeaders,
      body: form,
    },
  );
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(`eBay Feed uploadFile failed (${uploadResponse.status}): ${uploadText || "no response body"}`);
  }

  return {
    taskId,
    status: "UPLOADED",
    marketplaceId,
    categoryId: normalizedCategoryId,
    title: title || null,
    pricing,
    note: "An unpublished Seller Hub draft feed was submitted. buyerPrice is the intended shopper-visible item price; the CSV uses the back-calculated private-seller item price before eBay Buyer Protection.",
  };
}

export async function ebayGetFeedResult(config, taskId, {
  marketplaceId = "EBAY_GB",
} = {}) {
  const accessToken = await getValidAccessToken(config);
  const url = new URL(
    `/sell/feed/v1/task/${encodeURIComponent(taskId)}/download_result_file`,
    config.apiBaseUrl,
  );
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "*/*",
      "x-ebay-c-marketplace-id": marketplaceId,
    },
  });

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = bytes.toString("utf8");
    throw new Error(
      `eBay Feed getResultFile failed (${response.status}): ${text || "no response body"}`,
    );
  }

  let decoded = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    decoded = gunzipSync(bytes);
  }

  const text = decoded.toString("utf8");
  return {
    taskId,
    contentType: response.headers.get("content-type") || null,
    bytes: bytes.length,
    resultText: text.slice(0, 100000),
    truncated: text.length > 100000,
  };
}

export async function ebayGetFeedTask(config, taskId, {
  marketplaceId = "EBAY_GB",
} = {}) {
  return ebayGet(
    config,
    `/sell/feed/v1/task/${encodeURIComponent(taskId)}`,
    {},
    { headers: { "x-ebay-c-marketplace-id": marketplaceId } },
  );
}

function buildSellerHubDraftCsv({
  categoryId,
  title,
  sku,
  upc,
  price,
  quantity,
  photoUrls = [],
  condition,
  conditionId,
  itemSpecifics = {},
  description,
  format,
}) {
  // Mirror eBay UK's official Seller Hub "Create new drafts" CSV shape.
  // The four #INFO rows and the site metadata embedded in the Action header
  // are part of the downloaded template and are preserved deliberately.
  const infoLines = [
    "#INFO,Version=0.0.2,Template= eBay-draft-listings-template_GB,,,,,,,,",
    "#INFO Action and Category ID are required fields. 1) Set Action to Draft 2) Please find the category ID for your listings here: https://pages.ebay.com/sellerinformation/news/categorychanges.html,,,,,,,,,,",
    "\"#INFO After you've successfully uploaded your draft from the Seller Hub Reports tab, complete your drafts to active listings here: https://www.ebay.co.uk/sh/lst/drafts\",,,,,,,,,,",
    "#INFO,,,,,,,,,,",
  ];

  const specificEntries = Object.entries(itemSpecifics || {})
    .filter(([name, value]) => String(name).trim() && value !== undefined && value !== null && String(value).trim());

  const headers = [
    "Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8)",
    "Custom label (SKU)",
    "Category ID",
    "Title",
    "UPC",
    "Price",
    "Quantity",
    "Item photo URL",
    "Condition ID",
    "Description",
    "Format",
    ...specificEntries.map(([name]) => `C:${String(name).trim()}`),
  ];
  const row = [
    "Draft",
    sku,
    categoryId,
    title,
    upc,
    price,
    quantity,
    photoUrls.filter(Boolean).join("|"),
    sellerHubDraftCondition(conditionId, condition),
    description,
    format,
    ...specificEntries.map(([, value]) => String(value).trim()),
  ];

  return [
    ...infoLines,
    headers.join(","),
    row.map(csvCell).join(","),
    "",
  ].join("\r\n");
}

function sellerHubDraftCondition(conditionId, condition) {
  const explicit = String(condition ?? "").trim().toUpperCase();
  if (explicit === "NEW" || explicit === "USED") return explicit;

  const id = String(conditionId ?? "").trim();
  if (id === "1000") return "NEW";
  if (id === "3000") return "USED";

  // eBay's Create Drafts template only accepts NEW or USED in its
  // "Condition ID" column. More specific condition states must be
  // completed later in Seller Hub.
  return "";
}

function csvCell(value) {
  if (value === undefined || value === null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

export async function ebayGetCategoryConditionPolicies(config, categoryId, {
  marketplaceId = "EBAY_GB",
} = {}) {
  const normalizedCategoryId = String(categoryId ?? "").trim();
  if (!/^\d+$/.test(normalizedCategoryId)) {
    throw new Error("categoryId must be a numeric eBay category ID.");
  }

  return ebayGet(
    config,
    `/sell/metadata/v1/marketplace/${encodeURIComponent(marketplaceId)}/get_item_condition_policies`,
    { filter: `categoryIds:{${normalizedCategoryId}}` },
  );
}

export async function ebayGetCategoryAspects(config, categoryId, {
  marketplaceId = "EBAY_GB",
} = {}) {
  const normalizedCategoryId = String(categoryId ?? "").trim();
  if (!/^\d+$/.test(normalizedCategoryId)) {
    throw new Error("categoryId must be a numeric eBay category ID.");
  }

  const tree = await ebayGet(
    config,
    "/commerce/taxonomy/v1/get_default_category_tree_id",
    { marketplace_id: marketplaceId },
  );
  const categoryTreeId = tree.categoryTreeId;
  if (!categoryTreeId) {
    throw new Error(`eBay did not return a category tree ID for ${marketplaceId}.`);
  }

  const aspects = await ebayGet(
    config,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(categoryTreeId)}/get_item_aspects_for_category`,
    { category_id: normalizedCategoryId },
  );

  return {
    marketplaceId,
    categoryTreeId,
    categoryId: normalizedCategoryId,
    ...aspects,
  };
}

export async function ebayGet(config, path, query = {}, options = {}) {
  return ebayRequest(config, "GET", path, { query, ...options });
}

export async function ebayPost(config, path, body = {}, options = {}) {
  return ebayRequest(config, "POST", path, { body, ...options });
}

export async function ebayPut(config, path, body = {}, options = {}) {
  return ebayRequest(config, "PUT", path, { body, ...options });
}

export async function ebayDelete(config, path, options = {}) {
  return ebayRequest(config, "DELETE", path, options);
}

export async function ebayRequest(config, method, path, {
  query = {},
  body,
  headers = {},
  contentLanguage = "en-US",
} = {}) {
  const accessToken = await getValidAccessToken(config);
  const url = new URL(path, config.apiBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const requestHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "accept-language": "en-GB",
    ...headers,
  };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    requestHeaders["content-language"] = contentLanguage;
  }

  const response = await fetch(url, {
    method,
    headers: {
      ...requestHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`eBay API request failed (${response.status} ${method} ${path}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

export function publicConnectionStatus(config, tokens) {
  return {
    environment: config.env,
    tokenStorePath: config.tokenStorePath,
    connected: Boolean(tokens?.access_token),
    expiresAt: tokens?.expires_at || null,
    hasRefreshToken: Boolean(tokens?.refresh_token),
    scopes: config.scopes,
    draftToolsEnabled: Boolean(config.enableDraftTools),
    writeToolsEnabled: Boolean(config.enableWriteTools),
  };
}

function xmlBlock(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

function xmlText(xml, tag) {
  const value = xmlBlock(xml, tag);
  return value === null ? null : decodeXml(value.replace(/<[^>]+>/g, "").trim());
}

function xmlNumber(xml, tag) {
  const value = xmlText(xml, tag);
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function xmlMoney(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return null;
  const currencyMatch = match[1].match(/currencyID="([^"]+)"/);
  const value = Number(decodeXml(match[2].replace(/<[^>]+>/g, "").trim()));
  if (!Number.isFinite(value)) return null;
  return {
    value,
    currency: currencyMatch ? decodeXml(currencyMatch[1]) : null,
  };
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function splitScopes(value = "") {
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function expandEnvPath(value) {
  return value.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || "");
}


