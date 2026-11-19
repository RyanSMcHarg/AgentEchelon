---
{ "kind": "message", "name": "runbook-decision", "description": "Customer API outage runbook, step 5: the on-call decides the failover", "language": "en", "fields": { "label": "value:text" } }
---
# chat
Runbook step 5 for {{label}}: I recommend shifting customer-api traffic to the us-west-2 standby, for the reasons above. Approve it and you make the shift ([failover](https://runbooks.example.com/stratum/customer-api-outage#failover)); decline it and the runbook goes on to the recovery check.
# email.subject
Runbook decision for {{label}}
