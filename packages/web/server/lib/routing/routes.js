/**
 * `/api/routing` — configuration and the Jev key. Normal authenticated
 * OpenChamber routes: do not add them to browser URL-token allowlists.
 *
 * The send-path rewrite, registered ahead of the generic OpenCode proxy. In
 * OpenCode 2.x a prompt body carries no model: the client switches the session
 * first (`POST /session/:id/model`) and sends afterwards. So the rewrite is in
 * two halves:
 *
 * - `POST /session/:id/model` with `openchamber/auto` never reaches OpenCode,
 *   which has no such provider. It marks the session as routed and answers as
 *   a switch would.
 * - `POST /session/:id/{prompt,command}` in a routed session asks Jev on the
 *   request text and switches the session onto the chosen model and agent
 *   before the prompt is forwarded.
 *
 * Both parse the JSON body only while Auto can actually be selected, so a
 * build without the flag pays nothing on the send path.
 */
import express from 'express';
import { isRoutingFeatureAvailable } from './feature-flag.js';

const MODEL_PATH = '/api/session/:sessionId/model';
const SEND_PATHS = [
  '/api/session/:sessionId/prompt',
  '/api/session/:sessionId/command',
];

const sendError = (res, error) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({ error: error?.message ?? 'Routing request failed' });
};

export function registerRoutingRoutes(app, runtime) {
  const unavailable = (res) => res.status(404).json({ error: 'Routing is not available in this build' });

  app.get('/api/routing', async (_req, res) => {
    try {
      const state = await runtime.describe();
      if (!state.available) return unavailable(res);
      res.json({ ...state, heldPermissions: runtime.heldPermissions() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing', express.json({ limit: '256kb' }), async (req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.updateConfig(req.body?.config));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/routing/token', express.json({ limit: '16kb' }), async (req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.setToken(req.body?.token));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/routing/token', async (_req, res) => {
    if (!isRoutingFeatureAvailable()) return unavailable(res);
    try {
      res.json(await runtime.clearToken());
    } catch (error) {
      sendError(res, error);
    }
  });
}

export function registerRoutingPromptRewrite(app, runtime) {
  const parseJson = express.json({ limit: '50mb' });

  /** Parses the body only for JSON requests while the flag is on. */
  const withParsedBody = (handler) => (req, res, next) => {
    if (!isRoutingFeatureAvailable()) return next();
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      handler(req, res, next);
    });
  };

  const directoryOf = (req) => {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('directory') || req.get('x-opencode-directory') || undefined;
  };

  app.post(MODEL_PATH, withParsedBody((req, res, next) => {
    const directory = directoryOf(req);
    // Swallowed, not forwarded: OpenCode has no `openchamber` provider, and the
    // real model is only known once the request text arrives.
    if (runtime.noteModelSelection(req.params.sessionId, req.body?.model, directory)) return res.status(204).end();
    next();
  }));

  app.post(SEND_PATHS, withParsedBody((req, res, next) => {
    const sessionId = req.params.sessionId;
    if (!runtime.isAutoSession(sessionId)) return next();
    const directory = directoryOf(req);
    runtime.routeSend({ sessionId, directory, body: req.body })
      .then(() => next())
      .catch((error) => sendError(res, error));
  }));
}
