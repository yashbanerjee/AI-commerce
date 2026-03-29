import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class AiEbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const databaseUrl = this.node.tryGetContext('databaseUrl') ?? process.env.DATABASE_URL ?? '';
    const encryptionKey = this.node.tryGetContext('encryptionKey') ?? process.env.ENCRYPTION_KEY ?? '';
    const openaiApiKey = process.env.OPENAI_API_KEY ?? '';

    const fn = new NodejsFunction(this, 'HttpApiFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../src/lambda.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_URL: databaseUrl,
        ENCRYPTION_KEY: encryptionKey,
        OPENAI_API_KEY: openaiApiKey,
        OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
        OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        KMS_KEY_ID: process.env.KMS_KEY_ID ?? '',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            const adminSrc = path.join(inputDir, '..', 'admin', 'public');
            const adminDst = path.join(outputDir, 'admin', 'public');
            return [`mkdir -p "${path.join(outputDir, 'admin')}"`, `cp -R "${adminSrc}" "${adminDst}"`];
          },
        },
      },
    });

    // Outbound HTTPS to OpenAI (and Stripe, etc.) — no VPC endpoint required for api.openai.com
    fn.addEnvironment('AWS_NODEJS_CONNECTION_REUSE_ENABLED', '1');

    if (process.env.KMS_KEY_ID) {
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['kms:Decrypt', 'kms:Encrypt'],
          resources: [process.env.KMS_KEY_ID],
        })
      );
    }

    const httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id'],
        allowMethods: [CorsHttpMethod.ANY],
        allowOrigins: ['*'],
      },
    });

    const integration = new HttpLambdaIntegration('LambdaIntegration', fn);
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration,
    });

    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Base URL for the WordPress plugin (append /v1/...)',
    });
  }
}
