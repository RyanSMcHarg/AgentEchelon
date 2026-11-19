---
{ "kind": "message", "name": "runbook-act", "description": "Customer API outage runbook, step 5: the on-call makes the failover and confirms", "language": "en", "fields": { "label": "value:text" } }
---
# chat
Shift customer-api traffic now: set the us-east-1 weight to 0 and us-west-2 to 100 in the traffic console ([failover](https://runbooks.example.com/stratum/customer-api-outage#failover)), then confirm it with the button on this card. I'll read the metrics again once you confirm.
