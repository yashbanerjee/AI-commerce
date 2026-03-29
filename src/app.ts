import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { handleCreateCheckoutSession, handleStripeWebhook } from './billingStripe.js';
import {
  handleRegister,
  handleIngest,
  handleChat,
  handleHeartbeat,
  handleTenantBilling,
  handleAdminMetrics,
  handleAdminStatus,
  handleAdminConfig,
  handleAdminSetOpenAiKey,
  handleAdminDeleteOpenAiKey,
  handleAdminTenants,
  handleAdminTenantChatQuotaPatch,
  handleAdminBillingPlans,
  handleAdminBillingPlanUpsert,
  handleAdminTenantBillingPatch,
} from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `tsx src/server.ts` runs from `src/`; production uses `dist/` — admin assets live at repo `admin/public`. */
function resolveAdminPublic(): string {
  const nextToThis = path.join(__dirname, 'admin', 'public');
  const repoRoot = path.join(__dirname, '..', 'admin', 'public');
  if (existsSync(path.join(nextToThis, 'index.html'))) return nextToThis;
  if (existsSync(path.join(repoRoot, 'index.html'))) return repoRoot;
  return nextToThis;
}

export function createApp(): express.Express {
  const app = express();
  app.post('/v1/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    void handleStripeWebhook(req, res);
  });
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/v1/register', (req, res) => {
    void handleRegister(req, res);
  });
  app.post('/v1/ingest', (req, res) => {
    void handleIngest(req, res);
  });
  app.post('/v1/chat', (req, res) => {
    void handleChat(req, res);
  });
  app.post('/v1/heartbeat', (req, res) => {
    void handleHeartbeat(req, res);
  });
  app.get('/v1/tenant/billing', (req, res) => {
    void handleTenantBilling(req, res);
  });
  app.post('/v1/billing/create-checkout-session', (req, res) => {
    void handleCreateCheckoutSession(req, res);
  });

  app.get('/v1/admin/status', (req, res) => {
    void handleAdminStatus(req, res);
  });
  app.get('/v1/admin/metrics/summary', (req, res) => {
    void handleAdminMetrics(req, res);
  });
  app.get('/v1/admin/config', (req, res) => {
    void handleAdminConfig(req, res);
  });
  app.post('/v1/admin/settings/openai-key', (req, res) => {
    void handleAdminSetOpenAiKey(req, res);
  });
  app.delete('/v1/admin/settings/openai-key', (req, res) => {
    void handleAdminDeleteOpenAiKey(req, res);
  });
  app.get('/v1/admin/tenants', (req, res) => {
    void handleAdminTenants(req, res);
  });
  app.patch('/v1/admin/tenants/:tenantId/chat-quota', (req, res) => {
    void handleAdminTenantChatQuotaPatch(req, res);
  });
  app.patch('/v1/admin/tenants/:tenantId/billing', (req, res) => {
    void handleAdminTenantBillingPatch(req, res);
  });
  app.get('/v1/admin/billing-plans', (req, res) => {
    void handleAdminBillingPlans(req, res);
  });
  app.put('/v1/admin/billing-plans/:slug', (req, res) => {
    void handleAdminBillingPlanUpsert(req, res);
  });

  const adminPublic = resolveAdminPublic();

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const base = req.originalUrl.split('?')[0] ?? '';
    if (base === '/admin') {
      res.redirect(302, '/admin/');
      return;
    }
    next();
  });
  app.use(
    '/admin',
    express.static(adminPublic, {
      index: 'index.html',
      redirect: false,
    })
  );
  app.use('/admin', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (path.extname(req.path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(adminPublic, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  return app;
}
