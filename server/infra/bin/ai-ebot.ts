#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AiEbotStack } from '../lib/ai-ebot-stack';

const app = new cdk.App();
new AiEbotStack(app, 'AiEbotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
