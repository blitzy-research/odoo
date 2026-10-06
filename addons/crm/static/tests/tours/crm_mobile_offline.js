import { ConnectionLostError, rpcBus } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { stepUtils } from "@web_tour/tour_utils";

/**
 * Tour `crm_mobile_offline`, run by `TestCrmOffline.test_crm_mobile_offline_tour`
 * (addons/crm/tests/test_crm_offline.py) at 375x667 with touch, logged in as
 * `user_sales_salesman`.
 *
 * Fixture contract with the runner (both files must keep these values): the
 * salesman's "Synced Lead" in "Generic stage", with the "Fixture Activity" To-Do.
 * Offline, the tour then:
 * - edits its expected revenue to 4242;
 * - quick-creates "Offline Lead" in the same stage;
 * - saves "Log a call" with its default Call;
 * - marks the fixture activity done, then the lead Won.
 */

const SYNCED_CARD = ".o_crm_mobile_lead_card:contains(Synced Lead)";
const OFFLINE_CARD = ".o_crm_mobile_lead_card:contains(Offline Lead)";
/** The card of "Offline Lead" once its create has replayed: a server card, nothing queued. */
const SYNCED_OFFLINE_CARD = `${OFFLINE_CARD}:not(.o_crm_mobile_lead_card_provisional):not(:has(.o_crm_mobile_pending_sync))`;
const ACTIVITY_SHEET = ".o_crm_mobile_lead_activities_sheet";
const ACTIVITY_ROWS = ".o_crm_mobile_lead_activities .o_crm_mobile_activity_row";
/** The phone header's "More" toggle, enabled and available offline (`crmMoreAvailableOffline`). */
const HEADER_MORE =
    ".o_form_view .o_statusbar_buttons button[title=More][data-available-offline]:enabled";
/** The saved name of "Offline Lead" in its form (text widget, hence a textarea). */
const OFFLINE_LEAD_SAVED_NAME =
    ".o_form_saved .o_field_widget[name=name] textarea:value(Offline Lead)";

/**
 * Whether a `console.error` argument reports a `ConnectionLostError`: the error
 * itself, or the traceback the error service logs for it, which starts with the
 * error's class name.
 *
 * @param {unknown} value first argument given to `console.error`
 * @returns {boolean}
 */
function isConnectionLostLog(value) {
    if (value instanceof Error) {
        return value.constructor.name === "ConnectionLostError";
    }
    return typeof value === "string" && value.startsWith("ConnectionLostError: ");
}

/**
 * Ids (`data.id`) of the RPCs sent and not yet answered, tracked from the tour's
 * first step until the connection is cut. The offline plugin takes its status
 * from the latest `RPC:RESPONSE`: a request sent before the cut and answered
 * after the plugin's failing offline check would set it back online.
 */
const rpcsInFlight = new Set();

/** @param {CustomEvent} ev `RPC:REQUEST` */
function onRpcRequest({ detail }) {
    rpcsInFlight.add(detail.data.id);
}

/** @param {CustomEvent} ev `RPC:RESPONSE` */
function onRpcResponse({ detail }) {
    rpcsInFlight.delete(detail.data.id);
}

/**
 * Starts tracking the RPCs in flight; `goOffline` stops it at the cut.
 */
function trackRpcsInFlight() {
    rpcsInFlight.clear();
    rpcBus.addEventListener("RPC:REQUEST", onRpcRequest);
    rpcBus.addEventListener("RPC:RESPONSE", onRpcResponse);
}

/**
 * While the connection is cut, checks it again after any response other than a
 * lost connection: the answer to a request sent before tracking started, or an
 * abort, sets the offline plugin online, and the check's failing ping sets it
 * offline again. Deferred, so it runs after the plugin's own listener; skipped
 * once `goOnline` has restored the connection.
 *
 * @param {CustomEvent} ev `RPC:RESPONSE`
 */
function recheckWhileCut({ detail }) {
    if (!(detail.error instanceof ConnectionLostError)) {
        setTimeout(() => {
            if (window.__crmMobileOfflineTourSend) {
                window.dispatchEvent(new Event("offline"));
            }
        });
    }
}

/**
 * Cuts the connection: every later XMLHttpRequest fails with an asynchronous
 * `error` event, as a real network failure does. Once every request sent before
 * the cut is answered, the window `offline` event makes the offline plugin check
 * the connection at once, instead of waiting for the next request, so the failing
 * ping is the last response it handles; until `goOnline`, any other response
 * than a lost connection makes it check again (`recheckWhileCut`). HttpCase
 * filters `ConnectionLostError` logs only after the tour has ended, so until the
 * queue-empty checkpoint the tour redirects only those logs to `console.info`.
 *
 * @returns {Object} tour step
 */
function goOffline() {
    return {
        content: "Go offline: every request now fails like a lost network",
        trigger: ".o_crm_mobile_pipeline_header",
        async run() {
            if (!window.__crmMobileOfflineTourSend) {
                window.__crmMobileOfflineTourSend = XMLHttpRequest.prototype.send;
            }
            if (!window.__crmMobileOfflineTourConsoleError) {
                const consoleError = console.error;
                window.__crmMobileOfflineTourConsoleError = consoleError;
                console.error = function (...args) {
                    if (isConnectionLostLog(args[0])) {
                        console.info("Expected while offline:", ...args);
                        return;
                    }
                    return consoleError.apply(this, args);
                };
            }
            XMLHttpRequest.prototype.send = function () {
                setTimeout(() => this.dispatchEvent(new Event("error")));
            };
            rpcBus.removeEventListener("RPC:REQUEST", onRpcRequest);
            await new Promise((resolve) => {
                const resolveWhenAnswered = () => {
                    if (!rpcsInFlight.size) {
                        rpcBus.removeEventListener("RPC:RESPONSE", resolveWhenAnswered);
                        rpcBus.removeEventListener("RPC:RESPONSE", onRpcResponse);
                        resolve();
                    }
                };
                rpcBus.addEventListener("RPC:RESPONSE", resolveWhenAnswered);
                resolveWhenAnswered();
            });
            rpcBus.addEventListener("RPC:RESPONSE", recheckWhileCut);
            window.dispatchEvent(new Event("offline"));
        },
    };
}

/**
 * Ends the connection re-checks of `goOffline`, restores the connection, then
 * clicks the offline systray, whose click checks the connection and so starts the
 * replay. The plugin's own periodic ping may reconnect first; the systray then
 * stays while the queue replays, so it is clicked only if still present.
 *
 * @returns {Object} tour step
 */
function goOnline() {
    return {
        content: "Go back online and check the connection from the offline systray",
        trigger: ".o_offline_systray",
        async run({ queryFirst, click }) {
            rpcBus.removeEventListener("RPC:RESPONSE", recheckWhileCut);
            XMLHttpRequest.prototype.send = window.__crmMobileOfflineTourSend;
            delete window.__crmMobileOfflineTourSend;
            const el = queryFirst(".o_offline_systray");
            if (el) {
                await click(el);
            }
        },
    };
}

/**
 * Restore console.error after the queue-empty checkpoint, ending the expected
 * ConnectionLostError filter.
 *
 * @returns {Object} tour step
 */
function stopIgnoringConnectionLost() {
    return {
        content: "The queue has replayed: connection-lost errors fail the tour again",
        trigger: "body:not(:has(.o_offline_systray))",
        run() {
            console.error = window.__crmMobileOfflineTourConsoleError;
            delete window.__crmMobileOfflineTourConsoleError;
        },
    };
}

/**
 * Closes the open bottom sheet through its handle and waits until it is gone.
 *
 * @param {string} name what the sheet holds, for the step descriptions
 * @returns {Object[]} tour steps
 */
function closeBottomSheet(name) {
    return [
        {
            content: `Close the ${name} sheet`,
            trigger: ".o_bottom_sheet .o_bottom_sheet_handle",
            run: "click",
        },
        {
            content: `The ${name} sheet is closed`,
            trigger: "body:not(:has(.o_bottom_sheet))",
        },
    ];
}

registry.category("web_tour.tours").add("crm_mobile_offline", {
    steps: () => [
        // ---------------------------------------------------------------------
        // Online: open the pipeline and visit the lead, so both are cached.
        // ---------------------------------------------------------------------
        {
            // toggleHomeMenu's first step is active only once the navbar toggle
            // exists, so it must be rendered before the steps below are reached.
            // From here on, goOffline() knows which requests are still in flight.
            content: "Wait for the web client navbar",
            trigger: ".o_main_navbar .o_menu_toggle",
            run: trackRpcsInFlight,
        },
        ...stepUtils
            .toggleHomeMenu()
            .map((step) => ({ content: "Open the list of all apps", ...step })),
        {
            content: "Open the CRM app (My Pipeline)",
            trigger: '.o_app_menu_sidebar li.o_app[data-menu-xmlid="crm.crm_menu_root"]',
            run: "click",
        },
        {
            content: "The mobile pipeline shows its first stage",
            trigger: ".o_crm_mobile_pipeline_header:contains(Generic stage)",
        },
        {
            content: "The synced lead has its card",
            trigger: SYNCED_CARD,
        },
        {
            content: "Open the synced lead online",
            trigger: `${SYNCED_CARD} .o_crm_mobile_lead_open:enabled`,
            run: "click",
        },
        {
            content: "The lead form is loaded, so it is cached and marked visited",
            trigger: ".o_form_view .o_form_saved .o_field_widget[name=expected_revenue] input",
        },
        {
            content: "Go back to the pipeline",
            trigger: ".o_back_button:enabled",
            run: "click",
        },
        {
            content: "The pipeline is displayed again",
            trigger: ".o_crm_mobile_pipeline_header",
        },
        {
            content: "Open the activity sheet of the synced lead online",
            trigger: `${SYNCED_CARD} .o_crm_mobile_lead_activities_button:enabled`,
            run: "click",
        },
        {
            content: "The fixture activity is listed",
            trigger: `${ACTIVITY_ROWS}:contains(Fixture Activity)`,
        },
        {
            // The Call type is cached, so logging a call offline is deterministic.
            content: "Log a call is available: the activity types are cached",
            trigger: `${ACTIVITY_SHEET} .o_crm_mobile_log_call:enabled`,
        },
        ...closeBottomSheet("activity"),

        // ---------------------------------------------------------------------
        // Go offline.
        // ---------------------------------------------------------------------
        goOffline(),
        {
            content: "The offline systray shows the lost connection",
            trigger: ".o_offline_systray",
        },
        {
            // Going offline reloads the visited registry asynchronously, and a lead
            // opens offline only once it is known there. The framework's offline
            // search toggler renders only after it has awaited that registry, so
            // its presence proves the visited lead is now openable.
            content: "The pipeline switched to its offline search toggler",
            trigger: ".o_control_panel_navigation button[data-available-offline]:has(.fa-search)",
        },

        // ---------------------------------------------------------------------
        // Offline edit of the synced lead, queued as web_save.
        // ---------------------------------------------------------------------
        {
            content: "Open the synced lead offline",
            trigger: `${SYNCED_CARD} .o_crm_mobile_lead_open:enabled`,
            run: "click",
        },
        {
            content: "The lead form is served from the cache",
            trigger: ".o_form_view .o_form_saved .o_field_widget[name=expected_revenue] input",
        },
        {
            content: "Edit the expected revenue offline",
            trigger: ".o_form_view .o_field_widget[name=expected_revenue] input",
            run: "edit 4242",
        },
        {
            // Leaving the input commits the typed value to the record.
            content: "Leave the expected revenue field",
            trigger: ".o_form_view .o_form_sheet_bg",
            run: "click",
        },
        {
            content: "The lead form holds the unsaved change",
            trigger: ".o_form_view .o_form_dirty",
        },
        {
            content: "Save the lead offline",
            trigger: ".o_form_status_indicator .o_form_button_save:enabled",
            run: "click",
        },
        {
            content: "The save is queued and the form shows it saved",
            trigger: ".o_form_view .o_form_saved",
        },
        {
            content: "Go back to the pipeline offline",
            trigger: ".o_back_button:enabled",
            run: "click",
        },
        {
            content: "The synced lead card shows its queued write",
            trigger: `${SYNCED_CARD} .o_crm_mobile_pending_sync:contains(Pending sync)`,
        },

        // ---------------------------------------------------------------------
        // Offline quick create, queued as web_save of a new record.
        // ---------------------------------------------------------------------
        {
            content: "Open the mobile quick create offline",
            trigger: ".o_crm_mobile_pipeline_header .o_crm_mobile_pipeline_new:enabled",
            run: "click",
        },
        {
            content: "Enter the name of the new lead",
            trigger: "form.o_crm_mobile_quick_create input[name=name]",
            run: "edit Offline Lead",
        },
        {
            content: "Choose its stage",
            trigger: "form.o_crm_mobile_quick_create select[name=stage_id]:enabled",
            run: "selectByLabel Generic stage",
        },
        {
            content: "Save the new lead offline",
            trigger: "form.o_crm_mobile_quick_create .o_crm_mobile_quick_create_save:enabled",
            run: "click",
        },
        {
            content: "The quick create sheet is closed",
            trigger: "body:not(:has(.o_bottom_sheet))",
        },
        {
            content: "The new lead shows as a provisional card pending sync",
            trigger: `${OFFLINE_CARD}.o_crm_mobile_lead_card_provisional .o_crm_mobile_pending_sync:contains(Pending sync)`,
        },
        {
            content: "The provisional card cannot be opened before it is synced",
            trigger: `${OFFLINE_CARD} .o_crm_mobile_lead_open:disabled`,
        },
        {
            content: "The provisional card cannot be given activities before it is synced",
            trigger: `${OFFLINE_CARD} .o_crm_mobile_lead_activities_button:disabled`,
        },

        // ---------------------------------------------------------------------
        // Offline activities: log a call (create), mark the fixture done.
        // ---------------------------------------------------------------------
        {
            content: "Open the activity sheet of the synced lead offline",
            trigger: `${SYNCED_CARD} .o_crm_mobile_lead_activities_button:enabled`,
            run: "click",
        },
        {
            content: "The activity sheet lists the cached fixture activity",
            trigger: `${ACTIVITY_ROWS}:contains(Fixture Activity)`,
        },
        {
            content: "Log a call offline",
            trigger: `${ACTIVITY_SHEET} .o_crm_mobile_log_call:enabled`,
            run: "click",
        },
        {
            content: "The call form opens with its defaults",
            trigger: `${ACTIVITY_SHEET} .o_crm_mobile_activity_form`,
        },
        {
            content: "Save the call offline",
            trigger: `${ACTIVITY_SHEET} .o_crm_mobile_activity_form .o_crm_mobile_activity_save:enabled`,
            run: "click",
        },
        {
            // The fixture row is a To-Do: only the queued call is a pending row.
            content: "The logged call shows as pending sync",
            trigger: `${ACTIVITY_ROWS}.o_crm_mobile_activity_pending:contains(Call) .o_crm_mobile_pending_sync:contains(Pending sync)`,
        },
        {
            content: "Mark the fixture activity done offline",
            trigger: `${ACTIVITY_ROWS}:contains(Fixture Activity) .o_crm_mobile_activity_done:enabled`,
            run: "click",
        },
        {
            content: "The fixture activity shows Done, pending sync",
            trigger: `${ACTIVITY_ROWS}.o_crm_mobile_activity_done_pending:contains(Fixture Activity) .o_crm_mobile_activity_done:disabled:contains(Done):contains(Pending sync)`,
        },
        ...closeBottomSheet("activity"),

        // ---------------------------------------------------------------------
        // Offline mark won, queued as action_set_won.
        // ---------------------------------------------------------------------
        {
            content: "Open the synced lead offline again",
            trigger: `${SYNCED_CARD} .o_crm_mobile_lead_open:enabled`,
            run: "click",
        },
        {
            // A header button before Won (such as sale_crm's New Quotation) moves Won
            // into More; its toggle stays available offline while holding Won.
            content:
                "Reach Won offline, under the header's More toggle when another button comes first",
            trigger: `.o_form_view button[name=action_set_won_rainbowman]:enabled, ${HEADER_MORE}`,
            async run({ queryFirst, click }) {
                if (!queryFirst(".o_form_view button[name=action_set_won_rainbowman]")) {
                    await click(queryFirst(HEADER_MORE));
                }
            },
        },
        {
            content: "Mark the lead won offline",
            trigger:
                ".o_form_view button[name=action_set_won_rainbowman]:enabled, .o-dropdown--menu button[name=action_set_won_rainbowman]:enabled",
            run: "click",
        },
        {
            content: "The lead shows the Won ribbon at once",
            trigger: ".o_form_view .ribbon span:contains(Won)",
        },
        {
            // Under "More", a gone "Won" also leaves the toggle without the offline
            // attribute it carried while holding "Won".
            content: "The Won button is gone",
            trigger:
                ".o_form_view:not(:has(button[name=action_set_won_rainbowman])):not(:has(.o_statusbar_buttons button[title=More][data-available-offline]))",
        },
        {
            content: "No rainbowman is shown offline",
            trigger: "body:not(:has(.o_reward_rainbow))",
        },

        // ---------------------------------------------------------------------
        // Reconnect: the queue replays, then the created lead is a server record.
        // ---------------------------------------------------------------------
        goOnline(),
        {
            // _syncORM waits 1 s between calls; a parked (rejected) call keeps the
            // systray, so this step fails if any replay is rejected.
            content: "Every queued call has replayed: no offline systray remains",
            trigger: "body:not(:has(.o_offline_systray))",
            timeout: 30000,
        },
        stopIgnoringConnectionLost(),
        {
            content: "Go back to the pipeline online",
            trigger: ".o_back_button:enabled",
            run: "click",
        },
        {
            content: "The created lead is now a synced server card",
            trigger: `${SYNCED_OFFLINE_CARD} .o_crm_mobile_lead_open:enabled`,
        },
        {
            content: "Open the created lead",
            trigger: `${SYNCED_OFFLINE_CARD} .o_crm_mobile_lead_open:enabled`,
            run: "click",
        },
        {
            // A pending opportunity: its form shows the Won button, or, when another
            // addon's header button comes first, the "More" toggle holding it, the
            // one that carries the offline attribute. The lead form renders its name
            // with the text widget, hence a textarea.
            content: "The server record of the created lead opens in its form",
            trigger: [
                `.o_form_view:has(button[name=action_set_won_rainbowman]) ${OFFLINE_LEAD_SAVED_NAME}`,
                `.o_form_view:has(.o_statusbar_buttons button[title=More][data-available-offline]) ${OFFLINE_LEAD_SAVED_NAME}`,
            ].join(", "),
        },
    ],
});
