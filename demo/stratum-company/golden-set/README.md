# Sample golden-set uploads

Three files for the demo `analyst` assistant (the standard classification), for trying an upload in the console's Versions section or through `POST .../profiles/golden-set-import` ([ADR-065](../../../docs/design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md) decision 7). The format is in [The golden set a draft is measured on](../../../docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#the-golden-set-a-draft-is-measured-on).

| File | What it shows |
|---|---|
| `analyst-valid.jsonl` | Seven entries across four intents, one with preceding turns and a reply preference. One request carries an email address, which is stored as `[an email address removed]`. Uploads as seven capability entries |
| `analyst-invalid.jsonl` | Eight bad lines out of nine: malformed JSON, a line that is not an object, an unknown column, a missing request, an intent the assistant does not serve, a turn with a role other than user or assistant, a reply preference outside the registry, and a duplicate of line 1. The upload is refused with each line named, and nothing is stored |
| `analyst-incomplete-coverage.csv` | Four valid entries, all for `report_generation` and `data_extraction`. It uploads; with a version declaring `"goldenSet": { "minRegressionPerIntent": 1 }` active, the gate refuses the next draft as `GOLDEN_SET_THIN`, naming the intents with no regression entry |

Uploaded entries enter as capability, so the third file thins nothing on its own: promote an entry to regression after a run the active version passes, and the intents still without one are the ones named.
