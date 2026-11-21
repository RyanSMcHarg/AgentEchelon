---
{ "kind": "message", "name": "customer-impact", "description": "Customer API outage runbook, step 3: Advisor lists the affected customers and their account contacts", "language": "en", "fields": { "label": "value:text" } }
---
# chat
Runbook step 3 for {{label}}: first say in one or two plain sentences what customers experience, as the first look above reads it from the metrics and the service's description: which actions users cannot take or that are slow (for example signing in or running a workflow), by how much, since when. Then: which customer accounts are in US East, where the first look above places the outage? List each with its CSM, ARR and renewal, and offer to bring their account teams into the call.
