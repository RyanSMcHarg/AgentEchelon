/**
 * TLS config for direct connections to the Aurora *cluster* endpoint.
 *
 * The cluster endpoint presents a certificate signed by the Amazon RDS private
 * CA, which is NOT in Node's default trust store — so `ssl: { rejectUnauthorized:
 * true }` alone fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY (which silently
 * broke schema-init + iam-auth-setup: they never connected, so the schema was
 * never created). The RDS global CA bundle (`certs/rds-bundle.pem`) is copied
 * into each Lambda bundle by the stack's commandHooks; load it and verify
 * against it. (The query path goes through RDS Proxy, whose cert IS publicly
 * trusted, so it doesn't need this.)
 */
import * as fs from 'fs';
import * as path from 'path';

let cachedCa: string | undefined;

export function rdsClusterSsl(): { ca: string; rejectUnauthorized: true } {
  if (!cachedCa) {
    cachedCa = fs.readFileSync(path.join(__dirname, 'certs', 'rds-bundle.pem'), 'utf-8');
  }
  return { ca: cachedCa, rejectUnauthorized: true };
}

