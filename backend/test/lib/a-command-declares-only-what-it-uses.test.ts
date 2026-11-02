/**
 * A DECLARED EXPRESSION NAME THAT NO EXPRESSION USES IS A REJECTED WRITE.
 *
 * DynamoDB refuses an `ExpressionAttributeNames` entry (and an `ExpressionAttributeValues` entry)
 * that the command's expressions never reference: "Value provided in ExpressionAttributeNames unused
 * in expressions: keys: {#ttl}". It is not a warning and not a partial write - the call throws.
 *
 * ── WHY THIS IS A SOURCE SCAN AND NOT A UNIT TEST ────────────────────────────────────────────────
 *
 * Because a unit test could not see it. Every turn-lock test mocks `send`, and a mock accepts any
 * shape it is handed - so the suite stayed green while TWO writes threw on every deployment:
 *
 *  - `enqueueMessage` kept `#ttl`/`:ttl` after the TTL refresh was deliberately removed from its
 *    expression. Every enqueue threw, the caller reported the message as ANSWERED rather than queued,
 *    and the queue silently degraded into exactly the doubling it exists to prevent.
 *  - the notice claim kept them too. That claim is what stops a burst drawing several notices, so its
 *    failure returned the duplicate notices a comment three lines above says it was added to stop.
 *
 * Both were found by reading a deployment's logs (2026-08-28), not by the suite. This scan is the
 * cheap mechanical guard for the whole class: it reads the source the way DynamoDB reads the request.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Files whose DynamoDB commands this guard reads. Add a file when it starts building commands. */
const FILES = [
  'lambda/src/lib/turn-lock.ts',
];

const ROOT = path.resolve(__dirname, '..', '..');

interface Unused { file: string; command: number; kind: 'name' | 'value'; key: string }

/**
 * Every command literal in a file, with the expression text it references and the names/values it
 * declares. Deliberately literal-only: a command whose expression is built in a variable is skipped
 * rather than guessed at, because a guess here would produce a failure nobody can act on.
 */
function unusedDeclarations(file: string): Unused[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found: Unused[] = [];
  const parts = src.split(/new (?:Update|Put|Get|Query|Delete)Command\(\{/).slice(1);

  /**
   * Every quoted fragment of an expression property, joined.
   *
   * A condition assembled with `'a' + ' OR b'` is one expression to DynamoDB and was two invisible
   * halves to an earlier version of this scan, which then reported the second half's placeholders as
   * unused. Reading to the end of the property and taking every fragment is what makes that agree.
   */
  const expressionText = (body: string, src: string): string => {
    const keys = /(?:Update|Condition|KeyCondition|Filter|Projection)Expression:\s*/g;
    let out = '';
    let m: RegExpExecArray | null;
    while ((m = keys.exec(body))) {
      const rest = body.slice(m.index + m[0].length);
      const end = rest.search(/,\s*\n\s*[A-Za-z]+:|,\s*\n\s*\}/);
      const value = end === -1 ? rest.slice(0, 200) : rest.slice(0, end);
      for (const q of value.matchAll(/'([^']*)'/g)) out += q[1] + ' ';

      // AND THE CLAUSES ASSEMBLED IN A VARIABLE. A condition built as `clauses.join(' OR ')` is one
      // expression to DynamoDB and was invisible here, so every placeholder only that condition used
      // was reported unused - a false alarm on exactly the pattern a conditional claim needs. The
      // declaration is read the same way a name map's is.
      for (const id of value.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*join\s*\(/g)) {
        const decl = src.match(new RegExp('const\\s+' + id[1] + '[^=]*=\\s*\\[([\\s\\S]*?)\\];'));
        if (decl) for (const q of decl[1].matchAll(/'([^']*)'/g)) out += q[1] + ' ';
        // Clauses pushed on later, conditionally, are part of the same expression.
        const pushes = src.matchAll(new RegExp(id[1] + '\\.push\\(\\s*\'([^\']*)\'', 'g'));
        for (const q of pushes) out += q[1] + ' ';
      }
    }
    return out;
  };

  /**
   * The name or value map, whether written inline or built in a variable just above.
   *
   * The variable form is not academic: it is where the third instance of this defect lived, declaring
   * an unused `#ttl` beside a used `#qs`, and it went unseen because an inline-only scan skipped it.
   */
  const mapBody = (body: string, src: string, key: string): string | null => {
    const inline = body.match(new RegExp(key + ':\\s*\\{([\\s\\S]*?)\\n?\\s*\\},'));
    if (inline) return inline[1];
    const named = body.match(new RegExp(key + ':\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,'));
    if (!named) return null;
    const decl = src.match(new RegExp('const\\s+' + named[1] + '[^=]*=\\s*\\{([\\s\\S]*?)\\};'));
    return decl ? decl[1] : null;
  };

  parts.forEach((part, i) => {
    const body = part.split(/\n\s*\}\)\);/)[0] ?? '';
    const exprs = expressionText(body, src);
    if (!exprs) return;

    const names = mapBody(body, src, 'ExpressionAttributeNames');
    if (names) {
      for (const m of names.matchAll(/'(#[A-Za-z0-9_]+)'/g)) {
        if (!exprs.includes(m[1])) found.push({ file, command: i + 1, kind: 'name', key: m[1] });
      }
    }
    const values = mapBody(body, src, 'ExpressionAttributeValues');
    if (values) {
      for (const m of values.matchAll(/'(:[A-Za-z0-9_]+)'/g)) {
        if (!exprs.includes(m[1])) found.push({ file, command: i + 1, kind: 'value', key: m[1] });
      }
    }
  });
  return found;
}

describe('a DynamoDB command declares only what its expressions use', () => {
  it.each(FILES)('%s has no unused expression names or values', (file) => {
    const unused = unusedDeclarations(file);
    const described = unused.map((u) => `${u.file} command #${u.command}: unused ${u.kind} ${u.key}`);

    expect(described).toEqual([]);
  });

  it('detects an unused name, so a green result means the scan is looking', () => {
    // The guard is only worth having if it fails on the real defect. This is that defect, in the
    // exact shape it shipped in: a TTL name left behind after the expression stopped using it.
    const sample = `
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        UpdateExpression: 'SET queued = list_append(if_not_exists(queued, :empty), :one)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':empty': [], ':one': [messageId] },
      }));
    `;
    const tmp = path.join(ROOT, 'lambda', 'src', 'lib', '__unused-decl-fixture.ts');
    fs.writeFileSync(tmp, sample);
    try {
      const found = unusedDeclarations('lambda/src/lib/__unused-decl-fixture.ts');
      expect(found).toContainEqual(
        expect.objectContaining({ kind: 'name', key: '#ttl' }),
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
