/**
 * Chooses who answers the agent's `browser.*` actions: the in-app browser view
 * (through the broker) or an extension service that provides the browser
 * (`contributes.service.provides: ["browser"]`).
 *
 * The choice is the `browserProvider` setting: `builtin`, or the id of an
 * installed extension. It is read for every action, so a change in Settings
 * applies to the next action without a restart. A selected extension that can
 * no longer serve — paused, removed, approval withdrawn, or a newer version
 * without the role — is not silently kept: the setting goes back to `builtin`,
 * every client is told so it can say so, and the action runs in-app. Doing
 * that at the moment the extension is deactivated (`handleGuestDeactivated`)
 * gives the user the notice right away; doing it again on the next action
 * covers everything else, such as a folder install that went missing.
 *
 * The service is a host-spawned loopback process, so the proxy that panels
 * use serves here too. It starts the process on the first action, which is
 * what lets an agent browse with no panel open, and stops it after
 * `BROWSER_PROVIDER_IDLE_MS` without actions.
 */

import {
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_IDLE_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
  BROWSER_PROVIDER_PATH,
  BROWSER_PROVIDER_RESPONSE_MAX,
  isGuestApproved,
  requestedGuestCapabilities,
  serviceProvides,
} from '@openchamber/sdk';
import { browserProviderResultSchema } from '@openchamber/sdk/schemas';

import { GuestServiceError, proxyGuestServiceRequest } from '../guests/service.js';
import { BrowserControlError } from './broker.js';

const BUILTIN_BROWSER_PROVIDER = 'builtin';

/**
 * Whether this catalog row can answer browser actions right now. Mirrors what
 * the Settings dropdown offers: enabled, fully approved, and declaring the
 * role. The `service` grant is implied by full approval.
 */
export const isBrowserProviderGuest = (guest) => (
  Boolean(guest)
  && guest.enabled !== false
  && serviceProvides(guest.service, 'browser')
  && isGuestApproved({
    requested: requestedGuestCapabilities(guest),
    granted: Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [],
  })
);

/**
 * @param {{
 *   broker: { request: Function },
 *   readSettings: () => Promise<Record<string, unknown> | null>,
 *   persistSettings: (changes: Record<string, unknown>) => Promise<unknown>,
 *   findGuest: (id: string) => Promise<object | null>,
 *   persistPath: string,
 *   emitProviderReset: (event: { guestId: string, guestName: string }) => void,
 *   createId: () => string,
 *   proxyServiceRequest?: typeof proxyGuestServiceRequest,
 *   surfaceControl?: { userControls: (guestId: string) => boolean, noteAgentActivity: (guestId: string) => void },
 * }} deps `surfaceControl` is the shared-surface lease: an action is refused
 * while the user is driving the extension's surface, and every action the
 * provider runs counts as agent activity there.
 */
export const createBrowserControlRouter = ({
  broker,
  readSettings,
  persistSettings,
  findGuest,
  persistPath,
  emitProviderReset,
  createId,
  proxyServiceRequest = proxyGuestServiceRequest,
  surfaceControl = { userControls: () => false, noteAgentActivity: () => undefined },
}) => {
  // `browserProvider` was sanitized on write (settings-helpers.js keeps a
  // trimmed non-empty string), so the only decision left is builtin or not.
  const selectedProviderId = async () => {
    const settings = await readSettings().catch(() => null);
    const value = settings?.browserProvider ?? BUILTIN_BROWSER_PROVIDER;
    return value === BUILTIN_BROWSER_PROVIDER ? null : String(value);
  };

  const resetToBuiltin = async ({ guestId, guestName }) => {
    await persistSettings({ browserProvider: BUILTIN_BROWSER_PROVIDER });
    emitProviderReset({ guestId, guestName });
  };

  const requestFromProvider = async (guest, action, parameters, { signal, timeoutMs }) => {
    if (surfaceControl.userControls(guest.id)) {
      // Read by the agent: the page is being used by a person right now.
      throw new BrowserControlError(
        'The user is interacting with this page in the panel right now, so the action was not run. '
        + 'Wait for them to hand control back, or ask them to. Nothing was changed.',
        409,
      );
    }
    surfaceControl.noteAgentActivity(guest.id);
    const requestId = createId();
    let proxied;
    try {
      proxied = await proxyServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'POST',
        path: BROWSER_PROVIDER_PATH,
        body: JSON.stringify({ requestId, action, parameters }),
        timeoutMs: timeoutMs ?? (action === 'browser.open' ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS : BROWSER_PROVIDER_ACTION_TIMEOUT_MS),
        responseMax: BROWSER_PROVIDER_RESPONSE_MAX,
        idleStopMs: BROWSER_PROVIDER_IDLE_MS,
        signal,
      });
    } catch (error) {
      if (error instanceof GuestServiceError) {
        // Read by the agent: what happened and that the page is untouched.
        throw new BrowserControlError(
          `The browser provider "${guest.name}" could not run this action (${error.code}): ${error.message} Nothing was changed.`,
          503,
        );
      }
      throw error;
    }
    if (proxied.status !== 200) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered HTTP ${proxied.status} instead of a result. Nothing is known about the page.`,
        502,
      );
    }
    let parsed;
    try {
      parsed = browserProviderResultSchema.safeParse(JSON.parse(proxied.body));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered something that is not a browser result. Nothing is known about the page.`,
        502,
      );
    }
    if (!parsed.data.ok) {
      throw new BrowserControlError(parsed.data.error, 400);
    }
    return parsed.data.data;
  };

  return {
    /** Same signature as the broker; the control service does not know which path ran. */
    async request(action, parameters = {}, options = {}) {
      const providerId = await selectedProviderId();
      if (!providerId) {
        return broker.request(action, parameters, options);
      }
      const guest = await findGuest(providerId).catch(() => null);
      if (!isBrowserProviderGuest(guest)) {
        await resetToBuiltin({ guestId: providerId, guestName: guest?.name ?? providerId });
        return broker.request(action, parameters, options);
      }
      return requestFromProvider(guest, action, parameters, options);
    },

    /**
     * Called when an extension is paused, removed, or loses approval. The
     * catalog may not reflect the change yet, so this does not re-check it:
     * the selection alone decides.
     */
    async handleGuestDeactivated({ guestId, guestName }) {
      const providerId = await selectedProviderId();
      if (providerId !== guestId) return false;
      await resetToBuiltin({ guestId, guestName: guestName || guestId });
      return true;
    },
  };
};
