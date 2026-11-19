# How to create and maintain assistant context

**Audience:** whoever decides what an assistant knows and keeps that information current.

Context is what an assistant reads beyond the message it is answering. This guide covers how to put each kind of context in place, how to keep it current and how to confirm the assistant is reading it. The mechanics behind each kind are in [GUIDE-ASSISTANT-CONTEXT](../developer/GUIDE-ASSISTANT-CONTEXT.md).

## People, assistants and conversations are AWS resources

Every person, assistant and conversation is an AWS resource with an ARN, and all three sit on one control plane. The IAM that decides who may join a conversation and who may act as whom also decides what an assistant may read on that conversation's behalf. RAG passages add a database boundary, and a person receives context through the conversations they belong to.

| What it is | AWS resource | What enforces access |
|---|---|---|
| A person | AppInstanceUser | IAM, on the `person` and `classification` tags of the session their credential carries |
| An assistant | AppInstanceBot | IAM, on the `assistant`, `classification`, `role` and `bot` tags of the session it acts through, inside its permission boundary |
| A conversation | Channel | IAM, on the `classification` tag of the channel |
| Shared context | An S3 folder, a named resource or a RAG passage | IAM on the folder or resource, or a database reader role and row-level security for RAG passages |

Build your context around these resources. Key a person's records to their AppInstanceUser id, the `personId` a context source receives, and map your own customer ids to it in one place. Put what a group may read under its classification, so the same boundary that governs its conversations governs its content.

## Choose where each piece of context belongs

Start from what the assistant needs to know, then pick the row that matches.

| What the assistant needs | Where it goes | How it stays current |
|---|---|---|
| Records that change and belong to one person, such as their orders or account | [Your own system, read through a context source](#records-in-a-system-you-already-run) | Your system is the record, and the assistant reads it on each turn |
| Whole documents a group of people may read, such as policies or price lists | [Company documents](#company-documents) | You replace the file and update the menu |
| A larger body of text to search by relevance, such as a wiki or runbooks | [RAG context](#rag-context) | Uploading a changed file re-indexes it |
| Shared content that changes often, such as articles or a product catalog | [Published into RAG context by your own process](#content-that-changes-often) | Each change in your system writes the new version |
| A small value every reply should know, such as a current notice | [A parameter or stored file, read through a context source](#records-in-a-system-you-already-run) | You change the value |
| What a person tells you about themselves | [Onboarding answers](#what-people-tell-you) | The person answers once, and the answers are stored for them |
| What has been said in this conversation | Read automatically, with a running summary for long conversations in Aurora mode | The conversation itself |

Keep sensitive records in the system that owns them and read them there, so that system's access controls still apply.

Put documents in the places above and keep the persona to how the assistant behaves, because the persona is sent on every turn.

## Decide who may read it

Access to documents and named resources is decided by IAM from tags and folder paths, and access to RAG passages by a database reader role. When an assistant runs, its session carries the tags `classification`, `role`, `assistant` and `bot`, and a conversation carries a `classification` tag. Documents are organized by folder: each classification's stack writes IAM statements that name the folders it may read, and a role limit adds a condition on the session's `role` tag. You choose the folder and declare the role, and the platform applies the tags and writes the statements.

| Restrict to | Company documents | RAG context | Context sources |
|---|---|---|---|
| A classification | The folder `context/<classification>/`, enforced by IAM | The folder `rag/<type>/<classification>/`, enforced by a database reader role and row-level security | Returned for that classification from `contextSourceCatalog(ctx)`, with IAM granted on the source's resource |
| A role within a classification | `roleContext` on the classification, enforced by the session's `role` tag | Shared by every role in the classification | An `s3-prefix` source under `context/` follows `roleContext`, and every other source is shared by every role in the classification |
| One assistant | Off when its version has a `tools` list without `load_company_context` and a `contextSources` list without `company-docs`, enforced by a session policy | Shared by every assistant in the classification | Applied by its version's selection, with IAM granting the source to every assistant in the classification |

An assistant reads a classification's content when the conversation's classification grants that one, and people receive it through the conversations they belong to. Content that several classifications should read goes in one classification they all grant, or in each of them if they grant nothing in common.

### Limit a role to some folders

Set `roleContext` on the classification, listing the classifications each limited role reads. Each must be one the classification grants, and a role that is not listed reads all of them. The change is a deploy of that classification's `Assistants` stack. In the console, **Role reach** on an assistant's **Tools and context** section shows what it may read, and **Retrieval reach** shows the classification's.

For example, the sample deployment's operations assistant works in `premium` conversations with this limit:

```ts
{ value: 'premium', grants: ['basic', 'standard', 'premium'], roles: ['primary', 'ops'], roleContext: { ops: ['basic', 'standard'] } }
```

The stack allows reading `context/basic/*` and `context/standard/*` on the condition that `aws:PrincipalTag/role` is a role allowed to read them, so IAM refuses that assistant `context/premium/`. Adding a role is covered in [adding a role](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#5b-adding-a-role).

### Documents for one assistant

A classification folder is the smallest unit a document can be limited to, so documents for one assistant alone call for a classification of their own. That is a full classification, with its own assistant, models and stack, and the people whose classification grants it can open its conversations. Weigh that against keeping the documents in a shared folder, or against serving them from a [context source](#records-in-a-system-you-already-run) that only that classification publishes.

## Company documents

A company document is a text file an assistant opens by name when a question needs it. The assistant is given a short menu of what exists and opens only what it needs.

### Add documents

1. Find the company bucket, the `CompanyBucketName` output of the `Conversations` stack:

```bash
aws cloudformation describe-stacks --stack-name <prefix>Conversations \
  --query "Stacks[0].Outputs[?OutputKey=='CompanyBucketName'].OutputValue" --output text
```

2. Upload each document as text under its classification's folder: `context/<classification>/<file>`. Keep each focused on one subject. An assistant reads the first 8,000 characters of a document and stops opening more once a load passes 24,000 characters, so split anything longer.
3. Write the menu for each classification to `context/<classification>/_digest.json`. It is a JSON array with one entry per document that classification may read, including documents from the other classifications it grants:

```json
[
  { "file": "returns-policy.md", "title": "Returns policy", "description": "How long a customer has to return an item, and how refunds are paid.", "classification": "support" }
]
```

`file` is the file name the assistant asks for. `description` is what it chooses by, so say what questions the document answers. Your upload process writes this file.

4. Confirm the assistant can use them. **Company documents** in the console reads "Included on every turn" when its tools include `load_company_context` and its role reads company context.

### Keep documents current

- **Change a document:** upload the new version over the old one. Assistants see it within five minutes, when their cached copy of the documents expires.
- **Add or remove a document:** add or delete the file and update `_digest.json`. The menu offered with `load_company_context` is held for the life of each running Lambda instance, so a new entry reaches an assistant as instances are replaced, including by any deploy that changes the function. A version that selects the `company-docs` source reads the menu on every turn.
- **Automate it:** have your document system write the file and regenerate the menu on each change. Both are ordinary S3 objects, so any process with write access to that prefix can do this.

Deleting a document leaves archived conversations that quoted it as they were, because the archive is the record of what was said.

## RAG context

RAG (retrieval-augmented generation) finds the passages most relevant to a question and places them in the assistant's prompt before it answers, numbered so it can cite them. Use it when documents are too many or too long to open whole. It requires Aurora mode with `enableLiveDrift` on.

**What happens on a turn.** Every message other than a greeting or an acknowledgment runs a search that combines meaning, using embeddings, with the words the question shares with each passage. Up to six passages reach the prompt. When nothing is relevant enough, the assistant answers without retrieved context.

**Who can retrieve what.** Each passage is stamped with the classification in its folder. A turn retrieves only passages whose classification the conversation's classification grants, enforced by a database reader role with row-level security and again in the query. Always name the classification in the path, because content without one takes the deployment's default.

**Where it lives.** The files in S3 are the source. The passages are held in the Aurora store and are rebuilt from those files, so re-uploading restores them.

### Add documents for RAG

Upload to `rag/<type>/<classification>/<file>`, where `<type>` is `wiki`, `doc` or `company`:

```bash
aws s3 cp ./runbooks/ s3://<company-bucket>/rag/wiki/support/ --recursive \
  --exclude "*" --include "*.md" --include "*.txt" --include "*.html"
```

Each upload is chunked and indexed automatically. Supported files are `.md`, `.markdown`, `.txt`, `.json`, `.html` and `.htm`. Convert PDF and Word files to text first. A file is limited to 200 chunks of about 1,800 characters.

RAG context is separate from company documents. For a file to be both searchable and openable by name, upload it to both places.

### Keep RAG context current

- **Change a file:** upload it again. A changed file replaces its old passages, and an unchanged one is left alone, so re-running a full sync is safe.
- **Remove a file:** delete it, and its passages are removed.

Details and failure handling are in [RAG](../developer/RAG.md).

## Content that changes often

Articles, product catalogs and similar content change often, belong to no one person and need searching. Keep them in the system where they are authored, and have that system publish each change into [RAG context](#rag-context):

1. Trigger on every change in the source, such as a DynamoDB Stream, a webhook or a publish step in a pipeline.
2. Write the full text of each item as its own file, under the one classification that every intended reader's classification grants: `rag/doc/<classification>/<item-id>.md`. Indexing starts on upload, and a changed file replaces its old passages. Classifications with no grant in common each get a copy.
3. Delete the file when an item is unpublished, which removes its passages.
4. Choose the folder when you write the file, from the item's own visibility. A draft goes under the classification that may read drafts.
5. If assistants should also open items by name, write each file under `context/<classification>/` as well and list it in that classification's [`_digest.json` menu](#add-documents).

When you read the source in bulk, page through all of its results, so that a growing catalog is written in full. Write the full text, because the assistant answers from what it retrieves. Limit write access on these folders to your publishing process, because whatever is written there reaches the prompt.

For example, a blog that keeps its posts in a DynamoDB table, and a stream on that table triggers a function on every change. It uses the same trigger and the same split by audience, and writes each audience a file of titles and short summaries: guests get published public posts, signed-in people get all published posts and administrators also get drafts.

To always show the latest few items, without searching, use a `lambda-service` [context source](#records-in-a-system-you-already-run) that returns them. The function is called with the person and classification, so it returns the same recent items whatever the question is.

## Records in a system you already run

A context source is a named read your deployment declares. Each one reads on every turn it applies to, so the value is as current as the system behind it. Each field it returns can also be used as a variable in templates and conditions, as `ctx:<source>.<field>`.

### Choose how it is read

| Type | Use it for | What the platform reads |
|---|---|---|
| `lambda-service` | Any system you can call from code, such as a CRM, an order system or your own API | Your function receives `{ "personId", "classification" }` and returns a JSON object with one property per declared field |
| `dynamodb-table` | A table with one item per person | The item whose partition key `personId` is the requesting person. String and number attributes are read, including nested paths such as `facts.company` |
| `s3-prefix` | Files at fixed names | One object per field, at the source's prefix plus the field's `from` name, or `<field>.json` when it declares none |
| `ssm-parameter` | One small value | The parameter's value, into one declared field |

`personId` is the person's AppInstanceUser id. A `lambda-service` that looks up someone in another system maps that id to its own customer record. It returns what belongs to that person, for example their open orders, and has 1.5 seconds to respond. When the person has no record, it returns a value that says so, such as "No open orders".

### Common sources

**A DynamoDB table not keyed by person.** A `dynamodb-table` source reads the partition key `personId`. For a table keyed any other way, use a `lambda-service` whose function queries the table. Grant the function read access to the table.

**A SQL database.** Use a `lambda-service` whose function runs in a network that can reach the database, and query with the mapped customer id as a bound parameter. Connect through a read-only database user limited to the tables the assistant needs.

**An external API or a CRM.** Use a `lambda-service` whose function holds the integration. Keep the vendor's credentials in AWS Secrets Manager and grant only that function access to them, so the assistant's session never holds them:

```ts
export const handler = async ({ personId, classification }) => {
  const customer = await customerIdFor(personId); // your mapping from the person to the vendor's record
  if (!customer) return { summary: 'No customer record for this person.' };
  const apiKey = await secret('crm/api-key');
  const orders = await crm.openOrders(customer, { apiKey });
  return { summary: orders.map(line).join('\n') || 'No open orders.' };
};
```

Authorize inside the function from `personId`, which the platform sets to the turn's sender, or to the person a workflow step concerns. It is empty on a workflow step that concerns no one, so handle that case. `classification` is the classification serving the turn. Each property returned must match a declared field.

### Add a context source

1. Copy `backend/lib/config/context-sources.example.ts` to `context-sources.local.ts` beside it. The local file is yours and is not tracked.
2. Add an entry to the array its `contextSourceCatalog(ctx)` function returns. Your own keys start with `x-`:

```ts
{
  key: 'x-orders',
  title: 'Open orders',
  description: 'The orders this person has placed that have not been delivered',
  useWhen: 'Answering a question about a delivery or an order',
  type: 'lambda-service',
  arn: 'arn:aws:lambda:<region>:<account>:function:<your-function>',
  locator: '<your-function>',
  trust: 'member',
  availability: 'identity-settled',
  maxBytes: 4096,
  fields: {
    summary: { type: 'string', description: 'One line per open order: number, item and delivery date' },
  },
},
```

3. Set `trust` by who wrote the value. `operator` is content your administrators control. Use `member` for anything a customer or outside person could have written, including notes and descriptions in your own systems, so it can be inserted into messages but never decides what happens. A field can declare a lower trust than its source.
4. Deploy the `Assistants` stack for each classification, with `cd backend && npm run deploy:stack -- <prefix>Assistants-<classification>`. The deploy publishes every entry the catalog function returns for that classification and grants read access to its resource, so use `ctx.classification` in the catalog function to limit a source to the classifications that should have it. The assistant's permission boundary still applies to every grant, and it admits each of these source types. An `s3-prefix` source under `context/` is read under the assistant's role instead.
5. Select it on the assistant under **Tools and context**, in a draft. A source's place in the list is its place in the prompt.
6. Activate the version. Selecting or removing a source takes effect on activation.

Each field's `description` is what the console shows on the **Variables** page, so write it for the person reading that page.

### Keep a context source current

The source reads your system each time. Changing what a source returns, or its fields, is a change to the entry and a deploy. Keep the response small and fast. A source that fails or runs out of time is left out of that turn, and the assistant still answers without it.

## What people tell you

An onboarding intake asks a person a few questions the first time they use an assistant and stores the answers for them, so later conversations do not ask again. Set it up on the assistant's version: see [how onboarding is customized](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#4-how-onboarding-is-customized). The answers reach the assistant through a context source that reads the user-profile store, which you can replace with your own system.

## Confirm it is working

- **The assistant's answer:** ask a question only that content can answer and read the reply in the conversation. **Effectiveness** shows tool use and retrieval across turns, and **Tools and context** links to each tool's logs.
- **Metrics:** the `AgentEchelon/ContextSources` CloudWatch namespace records each source's outcome by classification. `ContextSourceResolved` means the value reached the prompt. `ContextSourceFailed` carries the reason, where `denied` means access was refused and `absent` means nothing was there. `ContextSourceSkipped` with `no-record` is a person with no item in a `dynamodb-table` source, which is normal.
- **Refusal:** prove the boundary by reading as an assistant that should be refused and confirming the outcome is `denied`. The repository's `a-turn-role-is-refused-another-classifications-context-source` test shows the pattern.
- **RAG context:** an uploaded file is indexed after the upload returns, and [RAG](../developer/RAG.md) shows how to check what holds chunks.

A source that fails does not interrupt the reply, so an assistant answering without it looks like an assistant with nothing to say. Check these metrics when an answer seems to be missing what it should know.

## Status of related capabilities

Each of these is **NOT BUILT**.

- Choosing different context sources per intent. A version's sources apply to all of its turns.
- Passing a value from the conversation, such as an order number, to a context source. A source receives the person and the classification.
- Reading PDF files directly in company documents or RAG context.
- Giving one role or assistant a folder of its own within a classification.
- Reading context through a vendor connector, such as Salesforce. Use a `lambda-service` that calls the vendor.

## Example: the demo company in this repository

The demo deployment shows one way to do this. Its company, Stratum Technologies, uses the sample classifications `basic`, `standard` and `premium`.

- Its documents are in `demo/stratum-company/`, and `backend/scripts/seed-demo.ts` uploads them to `context/<classification>/`. The same script writes each `_digest.json` from `context-digest-manifest.json`, and uploads the documents again under `rag/company/<classification>/` for retrieval.
- `context-sources.example.ts` declares two sources: `company-docs`, which exposes the document menu as the variable `ctx:company-docs.digest`, and `user-profile`, a `dynamodb-table` source over the onboarding answers.

A real deployment replaces the seed script with its own upload process and declares its own classifications and sources.
