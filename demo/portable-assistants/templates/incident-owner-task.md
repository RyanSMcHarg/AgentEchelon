---
{ "kind": "message", "name": "incident-owner-task", "description": "Told privately to the on-call who owns an incident, in its conversation and by email: what it is, the steps, and when to resolve it", "language": "en", "fields": { "label": "value:text" } }
---
# chat
You own the incident for {{label}}. It stays open until you resolve it with the button on this card.

Advisor and I will run the [Customer API outage runbook](https://runbooks.example.com/stratum/customer-api-outage) with you. Every decision and change is yours, on a card:
1. First look: I read the deployment's health and post what stands out.
2. Incident call: start it from the offer I post next; it rings everyone here.
3. Customer impact: Advisor lists the affected customers and their account contacts.
4. Account teams: bring them into the call from the card Advisor offers you.
5. Mitigation: I recommend the runbook's action; you decide and make the change.
6. Customer messaging: where customers are impacted, customer messaging opens beside the incident for the account team, who draft and approve each notice there. The incident never waits on it.
7. Recovery: I confirm it from the metrics.

Resolve it once the alarm is back to OK, and open the [post-incident review](https://runbooks.example.com/stratum/customer-api-outage#review). The team's conversation is told it is resolved.
# email.subject
You own the incident for {{label}}
