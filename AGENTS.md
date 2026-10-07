\# Peacock Scout eBay Listing Draft Workflow



This repository connects to an eBay account through a hardened MCP connector.



\## Safety mode



Current operating mode is \*\*DRAFT ONLY / READ ONLY\*\*.



Do not create, edit, publish, end, revise, delete, relist, refund, send messages, add tracking, or otherwise change anything on eBay.



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



Even if the user says a draft looks good, current mode remains read-only until the connector is deliberately upgraded in a separate safety-controlled step.



Never simulate or imply that a listing was published when it was only drafted.

