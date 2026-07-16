/**
 * Shared helper for API Gateway access logging — gives every REST API an
 * audit trail of who called which endpoint when. Use
 * `apiAccessLogConfig(this, 'XApiAccessLogs')` in every RestApi's
 * `deployOptions`.
 *
 * Produces a JSON-format access log with the standard fields (request
 * id, caller principal, request time, status, integration latency) +
 * X-Ray tracing enabled. The Authorization header is redacted by API
 * Gateway by default.
 *
 * Log retention defaults to 30 days; bump for compliance regimes.
 */

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface AccessLogConfig {
  accessLogDestination: apigateway.IAccessLogDestination;
  accessLogFormat: apigateway.AccessLogFormat;
  loggingLevel: apigateway.MethodLoggingLevel;
  tracingEnabled: boolean;
}

export function apiAccessLogConfig(
  scope: Construct,
  logGroupId: string,
  retention: logs.RetentionDays = logs.RetentionDays.ONE_MONTH,
): AccessLogConfig {
  const logGroup = new logs.LogGroup(scope, logGroupId, {
    retention,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  return {
    accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
    accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
      caller: true,
      httpMethod: true,
      ip: true,
      protocol: true,
      requestTime: true,
      resourcePath: true,
      responseLength: true,
      status: true,
      user: true,
    }),
    loggingLevel: apigateway.MethodLoggingLevel.INFO,
    tracingEnabled: true,
  };
}
