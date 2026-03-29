import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import serverless from 'serverless-http';
import { createApp } from './app.js';

const app = createApp();
const handlerFn = serverless(app);

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  return handlerFn(event, context) as Promise<import('aws-lambda').APIGatewayProxyResultV2>;
};
