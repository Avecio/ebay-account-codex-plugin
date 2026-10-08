\# Peacock Scout eBay Listing Draft Workflow



This repository connects to an eBay account through a hardened MCP connector.



\## Safety mode



Current operating mode is \*\*DRAFT ONLY / READ ONLY\*\*.



The only permitted eBay state change is creating an unpublished Seller Hub draft through the dedicated draft tool when the user explicitly asks for a real eBay draft. Do not publish, edit live listings, end, revise, delete, relist, refund, send messages, add tracking, or otherwise change live eBay state.



Do not enable write tools or change `EBAY\_ENABLE\_WRITE\_TOOLS`.



Do not modify OAuth scopes, credentials, tokens, `.env`, or account settings unless the user explicitly asks for connector maintenance.



Reading eBay data is allowed through the exposed read-only tools.



\## Listing-draft workflow



When the user gives photos, item details, model numbers, measurements, testing results, or other evidence for an item they want to sell:



1\. Identify the item as precisely as the evidence supports.

2\. Separate confirmed facts from likely identification and uncertainty.

3\. Research the exact model or closest defensible match where useful.

4\. Use the connected eBay account only for read-only context such as existing listing style, current listings, orders, and account information.

5\. Research pricing evidence where available. Do not invent sold prices, sale dates, condition, model matches, or comparable listings.

6\. Produce a complete proposed listing draft for the user to review.

7\. Do not create the listing on eBay.



\## Draft output



A finished draft should normally include:



\- Proposed title

\- Identification / model

\- Condition

\- Item specifics

\- Description

\- Included items / missing items

\- Testing performed

\- Defects or uncertainty that should be disclosed

\- Suggested Buy It Now price

\- Suggested lowest acceptable offer where appropriate

\- Shipping / packaging suggestion

\- Research evidence or pricing rationale

\- Any information still needed before listing

\- Confidence level in the identification



Keep eBay titles accurate and search-friendly. Do not stuff titles with unsupported compatibility claims or keywords.



For vintage motorcycle and automotive parts, treat fitment claims carefully. Only state compatibility as confirmed when supported by part numbers, markings, dimensions, reliable documentation, or strong matching evidence.



\## Evidence rules



Prefer exact model matches over generic resemblance.



If evidence conflicts, say so.



If an item cannot be identified confidently, present the strongest candidate and explain what physical marking, measurement, photo, or test would resolve it.



Do not turn uncertain details into facts merely to make a listing sound better.



\## Pricing



Prefer real sold evidence when available.



If sold evidence is unavailable, clearly distinguish active asking prices, dealer prices, historical references, or estimates from actual sold prices.



Do not recommend an unrealistically high price solely because one active listing is expensive.



\## User approval boundary



A draft is not approval to publish.



Even if the user says a draft looks good, that is not approval to publish. Publishing remains unavailable until a separate safety-controlled upgrade is explicitly requested.



Never simulate or imply that a listing was published when it was only drafted.



\## Category metadata before draft creation

Before creating a real Seller Hub draft, use eBay's category metadata where available:

- Query the category condition metadata and use a valid numeric Condition ID for the selected category.
- Query the category aspect metadata and populate supported item specifics from confirmed evidence.
- Prefer required and recommended aspects first.
- Do not invent aspect values merely to fill fields.


\## Buyer-facing pricing

For this UK private-seller account, draft pricing is shopper-facing.

- Treat the requested listing price as the price the buyer should see on eBay, including eBay Buyer Protection.
- Pass that amount as `buyerPrice` to the draft tool.
- Do not manually add Buyer Protection on top.
- The connector back-calculates the underlying seller item price using the current UK private-seller Buyer Protection tiers.
- If the account becomes a business seller or eBay changes the fee schedule, update this calculation before creating further drafts.


\## Photo handling

- Listing photos may be staged only in the dedicated connector photo folder.
- Use one subfolder per item/listing so photos from different items cannot be mixed.
- When item subfolders exist, select the intended `group` explicitly before listing or uploading photos.
- Never read or upload arbitrary local file paths or traverse outside the selected group.
- Upload staged photos to eBay through the Media API before creating a draft.
- Use the returned eBay-hosted image URLs in `photoUrls`.
- Uploading a photo is permitted only as part of the explicit draft workflow; it does not authorize publishing.


\## Condition description

- For used items, populate the dedicated `conditionDescription` field with concise item-specific wear, defects, missing parts, and testing status.
- Do not leave a used item's condition description as merely "Used" when photos or evidence support a more useful factual description.
- Keep the main listing description focused on identification, specifications, included items, and buyer-relevant notes rather than duplicating the entire condition description.


\## Automatic draft queue

- The optional Drive-synced draft worker is unpublished-draft-only and must remain separately gated by `EBAY_ENABLE_DRAFT_WORKER=true`.
- It refuses to start if general write tools are enabled.
- A queued job must explicitly use `action: "create_draft"`, `confirm: true`, and `confirmationText: "create ebay draft"`.
- Jobs may reference only one safe staged photo group. Arbitrary local paths and externally supplied photo URLs are rejected.
- The worker uploads that group's photos to eBay Media, creates one unpublished Seller Hub draft, records a result, and never publishes.
- A user's explicit instruction such as "list this" may authorize creation of the unpublished draft job; it never authorizes publishing.
