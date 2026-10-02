/**
 * CRM offline and mobile support: the one module that talks to the framework
 * offline plugin on behalf of CRM.
 *
 * It provides:
 * - `useCrmOffline()`, the hook every CRM mobile component and the lead form use
 *   to read the framework queue and connection state and to queue CRM writes;
 * - the quick-create deep-link flag (`crm_quick_create` URL parameter);
 * - the activity page size remembered per mobile root load (`getCrmActivityLimit`,
 *   `setCrmActivityLimit`), a view preference holding no record data;
 * - the activity sub-fields both mobile root loads read (`CRM_ACTIVITY_SUBFIELDS`,
 *   `getCrmActivitySubfields`);
 * - the frozen DISABLE sets generated from `offline_inventory.md`;
 * - module-level, CRM-scoped guards patched into framework classes and services
 *   (view buttons, navigation, view mount, action menus, team cards, tag colours,
 *   relational autocomplete, team form).
 *
 * Design rules shared by every guard below:
 * - the plugin is the framework `OfflinePlugin`, resolved with `usePlugin`, or the
 *   instance a framework class already holds; this module owns no queue, cache,
 *   record store or connectivity detection of its own;
 * - a guard whose CRM scope is known from the call or the component itself (the
 *   record, view or current action model, button params, an action `xml_id` string
 *   or action object, a menu `xmlid`, a view type, component props) tests that
 *   scope BEFORE the offline signal is read, so components outside CRM never
 *   subscribe to it and never re-render;
 * - the two action-service entry points that cannot know their action without
 *   loading it, `doAction` with a numeric id and `loadState` (a URL or router
 *   state), read the offline signal first. Online they call the original at once.
 *   Offline they resolve the action from the sources the original reads itself,
 *   the session's stored `current_action` (`loadState` only) and the disk-cached
 *   `loadAction`, so they issue no request the action service would not issue;
 *   they stop only for a disabled CRM action or, in a state, a blocked CRM view
 *   type, and pass any other request, including an action they cannot identify
 *   (a client action, or one not cached), to the original with the same arguments;
 * - online, and outside CRM, each guard calls the original with the same
 *   arguments and returns its result unchanged (same DOM, same requests).
 */

import { onMounted, onPatched, proxy, signal, untrack, useEffect, usePlugin } from "@odoo/owl";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { browser } from "@web/core/browser/browser";
// The `loadState()` guard must inspect the state the action service itself falls
// back to when called without arguments (the web client's boot): `router.current`.
import { router } from "@web/core/browser/router";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { mergeClasses } from "@web/core/utils/classname";
import { useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { useEnv } from "@web/owl2/utils";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { CardRenderer } from "@web/views/card/card_renderer";
import { Many2ManyTagsField } from "@web/views/fields/many2many_tags/many2many_tags_field";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { KanbanDropdownMenuWrapper } from "@web/views/kanban/kanban_dropdown_menu_wrapper";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { View } from "@web/views/view";
import { ViewButton } from "@web/views/view_button/view_button";
import { actionService } from "@web/webclient/actions/action_service";
import { menuService } from "@web/webclient/menus/menu_service";

// -----------------------------------------------------------------------------
// Frozen sets (generated from offline_inventory.md, "Generated sets")
// -----------------------------------------------------------------------------

/**
 * Builds a read-only Set: `add`, `delete` and `clear` throw, and the instance is
 * frozen, so no module can widen or narrow a DISABLE set at runtime.
 *
 * @param {Iterable<string>} values
 * @returns {ReadonlySet<string>}
 */
function freezeSet(values) {
    const set = new Set(values);
    const readOnly = () => {
        throw new TypeError("CRM offline sets are read-only");
    };
    Object.defineProperties(set, {
        add: { value: readOnly },
        delete: { value: readOnly },
        clear: { value: readOnly },
    });
    return Object.freeze(set);
}

/** Models whose `call_button` requests are never issued offline. */
export const CRM_OFFLINE_BUTTON_MODELS = freezeSet([
    "crm.lead",
    "crm.team",
    "crm.stage",
    "crm.lost.reason",
    "crm.activity.report",
    "crm.lead.lost",
    "crm.lead2opportunity.partner.mass",
    "crm.merge.opportunity",
    "crm.lead.pls.update",
]);

/**
 * Buttons of other models that open CRM data or CRM configuration. `name: null`
 * matches any button name; `contextModule` additionally requires the button's
 * (or the record's) context `module` key, as the CRM settings page sets it.
 *
 * @type {ReadonlyArray<Readonly<{resModel: string, name: string|null, contextModule?: string}>>}
 */
export const CRM_OFFLINE_BUTTON_METHODS = Object.freeze([
    Object.freeze({ resModel: "res.partner", name: "action_view_opportunity" }),
    Object.freeze({ resModel: "utm.campaign", name: "action_redirect_to_leads_opportunities" }),
    Object.freeze({ resModel: "res.config.settings", name: null, contextModule: "crm" }),
]);

/** Action `xml_id`s that never open offline (forecast, reports, wizards, settings...). */
export const CRM_OFFLINE_DISABLED_ACTIONS = freezeSet([
    "crm.crm_lead_action_forecast",
    "crm.crm_opportunity_report_action",
    "crm.crm_opportunity_report_action_lead",
    "crm.crm_activity_report_action",
    "crm.crm_activity_report_action_team",
    "crm.action_report_crm_lead_salesteam",
    "crm.action_report_crm_opportunity_salesteam",
    "crm.crm_lead_lost_action",
    "crm.action_crm_send_mass_convert",
    "crm.action_merge_opportunities",
    "crm.crm_lead_pls_update_action",
    "crm.action_lead_mail_compose",
    "crm.action_lead_mass_mail",
    "crm.mail_followers_edit_action_from_lead",
    "crm.act_crm_opportunity_calendar_event_new",
    "crm.crm_config_settings_action",
    "crm.crm_recurring_plan_action",
]);

/** Menu `xmlid`s whose entries never open offline. */
export const CRM_OFFLINE_DISABLED_MENUS = freezeSet([
    "crm.crm_menu_forecast",
    "crm.crm_opportunity_report_menu",
    "crm.crm_opportunity_report_menu_lead",
    "crm.crm_activity_report_menu",
    "crm.crm_config_settings_menu",
    "crm.crm_recurring_plan_menu_config",
]);

/** View types that never open offline on the models of `CRM_OFFLINE_BLOCKED_VIEW_MODELS`. */
export const CRM_OFFLINE_BLOCKED_VIEW_TYPES = freezeSet(["graph", "pivot", "activity", "calendar"]);

/** Models whose `CRM_OFFLINE_BLOCKED_VIEW_TYPES` views never open offline. */
export const CRM_OFFLINE_BLOCKED_VIEW_MODELS = freezeSet(["crm.lead", "crm.activity.report"]);

/** CRM transient wizards: their views never mount offline (view-mount backstop). */
const CRM_WIZARD_MODELS = freezeSet([
    "crm.lead.lost",
    "crm.lead2opportunity.partner.mass",
    "crm.merge.opportunity",
    "crm.lead.pls.update",
]);

/** Record models whose `object`/`action` view buttons are disabled offline. */
const CRM_VIEW_BUTTON_MODELS = freezeSet(["crm.lead", "crm.team", "crm.stage"]);

/** Models whose Action-menu items (other than offline-available ones) are inert offline. */
const CRM_ACTION_MENU_MODELS = freezeSet([
    "crm.lead",
    "crm.team",
    "crm.stage",
    "crm.lost.reason",
    "crm.activity.report",
]);

/** `crm.lead` queue methods that write a lead the pipeline may display. */
const LEAD_WRITE_METHODS = freezeSet([
    "web_save",
    "action_set_won",
    "unlink",
    "action_archive",
    "action_unarchive",
]);

/** Lead fields `projectLead` projects (plus `won_status`/`probability` when loaded). */
const PROJECTED_FIELDS = Object.freeze([
    "name",
    "partner_id",
    "contact_name",
    "expected_revenue",
    "stage_id",
]);
const PROJECTED_OPTIONAL_FIELDS = Object.freeze(["won_status", "probability"]);

/**
 * Page size of the activity rows the mobile root load (pipeline and phone lead
 * form) reads with each lead: the first page is loaded with the lead, and an
 * explicit "Show more" of the activity sheet raises the limit by this step and
 * reloads the root, so the rows stay in the (cached) root load and no separate
 * `mail.activity` read is ever issued.
 */
export const CRM_MOBILE_ACTIVITY_LIMIT = 5;

/**
 * The single definition of the `mail.activity` sub-fields the mobile root loads
 * (pipeline and phone lead form) read with each lead's `activity_ids`, so that
 * the activity sheet has its rows in the (cached) root load. The definitions
 * match `addons/mail/models/mail_activity.py`. Deeply frozen: consumers build
 * their own definitions from it with `getCrmActivitySubfields`.
 *
 * @type {ReadonlyArray<Readonly<{name: string, type: string, relation?: string, selection?: ReadonlyArray<ReadonlyArray<string>>}>>}
 */
export const CRM_ACTIVITY_SUBFIELDS = Object.freeze([
    Object.freeze({ name: "summary", type: "char" }),
    Object.freeze({ name: "activity_type_id", type: "many2one", relation: "mail.activity.type" }),
    Object.freeze({ name: "date_deadline", type: "date" }),
    Object.freeze({ name: "user_id", type: "many2one", relation: "res.users" }),
    Object.freeze({
        name: "state",
        type: "selection",
        selection: Object.freeze([
            Object.freeze(["overdue", "Overdue"]),
            Object.freeze(["today", "Today"]),
            Object.freeze(["planned", "Planned"]),
            Object.freeze(["done", "Done"]),
        ]),
    }),
]);

/**
 * Fresh, mutable field definitions of `CRM_ACTIVITY_SUBFIELDS`, keyed by name in
 * their declaration order, each with `extraProps` added (e.g. `readonly`). Every
 * call returns new objects, selection pairs included: the model owns the
 * definitions it is given.
 *
 * @param {Object} [extraProps]
 * @returns {Object<string, Object>}
 */
export function getCrmActivitySubfields(extraProps = {}) {
    const fields = {};
    for (const field of CRM_ACTIVITY_SUBFIELDS) {
        fields[field.name] = { ...field, ...extraProps };
        if (field.selection) {
            fields[field.name].selection = field.selection.map((option) => [...option]);
        }
    }
    return fields;
}

// -----------------------------------------------------------------------------
// Activity page size preference
// -----------------------------------------------------------------------------

/** `localStorage` key of the remembered activity page sizes: JSON `{[scope]: limit}`. */
const ACTIVITY_LIMITS_STORAGE_KEY = "crm.mobile_activity_limits";
/** Most scopes whose page size is remembered: the least recently set are dropped. */
const ACTIVITY_LIMITS_MAX_SCOPES = 50;

/**
 * Tells whether `limit` is a page size worth remembering: an integer above the
 * default first page.
 *
 * @param {unknown} limit
 * @returns {boolean}
 */
function isRaisedActivityLimit(limit) {
    return Number.isInteger(limit) && limit > CRM_MOBILE_ACTIVITY_LIMIT;
}

/**
 * Remembered page sizes, `{[scope]: limit}`, in the order they were last set.
 * A missing or unreadable value (invalid JSON, not an object, storage throwing)
 * reads as no preference at all.
 *
 * @returns {Object<string, number>}
 */
function readActivityLimits() {
    try {
        const stored = JSON.parse(browser.localStorage.getItem(ACTIVITY_LIMITS_STORAGE_KEY));
        if (stored && typeof stored === "object" && !Array.isArray(stored)) {
            return stored;
        }
    } catch {
        // Unreadable preference: every scope uses the default page size.
    }
    return {};
}

/**
 * Activity page size the mobile root load of `scope` requests: the one a "Show
 * more" remembered for it, `CRM_MOBILE_ACTIVITY_LIMIT` otherwise.
 *
 * This is a view preference, persisted in `localStorage` the way the list view
 * persists its optional columns: it stores no record data, since the rows of a
 * page stay in the framework's RPC cache with the root load that read them. The
 * page size is part of that root load's request, hence of its cache key: reading
 * it from here, after a reopen or a cold start, issues the same request as the
 * last visit of `scope`, so a page reached through "Show more" online is still
 * served from the cache offline.
 *
 * A `scope` names one kind of root load whose request only differs by the page
 * size, e.g. a pipeline action and search, or a lead form.
 *
 * @param {string} scope
 * @returns {number}
 */
export function getCrmActivityLimit(scope) {
    const limit = readActivityLimits()[scope];
    return isRaisedActivityLimit(limit) ? limit : CRM_MOBILE_ACTIVITY_LIMIT;
}

/**
 * Remembers the activity page size of `scope` (see `getCrmActivityLimit`). A
 * limit that is not above `CRM_MOBILE_ACTIVITY_LIMIT` forgets the scope. The
 * scope just set becomes the most recent one, and only the
 * `ACTIVITY_LIMITS_MAX_SCOPES` most recent scopes are kept. A storage that
 * cannot be written (quota, disabled storage) leaves the preference unchanged.
 *
 * @param {string} scope
 * @param {number} limit
 */
export function setCrmActivityLimit(scope, limit) {
    try {
        const limits = {};
        for (const [storedScope, storedLimit] of Object.entries(readActivityLimits())) {
            if (storedScope !== scope && isRaisedActivityLimit(storedLimit)) {
                limits[storedScope] = storedLimit;
            }
        }
        if (isRaisedActivityLimit(limit)) {
            limits[scope] = limit;
        }
        const scopes = Object.keys(limits);
        const dropped = Math.max(scopes.length - ACTIVITY_LIMITS_MAX_SCOPES, 0);
        for (const oldScope of scopes.slice(0, dropped)) {
            delete limits[oldScope];
        }
        if (Object.keys(limits).length) {
            browser.localStorage.setItem(ACTIVITY_LIMITS_STORAGE_KEY, JSON.stringify(limits));
        } else {
            browser.localStorage.removeItem(ACTIVITY_LIMITS_STORAGE_KEY);
        }
    } catch {
        // The page size is not remembered: the next root load uses the stored one.
    }
}

// -----------------------------------------------------------------------------
// Predicates
// -----------------------------------------------------------------------------

/**
 * Tells whether a `doActionButton` request targets CRM: a model of
 * `CRM_OFFLINE_BUTTON_MODELS`, or a model/method pair of
 * `CRM_OFFLINE_BUTTON_METHODS` (the settings rule also checks `context.module`).
 * Pure: it reads no signal.
 *
 * @param {{resModel?: string, name?: string, context?: Object, buttonContext?: Object}} [params]
 * @returns {boolean}
 */
export function isCrmOfflineButtonCall(params) {
    if (!params) {
        return false;
    }
    const { resModel, name } = params;
    if (CRM_OFFLINE_BUTTON_MODELS.has(resModel)) {
        return true;
    }
    const module = params.buttonContext?.module ?? params.context?.module;
    return CRM_OFFLINE_BUTTON_METHODS.some(
        (entry) =>
            entry.resModel === resModel &&
            (entry.name === null || entry.name === name) &&
            (!entry.contextModule || entry.contextModule === module)
    );
}

/**
 * Tells whether a view button is a CRM DISABLE control: an `object`/`action`
 * button not tagged `data-available-offline`, on a lead, team or stage record, or
 * the campaign's lead counter. Pure: it reads no signal.
 *
 * @param {{resModel?: string}} [record]
 * @param {{type?: string, name?: string}} [clickParams]
 * @param {Object} [attrs]
 * @returns {boolean}
 */
export function isCrmOfflineGuarded(record, clickParams, attrs) {
    const type = clickParams?.type;
    if (type !== "object" && type !== "action") {
        return false;
    }
    if (attrs && "data-available-offline" in attrs) {
        return false;
    }
    const resModel = record?.resModel;
    if (CRM_VIEW_BUTTON_MODELS.has(resModel)) {
        return true;
    }
    return (
        resModel === "utm.campaign" && clickParams.name === "action_redirect_to_leads_opportunities"
    );
}

/**
 * Tells whether a view type is blocked offline for the given model.
 *
 * @param {string} [resModel]
 * @param {string} [viewType]
 * @returns {boolean}
 */
function isBlockedViewType(resModel, viewType) {
    return (
        CRM_OFFLINE_BLOCKED_VIEW_MODELS.has(resModel) &&
        CRM_OFFLINE_BLOCKED_VIEW_TYPES.has(viewType)
    );
}

// -----------------------------------------------------------------------------
// Quick-create deep link
// -----------------------------------------------------------------------------

/**
 * `?crm_quick_create` (PWA shortcut "New Lead") read once, at module evaluation,
 * before the router rewrites the URL. `pending` is the test seam: tests set it.
 */
export const quickCreateDeepLink = {
    pending: new URLSearchParams(browser.location.search).has("crm_quick_create"),
};

/**
 * Returns `true` the first time it is called after the deep link was opened, then
 * `false`: the quick-create sheet opens once per page load.
 *
 * @returns {boolean}
 */
export function consumeQuickCreateDeepLink() {
    const pending = quickCreateDeepLink.pending;
    quickCreateDeepLink.pending = false;
    return Boolean(pending);
}

// -----------------------------------------------------------------------------
// Queue reading helpers (pure functions over framework queue entries)
// -----------------------------------------------------------------------------

/**
 * Orders queue entries as the framework replays them (`extras.timeStamp`).
 *
 * @param {{value: {extras?: {timeStamp?: number}}}} a
 * @param {{value: {extras?: {timeStamp?: number}}}} b
 */
function byTimeStamp(a, b) {
    return (a.value.extras?.timeStamp || 0) - (b.value.extras?.timeStamp || 0);
}

/**
 * Tells whether a queued call's first argument (the target ids) contains `resId`.
 *
 * @param {{args?: any[]}} value
 * @param {number|false} resId
 */
function targetsRecord(value, resId) {
    const ids = value.args?.[0];
    return Boolean(resId) && Array.isArray(ids) && ids.includes(resId);
}

/**
 * Tells whether a queued entry has been parked by a rejected replay.
 *
 * @param {{value: {extras?: {error?: string}}}} entry
 */
function isParked(entry) {
    return Boolean(entry.value.extras?.error);
}

/**
 * Tells whether a value read back from the queue is a field-value mapping (a
 * plain object, neither `null` nor an array), the shape of a `web_save` values
 * argument and of its display values (`extras.changes`).
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isFieldMapping(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tells whether a queued call is a record creation: a `web_save` whose target ids
 * are an empty array and whose values are a field-value mapping.
 *
 * @param {{method?: string, args?: any}} value
 * @returns {boolean}
 */
function isCreateSave(value) {
    return (
        value.method === "web_save" &&
        Array.isArray(value.args) &&
        Array.isArray(value.args[0]) &&
        value.args[0].length === 0 &&
        isFieldMapping(value.args[1])
    );
}

/**
 * Tells whether a queued entry is a lead write that concerns `record`: its own
 * offline save (`record.offlineId`) or a lead method targeting `record.resId`,
 * possibly queued through another `Record` instance of the same lead.
 *
 * @param {{key: string, value: Object}} entry
 * @param {Object} record
 */
function isLeadWriteOf(entry, record) {
    const { value } = entry;
    if (value.model !== record.resModel) {
        return false;
    }
    if (record.offlineId && entry.key === record.offlineId) {
        return true;
    }
    return (
        record.resModel === "crm.lead" &&
        LEAD_WRITE_METHODS.has(value.method) &&
        targetsRecord(value, record.resId)
    );
}

/**
 * Activity types are warmed once per web-client session: the flag is set when a
 * warm-up starts, kept after a success and cleared by a failure, so a later call in
 * the same session tries again. The session is the lifetime of the framework
 * offline plugin instance, so the flag is keyed by that instance (a fresh web
 * client, or a fresh test, warms again).
 */
const warmedActivityTypes = new WeakSet();

/**
 * Per offline plugin instance (the session, as above), a counter bumped each time
 * a warm-up has stored the activity types, so an open activity sheet reads them
 * again from the framework cache. It is a notification only: no type is kept here.
 *
 * @type {WeakMap<OfflinePlugin, import("@odoo/owl").Signal<number>>}
 */
const activityTypesRevisions = new WeakMap();

/**
 * @param {OfflinePlugin} plugin
 * @returns {import("@odoo/owl").Signal<number>} the plugin's revision signal,
 *  created on first use
 */
function getActivityTypesRevision(plugin) {
    let revision = activityTypesRevisions.get(plugin);
    if (!revision) {
        revision = signal(0);
        activityTypesRevisions.set(plugin, revision);
    }
    return revision;
}

// -----------------------------------------------------------------------------
// Asynchronous work started by effects
// -----------------------------------------------------------------------------

/** Errors `crmReportError` already handed to the framework error service. */
const crmReportedErrors = new WeakSet();

/**
 * Reports the error of work nobody awaits, or whose failure must not reject its
 * caller (the reload after a committed write). A `ConnectionLostError` means the
 * connection dropped again meanwhile: it is expected and ignored (work an effect
 * started runs again at its next trigger; a reload keeps the data already
 * loaded). Any other error is handed to the framework error service as an
 * uncaught promise error, the way the action service shows an error of a mounted
 * controller: the standard error dialog, no CRM-specific error UI.
 * Work shared by several owners (merged refreshes, a shared request) rejects each
 * of them with the same error object: that one failure is reported once.
 *
 * @param {unknown} error
 */
export function crmReportError(error) {
    if (error instanceof ConnectionLostError) {
        return;
    }
    if (Object(error) === error) {
        if (crmReportedErrors.has(error)) {
            return;
        }
        crmReportedErrors.add(error);
    }
    Promise.reject(error);
}

/**
 * Takes ownership of the value returned by work an effect starts and nobody
 * awaits (an effect itself must return nothing). A value that is not a promise is
 * ignored; a rejection is reported by `crmReportError`.
 *
 * @param {unknown} result
 */
export function crmOwnEffectPromise(result) {
    if (typeof result?.then !== "function") {
        return;
    }
    Promise.resolve(result).catch(crmReportError);
}

// -----------------------------------------------------------------------------
// useCrmOffline
// -----------------------------------------------------------------------------

/**
 * CRM view of the framework offline state and queue. Call it from a component
 * `setup` only. Every member reads live state (signals, `ui.isSmall`, the queue)
 * when it is called, so a render that calls it re-renders on changes.
 *
 * Queue entries are the framework's `{key, value: {model, method, args, kwargs,
 * extras}}` objects of `OfflinePlugin._ormToSync()`.
 *
 * @example
 * setup() {
 *     this.crmOffline = useCrmOffline();
 *     this.crmOffline.onReplayed(() => this.reload());
 * }
 * get pending() {
 *     return this.crmOffline.hasPendingWrite(this.props.record);
 * }
 */
export function useCrmOffline() {
    const plugin = usePlugin(OfflinePlugin);
    const ui = useService("ui");
    const orm = useService("orm");
    const env = useEnv();

    const isOffline = () => plugin.isOffline();

    /** @param {string} model */
    const queuedEntries = (model) =>
        Object.values(plugin._ormToSync()).filter(({ value }) => value?.model === model);

    /**
     * A `Record.offlineId` survives the replay of its entry, so a key is pending
     * only while it is still in the queue.
     *
     * @param {string} [key]
     */
    const isQueued = (key) => key !== undefined && key !== null && key in plugin._ormToSync();

    /** @param {Object} record */
    const leadWrites = (record) =>
        record
            ? queuedEntries(record.resModel).filter((entry) => isLeadWriteOf(entry, record))
            : [];

    /**
     * Adds a call to the framework queue (replayed in `extras.timeStamp` order)
     * and returns its key. The options object is required by `scheduleORM`. A
     * later `extras.timeStamp` given by the caller (a write that must replay after
     * others queued in the same millisecond) is kept.
     */
    const queue = (model, method, args, kwargs, extras) =>
        plugin.scheduleORM(model, method, args, kwargs, {
            extras: { ...extras, timeStamp: Math.max(Date.now(), extras?.timeStamp || 0) },
        });

    /**
     * Calls the server online; queues the call offline, or when the connection
     * drops during the call. Returns `{queued, result}` (`result` is the queue
     * key when queued). Other errors propagate to the framework error handling.
     */
    const run = async (model, method, args, kwargs, extras) => {
        if (!isOffline()) {
            try {
                return { queued: false, result: await orm.call(model, method, args, kwargs) };
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
            }
        }
        return { queued: true, result: queue(model, method, args, kwargs, extras) };
    };

    /**
     * Reloads `record` after an online write. The write is committed, so the reload
     * never rejects: its caller completes as for a successful write and offers no
     * second one. A dropped connection keeps the cache; any other error is reported
     * once through the framework error handling (`crmReportError`). The lead form's
     * record refreshes through its `crmRefresh`, which keeps the form's unsaved
     * edits (those made during the write included) and does not wait on the
     * restoration of a queued save of the lead.
     */
    const reloadRecord = async (record) => {
        try {
            await (record.crmRefresh ? record.crmRefresh() : record.load());
        } catch (error) {
            crmReportError(error);
        }
    };

    return {
        /** @returns {boolean} */
        isOffline,

        /** Small-screen (mobile) layout, read live on every access. */
        get isSmall() {
            return ui.isSmall;
        },

        /**
         * Online always `true`; offline, whether the lead's form was visited for the
         * current action (framework visited registry).
         *
         * @param {number} resId
         */
        isLeadAvailableOffline(resId) {
            return (
                !isOffline() ||
                Boolean(plugin.isAvailableOffline(env.config?.actionId, "form", resId))
            );
        },

        queuedEntries,
        isQueued,

        /**
         * Whether a write of this lead waits in the queue (pending or parked).
         *
         * @param {Object} record
         */
        hasPendingWrite(record) {
            return leadWrites(record).length > 0;
        },

        /**
         * Whether a write of this lead was rejected on replay and is parked.
         *
         * @param {Object} record
         */
        hasParkedWrite(record) {
            return leadWrites(record).some(isParked);
        },

        /**
         * Display values of a lead card with its queued writes applied, without
         * storing anything: `{name, partner_id, contact_name, expected_revenue,
         * stage_id}` (+ `won_status`, `probability` when loaded). Many2one values
         * are `{id, display_name}`; a field the record did not load is `undefined`.
         * Returns `null` while a pending (not parked) delete or archive hides it.
         * A queued save whose `extras.changes` is not a field-value mapping is
         * ignored: the values it would display are left as they were.
         *
         * @param {Object} record
         * @returns {Object|null}
         */
        projectLead(record) {
            const values = {};
            for (const fieldName of PROJECTED_FIELDS) {
                values[fieldName] = record.data[fieldName];
            }
            for (const fieldName of PROJECTED_OPTIONAL_FIELDS) {
                if (fieldName in record.data) {
                    values[fieldName] = record.data[fieldName];
                }
            }
            for (const entry of leadWrites(record).sort(byTimeStamp)) {
                const { method, extras } = entry.value;
                if (method === "web_save") {
                    const changes = isFieldMapping(extras?.changes) ? extras.changes : {};
                    for (const fieldName of [...PROJECTED_FIELDS, ...PROJECTED_OPTIONAL_FIELDS]) {
                        if (fieldName in changes) {
                            values[fieldName] = changes[fieldName];
                        }
                    }
                } else if (method === "action_set_won") {
                    values.won_status = "won";
                    values.probability = 100;
                } else if (
                    (method === "unlink" || method === "action_archive") &&
                    !isParked(entry)
                ) {
                    // Hidden while pending; a parked (rejected) entry projects normally.
                    return null;
                }
            }
            return values;
        },

        /**
         * Leads created offline (queued `web_save` without id) in a stage, in
         * replay order, as provisional card data. Entries that are not creations
         * (target ids other than an empty array, values not a mapping) are ignored.
         *
         * @param {number|false} stageId
         */
        pendingCreates(stageId) {
            return queuedEntries("crm.lead")
                .filter(({ value }) => isCreateSave(value) && value.args[1].stage_id === stageId)
                .sort(byTimeStamp)
                .map((entry) => {
                    const { args, extras } = entry.value;
                    const source = isFieldMapping(extras?.changes) ? extras.changes : args[1];
                    return {
                        key: entry.key,
                        name: source.name,
                        contact_name: source.contact_name,
                        partner_id: source.partner_id,
                        expected_revenue: source.expected_revenue,
                        stage_id: source.stage_id,
                        parked: isParked(entry),
                    };
                });
        },

        /**
         * Activities scheduled offline on a lead, in replay order. `activity_type_id`
         * and `user_id` are ids, `date_deadline` a "YYYY-MM-DD" string.
         *
         * @param {number} leadId
         */
        pendingActivities(leadId) {
            return queuedEntries("mail.activity")
                .filter(({ value }) => {
                    const vals = value.method === "create" && value.args?.[0]?.[0];
                    return Boolean(vals) && vals.res_model === "crm.lead" && vals.res_id === leadId;
                })
                .sort(byTimeStamp)
                .map((entry) => {
                    const vals = entry.value.args[0][0];
                    return {
                        key: entry.key,
                        summary: vals.summary,
                        date_deadline: vals.date_deadline,
                        activity_type_id: vals.activity_type_id,
                        user_id: vals.user_id,
                        parked: isParked(entry),
                    };
                });
        },

        /**
         * Whether "mark done" of this activity waits in the queue.
         *
         * @param {number} activityId
         */
        isActivityDonePending(activityId) {
            return queuedEntries("mail.activity").some(
                ({ value }) => value.method === "action_done" && targetsRecord(value, activityId)
            );
        },

        /**
         * Activity rows of a lead from data already loaded with the lead:
         * - `variant: "mobile"`: `activity_ids` loaded with its mobile sub-fields
         *   (pipeline or form mobile specification), one row per loaded activity.
         *   That load is bounded (`CRM_MOBILE_ACTIVITY_LIMIT` per page), so
         *   `moreCount` is the number of the lead's activities beyond the loaded
         *   rows: the relation still lists every activity id;
         * - `variant: "desktop"`: `activity_ids` loaded without sub-fields (offline
         *   fallback to a wide-layout cache): one row built from the lead-level
         *   `activity_*` fields (first activity), `moreCount` for the others;
         * - `null` when `activity_ids` was not loaded at all.
         * Rows are `{id, summary, date_deadline, activity_type_id, user_id, state}`.
         *
         * @param {Object} record
         * @returns {{rows: Object[], moreCount: number, variant: "mobile"|"desktop"}|null}
         */
        activityRows(record) {
            const activeField = record.activeFields?.activity_ids;
            if (!activeField) {
                return null;
            }
            const records = record.data.activity_ids?.records || [];
            if (activeField.related?.activeFields?.summary) {
                // `records` is the loaded page, `count` every activity id of the lead.
                const total = record.data.activity_ids?.count ?? records.length;
                return {
                    variant: "mobile",
                    moreCount: Math.max(total - records.length, 0),
                    rows: records.map((activity) => ({
                        id: activity.resId,
                        summary: activity.data.summary,
                        date_deadline: activity.data.date_deadline,
                        activity_type_id: activity.data.activity_type_id,
                        user_id: activity.data.user_id,
                        state: activity.data.state,
                    })),
                };
            }
            if (!records.length) {
                return { variant: "desktop", moreCount: 0, rows: [] };
            }
            // Loaded without sub-fields, the framework keeps a single record in the
            // x2many list (its limit is 1), while `count` holds every activity id.
            const count = record.data.activity_ids.count ?? records.length;
            return {
                variant: "desktop",
                moreCount: Math.max(count - 1, 0),
                rows: [
                    {
                        id: records[0].resId,
                        summary: record.data.activity_summary,
                        date_deadline: false,
                        activity_type_id: record.data.activity_type_id,
                        user_id: false,
                        state: record.data.activity_state,
                    },
                ],
            };
        },

        /**
         * Online only: caches the lead activity types in the framework
         * relational-field cache so the activity sheet works offline, then bumps
         * `activityTypesRevision()` so an open sheet reads them. After a success it
         * does nothing more in this session. A failure is ignored and clears the
         * session flag, so the next eligible call in the same session (a later
         * visit, or the connection coming back) tries again.
         */
        async warmActivityTypes() {
            if (isOffline() || warmedActivityTypes.has(plugin)) {
                return;
            }
            warmedActivityTypes.add(plugin);
            try {
                const result = await orm.webSearchRead(
                    "mail.activity.type",
                    [["res_model", "in", [false, "crm.lead"]]],
                    { specification: { display_name: {} } }
                );
                await plugin.cacheMany2XSearch("mail.activity.type", result.records);
                const revision = getActivityTypesRevision(plugin);
                revision.set(untrack(revision) + 1);
            } catch {
                warmedActivityTypes.delete(plugin);
            }
        },

        /**
         * Revision of the cached activity types: it grows each time a warm-up has
         * stored them. An effect reading it runs again when types reach the cache
         * after its component read them (`getActivityTypes()`).
         *
         * @returns {number}
         */
        activityTypesRevision() {
            return getActivityTypesRevision(plugin)();
        },

        /** @returns {Promise<{id: number, display_name: string}[]>} cached activity types */
        async getActivityTypes() {
            return (await plugin.searchMany2XRecords("mail.activity.type", "")) || [];
        },

        /** @returns {Promise<{id: number, display_name: string}[]>} session user first */
        async getAssignees() {
            const cached = (await plugin.searchMany2XRecords("res.users", "")) || [];
            const assignees = [{ id: user.userId, display_name: user.name }];
            const seen = new Set([user.userId]);
            for (const assignee of cached) {
                if (!seen.has(assignee.id)) {
                    seen.add(assignee.id);
                    assignees.push(assignee);
                }
            }
            return assignees;
        },

        /**
         * The "Call" activity type id set by the arch (`crm_call_activity_type_id`
         * option of the kanban `activity_ids` or the form `stage_id` node).
         *
         * @param {{fieldNodes?: Object}} [archInfo]
         * @returns {number|false}
         */
        callTypeId(archInfo) {
            const node = Object.values(archInfo?.fieldNodes || {}).find(
                (fieldNode) =>
                    (fieldNode.name === "activity_ids" || fieldNode.name === "stage_id") &&
                    fieldNode.options?.crm_call_activity_type_id
            );
            const typeId = Number(node?.options.crm_call_activity_type_id);
            return Number.isInteger(typeId) && typeId > 0 ? typeId : false;
        },

        /**
         * Online: the server call's result. Offline (or when the connection drops
         * during the call): the framework queue key.
         */
        async schedule(model, method, args, kwargs, extras) {
            return (await run(model, method, args, kwargs, extras)).result;
        },

        /**
         * Schedules an activity on a lead. The user context is used (not the
         * action context) so no `default_*` key of the lead action becomes a
         * `mail.activity` default; `res_model_id` is resolved server-side. Online,
         * only a server error of the create rejects; once the activity is created,
         * the lead reload does not (`reloadRecord`).
         *
         * @param {Object} record the lead
         * @param {{activity_type_id: number, summary: string, date_deadline: string, user_id: number}} vals
         */
        async scheduleActivity(record, { activity_type_id, summary, date_deadline, user_id }) {
            const { queued, result } = await run(
                "mail.activity",
                "create",
                [
                    [
                        {
                            res_model: "crm.lead",
                            res_id: record.resId,
                            activity_type_id,
                            summary,
                            date_deadline,
                            user_id,
                        },
                    ],
                ],
                { context: user.context },
                getScheduleORMExtras(record.model, [record])
            );
            if (!queued) {
                await reloadRecord(record);
            }
            return result;
        },

        /**
         * Marks an activity done (state change only: no feedback, attachment or
         * next-activity wizard). Online, only a server error of the call rejects;
         * once the activity is done, the lead reload does not (`reloadRecord`).
         *
         * @param {Object} record the lead
         * @param {number} activityId
         */
        async markActivityDone(record, activityId) {
            const { queued, result } = await run(
                "mail.activity",
                "action_done",
                [[activityId]],
                { context: user.context },
                getScheduleORMExtras(record.model, [record])
            );
            if (!queued) {
                await reloadRecord(record);
            }
            return result;
        },

        /**
         * Creates a lead from the mobile quick-create sheet. Online it saves and
         * reloads the pipeline; offline (or when the connection drops) it queues a
         * `web_save` whose `extras` carry the display values of the provisional card
         * (`{actionId, actionName, viewType, displayName, changes}`). Online, only
         * a server error of the save rejects, so the sheet keeps the entered
         * values. Once the lead is saved, a failed pipeline reload is reported once
         * (`crmReportError`) and the create resolves, so the sheet closes and does
         * not offer to create the lead a second time.
         *
         * @param {Object} list the pipeline root list
         * @param {Object} vals server values (`stage_id` is an id)
         * @param {Object} extras
         */
        async createLead(list, vals, extras) {
            const kwargs = { context: list.context, specification: {} };
            if (isOffline()) {
                return queue("crm.lead", "web_save", [[], vals], kwargs, extras);
            }
            try {
                await orm.webSave("crm.lead", [], vals, { ...kwargs });
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
                return queue("crm.lead", "web_save", [[], vals], kwargs, extras);
            }
            try {
                // The lead exists now: a failed reload must not reject, or the sheet
                // would offer to create it twice. A lost connection keeps the
                // pipeline as loaded; any other error is reported once.
                await list.model.load();
            } catch (error) {
                crmReportError(error);
            }
        },

        /**
         * Runs `callback` (untracked) each time a replay of the queue finishes while
         * online. Setup only. A promise `callback` returns is owned by the hook
         * (`crmOwnEffectPromise`): a lost connection is ignored, any other error
         * reaches the framework error service.
         *
         * @param {() => (Promise<unknown>|void)} callback
         */
        onReplayed(callback) {
            let wasSyncing = false;
            useEffect(() => {
                const syncing = plugin.syncingORM();
                const offline = plugin.isOffline();
                const finished = wasSyncing && !syncing;
                wasSyncing = syncing;
                if (finished && !offline) {
                    untrack(() => crmOwnEffectPromise(callback()));
                }
            });
        },

        /**
         * Runs `callback(removedKeys)` (untracked) when entries of `model` leave the
         * queue outside a replay, i.e. when the user discards them. Removals seen
         * while a replay runs, or in the batch where it ends (owl batches effects:
         * the last replayed entry and the end of the replay land in the same run),
         * are replays and only refresh the remembered keys. Setup only. A promise
         * `callback` returns is owned by the hook (`crmOwnEffectPromise`): a lost
         * connection is ignored, any other error reaches the framework error service.
         *
         * @param {string} model
         * @param {(keys: string[]) => (Promise<unknown>|void)} callback
         */
        onEntriesDiscarded(model, callback) {
            let knownKeys = null;
            let wasSyncing = false;
            useEffect(() => {
                const syncing = plugin.syncingORM();
                const keys = new Set(queuedEntries(model).map(({ key }) => key));
                const previousKeys = knownKeys;
                const replaying = syncing || wasSyncing;
                knownKeys = keys;
                wasSyncing = syncing;
                if (!previousKeys || replaying) {
                    return;
                }
                const removedKeys = [...previousKeys].filter((key) => !keys.has(key));
                if (removedKeys.length) {
                    untrack(() => crmOwnEffectPromise(callback(removedKeys)));
                }
            });
        },

        /**
         * The module-level `consumeQuickCreateDeepLink`: `true` once per page load
         * after the "New Lead" deep link, sharing its single once-only flag.
         *
         * @returns {boolean}
         */
        consumeQuickCreateDeepLink,
    };
}

// -----------------------------------------------------------------------------
// Guard: view buttons (DOM state and click boundary)
// -----------------------------------------------------------------------------

patch(ViewButton.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /**
     * True for a CRM DISABLE button while offline. Read by the `web.views.ViewButton`
     * extension (`aria-disabled`, `tabindex`), so `<a>` buttons leave the tab order.
     */
    get crmOfflineGuarded() {
        return (
            isCrmOfflineGuarded(this.props.record, this.clickParams, this.props.attrs) &&
            this.crmOfflinePlugin.isOffline()
        );
    },

    get disabled() {
        const disabled = super.disabled;
        if (disabled) {
            return disabled;
        }
        // Unguarded buttons keep the original (falsy) value, so the DOM is unchanged.
        return this.crmOfflineGuarded || disabled;
    },

    getClassName() {
        const className = super.getClassName(...arguments);
        if (!this.crmOfflineGuarded) {
            return className;
        }
        return [className, "o_disabled_offline pe-none"].filter(Boolean).join(" ");
    },

    onClick(ev, newWindow) {
        if (this.crmOfflineGuarded) {
            ev?.preventDefault?.();
            return;
        }
        return super.onClick(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: navigation entry points (action service)
// -----------------------------------------------------------------------------

/**
 * @param {unknown} actionRequest
 * @returns {boolean} whether the request names a disabled action by `xml_id`
 */
function isDisabledActionRequest(actionRequest) {
    if (typeof actionRequest === "string") {
        return CRM_OFFLINE_DISABLED_ACTIONS.has(actionRequest);
    }
    return (
        Boolean(actionRequest) &&
        typeof actionRequest === "object" &&
        CRM_OFFLINE_DISABLED_ACTIONS.has(actionRequest.xml_id)
    );
}

/**
 * The action service's own `active_ids` URL parsing ("1,2" → [1, 2]).
 *
 * @param {string|number} ids
 * @returns {number[]}
 */
function parseActiveIds(ids) {
    if (typeof ids === "string") {
        return ids.split(",").map(Number);
    }
    return typeof ids === "number" ? [ids] : [];
}

/**
 * The context the action service passes when it loads a URL state's action, so
 * the lookup below reads the same disk-cache entry.
 *
 * @param {Object} state
 */
function getStateActionContext(state) {
    const context = {};
    if (state.active_id) {
        context.active_id = state.active_id;
    }
    if (state.active_ids) {
        context.active_ids = parseActiveIds(state.active_ids);
    } else if (state.active_id) {
        context.active_ids = [state.active_id];
    }
    return context;
}

/**
 * Resolves the action a URL state opens without issuing anything the action
 * service would not issue itself: client actions are skipped, the action stored
 * in the session is reused, otherwise the disk-cached `loadAction` is read.
 *
 * @param {Object} api the action manager
 * @param {Object} state
 * @param {number|string} actionRef
 * @returns {Promise<Object|null>} `null` when unknown (not cached offline)
 */
async function resolveStateAction(api, state, actionRef) {
    const actionRegistry = registry.category("actions");
    if (
        actionRegistry.contains(actionRef) ||
        actionRegistry.getEntries().some(([, clientAction]) => clientAction.path === actionRef)
    ) {
        return null;
    }
    try {
        const stored = JSON.parse(browser.sessionStorage.getItem("current_action") || "{}");
        if ([stored.id, stored.path, stored.xml_id].filter(Boolean).includes(actionRef)) {
            return stored;
        }
        return await api.loadAction(actionRef, getStateActionContext(state));
    } catch {
        return null;
    }
}

/**
 * Whether a URL state opens a disabled action or a blocked CRM view type.
 *
 * @param {Object} api the action manager
 * @param {Object} [state]
 * @returns {Promise<boolean>}
 */
async function isBlockedRouterState(api, state) {
    if (!state) {
        return false;
    }
    const lastAction = state.actionStack?.at(-1);
    const actionRef = lastAction?.action ?? state.action;
    let resModel = state.model ?? lastAction?.model;
    if (actionRef) {
        if (CRM_OFFLINE_DISABLED_ACTIONS.has(actionRef)) {
            return true;
        }
        const action = await resolveStateAction(api, state, actionRef);
        if (CRM_OFFLINE_DISABLED_ACTIONS.has(action?.xml_id)) {
            return true;
        }
        resModel = resModel || action?.res_model;
    }
    return isBlockedViewType(resModel, state.view_type);
}

/**
 * Wraps the action manager's public entry points in place. The object is
 * mutated, never copied: it exposes `currentController`/`currentAction` getters,
 * and its internal calls go through closures, which the view-mount guard below
 * covers. Online each wrapper returns the original's own promise.
 *
 * @param {Object} api the action manager returned by `actionService.start`
 * @param {OfflinePlugin} offlinePlugin
 */
function guardActionManager(api, offlinePlugin) {
    const { doAction, doActionButton, switchView, loadState } = api;

    api.doActionButton = function crmOfflineDoActionButton(...args) {
        const [params] = args;
        // `special` buttons (wizard Cancel/close) never reach the server.
        if (
            params &&
            !params.special &&
            isCrmOfflineButtonCall(params) &&
            offlinePlugin.isOffline()
        ) {
            return Promise.resolve();
        }
        return doActionButton.apply(this, args);
    };

    api.doAction = function crmOfflineDoAction(...args) {
        const [actionRequest, options] = args;
        if (isDisabledActionRequest(actionRequest)) {
            if (offlinePlugin.isOffline()) {
                return Promise.resolve();
            }
        } else if (typeof actionRequest === "number" && offlinePlugin.isOffline()) {
            // An id is identified through the disk-cached action; an uncached one
            // cannot be, and goes to the original (whose load fails like any other).
            return api
                .loadAction(actionRequest, options?.additionalContext)
                .catch(() => null)
                .then((action) => {
                    if (
                        CRM_OFFLINE_DISABLED_ACTIONS.has(action?.xml_id) &&
                        offlinePlugin.isOffline()
                    ) {
                        return;
                    }
                    return doAction.apply(this, args);
                });
        }
        return doAction.apply(this, args);
    };

    api.switchView = function crmOfflineSwitchView(...args) {
        const [viewType] = args;
        if (
            isBlockedViewType(api.currentController?.action?.res_model, viewType) &&
            offlinePlugin.isOffline()
        ) {
            return Promise.resolve();
        }
        return switchView.apply(this, args);
    };

    api.loadState = function crmOfflineLoadState(...args) {
        if (!offlinePlugin.isOffline()) {
            return loadState.apply(this, args);
        }
        const state = args[0] === undefined ? router.current : args[0];
        return isBlockedRouterState(api, state).then((blocked) =>
            // `false`: the web client opens the menu's or the default app instead.
            blocked && offlinePlugin.isOffline() ? false : loadState.apply(this, args)
        );
    };
}

patch(actionService, {
    start(env) {
        // Resolved synchronously: the service scope only exists during `start`.
        const offlinePlugin = usePlugin(OfflinePlugin);
        const api = super.start(...arguments);
        guardActionManager(api, offlinePlugin);
        return api;
    },
});

// -----------------------------------------------------------------------------
// Guard: navbar menus (menu service)
// -----------------------------------------------------------------------------

patch(menuService, {
    async start(env, deps) {
        // Resolved before the first `await`: the service scope ends there.
        const offlinePlugin = usePlugin(OfflinePlugin);
        const api = await super.start(...arguments);
        const { selectMenu } = api;
        api.selectMenu = function crmOfflineSelectMenu(...args) {
            const [menu] = args;
            const target = typeof menu === "number" ? api.getMenu(menu) : menu;
            if (CRM_OFFLINE_DISABLED_MENUS.has(target?.xmlid) && offlinePlugin.isOffline()) {
                return Promise.resolve();
            }
            return selectMenu.apply(api, args);
        };
        return api;
    },
});

// -----------------------------------------------------------------------------
// Guard: view mount (fail-closed backstop for every act_window controller)
// -----------------------------------------------------------------------------

/**
 * Classifies a CRM view target that never opens offline. Pure: reads props only.
 * - "read": report and analysis views (the lead graph, pivot, calendar, activity
 *   and forecast views, every `crm.activity.report` view), swapped to the offline
 *   helper as soon as the connection drops;
 * - "dialog": wizards, the team form and the CRM settings, which stay mounted
 *   once loaded so entered values survive (their buttons are guarded instead).
 *
 * @param {Object} props View props
 * @returns {"read"|"dialog"|false}
 */
function crmBlockedTarget(props) {
    const { resModel, type } = props;
    const context = props.context || {};
    if (resModel === "crm.activity.report") {
        return "read";
    }
    if (resModel === "crm.lead") {
        const isForecast = Boolean(context.forecast_field) && type !== "form";
        return CRM_OFFLINE_BLOCKED_VIEW_TYPES.has(type) || isForecast ? "read" : false;
    }
    if (CRM_WIZARD_MODELS.has(resModel)) {
        return "dialog";
    }
    if (resModel === "crm.team" && type === "form") {
        return "dialog";
    }
    if (resModel === "res.config.settings" && context.module === "crm") {
        return "dialog";
    }
    return false;
}

patch(View, {
    components: { ...View.components, OfflineActionHelper },
});

patch(View.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
        // OWL 3 components have no `render()`: the template re-renders from this proxy.
        this.crmViewState = proxy({ loadPending: false });
        /** @type {Promise<void>|null} the running `crmLoadPendingView` load */
        this.crmPendingViewLoad = null;
        useEffect(() => {
            if (this.crmLoadPending && !this.crmOfflinePlugin.isOffline()) {
                untrack(() => {
                    // A reconnection while the load runs shares it: only the run that
                    // starts it observes it, so its outcome is reported once.
                    if (!this.crmPendingViewLoad) {
                        crmOwnEffectPromise(this.crmLoadPendingView());
                    }
                });
            }
        });
    },

    /**
     * True while the load of a blocked CRM target was skipped offline, until a
     * load succeeds. Backed by `crmViewState`, so reads made while rendering or
     * inside an effect are tracked.
     */
    get crmLoadPending() {
        return this.crmViewState.loadPending;
    },

    set crmLoadPending(value) {
        this.crmViewState.loadPending = value;
    },

    /**
     * True while the `web.View` extension renders `OfflineActionHelper` instead of
     * the controller: a CRM target whose load was skipped offline, or a mounted
     * read target while offline.
     */
    get crmOfflineBlocked() {
        const target = crmBlockedTarget(this.props);
        if (!target) {
            return false;
        }
        return this.crmLoadPending || (target === "read" && this.crmOfflinePlugin.isOffline());
    },

    loadView(props) {
        if (!crmBlockedTarget(props)) {
            return super.loadView(...arguments);
        }
        if (this.crmOfflinePlugin.isOffline()) {
            // No view or data request: the helper renders until reconnection.
            this.crmLoadPending = true;
            return Promise.resolve();
        }
        return super.loadView(...arguments).then((result) => {
            if (this.crmLoadPending) {
                this.crmLoadPending = false;
            }
            return result;
        });
    },

    onWillUpdateProps(nextProps) {
        // The original merges search keys into `withSearchProps`, which a skipped
        // load left `null`: load (or keep skipping) with the new props instead.
        if (this.withSearchProps === null && this.crmLoadPending) {
            return this.loadView(this.applyViewDefaults(nextProps));
        }
        return super.onWillUpdateProps(...arguments);
    },

    /**
     * Loads, once, a view whose load was skipped offline; a call made while that load
     * runs returns the same promise. A load lost to a dropped connection resolves and
     * leaves the view pending, so the next reconnection retries it; any other error
     * rejects.
     *
     * @returns {Promise<void>}
     */
    crmLoadPendingView() {
        if (!this.crmPendingViewLoad) {
            this.crmPendingViewLoad = this.loadView(this.props)
                .catch((error) => {
                    if (!(error instanceof ConnectionLostError)) {
                        throw error;
                    }
                })
                .finally(() => {
                    this.crmPendingViewLoad = null;
                });
        }
        return this.crmPendingViewLoad;
    },
});

// -----------------------------------------------------------------------------
// Guard: Action-menu items of CRM views
// -----------------------------------------------------------------------------

patch(ActionMenus.prototype, {
    onItemSelected(item) {
        if (
            CRM_ACTION_MENU_MODELS.has(this.props.resModel) &&
            !item?.availableOffline &&
            this.offlinePlugin.isOffline()
        ) {
            return Promise.resolve();
        }
        return super.onItemSelected(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: Sales Teams dashboard cards
// -----------------------------------------------------------------------------

patch(KanbanRecord.prototype, {
    triggerAction(params) {
        if (
            (params?.type === "open" || params?.type === "edit") &&
            this.props.record.resModel === "crm.team" &&
            this.offlinePlugin.isOffline()
        ) {
            return;
        }
        return super.triggerAction(...arguments);
    },
});

patch(CardRenderer.prototype, {
    createWidget(props) {
        super.createWidget(...arguments);
        const renderer = this;
        const widget = untrack(() => ({ ...this.dataState.widget }));
        this.dataState.widget = {
            ...widget,
            /**
             * `widget.crm_offline`, read by the team card "Configuration" link: the
             * team scope is tested first and evaluated lazily, so it follows props.
             */
            get crm_offline() {
                return (
                    renderer.props.record.resModel === "crm.team" &&
                    renderer.offlinePlugin.isOffline()
                );
            },
        };
    },
});

/**
 * Menu items a CRM guard disables offline: the team card "Configuration" link
 * (`widget.crm_offline`) is the only `.dropdown-item` that gets this state.
 */
const CRM_OFFLINE_DISABLED_MENU_ITEM = ".dropdown-item.o_disabled_offline[aria-disabled='true']";

patch(KanbanDropdownMenuWrapper.prototype, {
    /**
     * The open card menu's dropdown navigates (Tab, Shift+Tab, arrows, Home, End)
     * through every `.o-navigable` item and focuses it programmatically, whatever
     * its `tabindex` or `aria-disabled`; the wrapper marks every `.dropdown-item`
     * so on each mount and patch. Registered after the wrapper's own callbacks,
     * these run after them and take the mark back from the items disabled offline,
     * so a menu opened online never navigates to them. DOM only: no signal is
     * read, so other kanban menus neither subscribe nor change, and online the
     * wrapper marks the re-enabled item again.
     */
    setup() {
        super.setup(...arguments);
        const excludeOfflineDisabledItems = () => {
            const rootEl = this.rootRef();
            if (!rootEl) {
                return;
            }
            for (const el of rootEl.querySelectorAll(CRM_OFFLINE_DISABLED_MENU_ITEM)) {
                el.classList.remove("o-navigable");
            }
        };
        onMounted(excludeOfflineDisabledItems);
        onPatched(excludeOfflineDisabledItems);
    },
});

// -----------------------------------------------------------------------------
// Guard: lead tag colours
// -----------------------------------------------------------------------------

/**
 * @param {Many2ManyTagsField} field
 * @returns {boolean} whether a lead tags field is offline (scope tested first)
 */
function isLeadTagFieldOffline(field) {
    const { record } = field.props;
    return record.resModel === "crm.lead" && Boolean(record.model?.offlinePlugin?.isOffline());
}

patch(Many2ManyTagsField.prototype, {
    setup() {
        super.setup(...arguments);
        useEffect(() => {
            if (isLeadTagFieldOffline(this)) {
                untrack(() => this.popover.isOpen && this.popover.close());
            }
        });
    },

    onTagClick() {
        if (isLeadTagFieldOffline(this)) {
            return Promise.resolve();
        }
        return super.onTagClick(...arguments);
    },

    onTagVisibilityChange() {
        if (isLeadTagFieldOffline(this)) {
            return Promise.resolve();
        }
        return super.onTagVisibilityChange(...arguments);
    },

    switchTagColor() {
        if (isLeadTagFieldOffline(this)) {
            return Promise.resolve();
        }
        return super.switchTagColor(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: relational autocomplete of the lead form (partner field)
// -----------------------------------------------------------------------------

/**
 * @param {Many2XAutocomplete} autocomplete
 * @returns {boolean} whether the autocomplete belongs to a lead view
 */
function isLeadAutocomplete(autocomplete) {
    return autocomplete.env.model?.root?.resModel === "crm.lead";
}

/**
 * Marks the options built by `guardAutocompleteOption`. Object spread copies it,
 * so it reaches the option AutoComplete normalizes and renders, which the
 * AutoComplete patch below recognizes by it.
 */
const CRM_OFFLINE_GUARDED_OPTION = Symbol("crmOfflineGuardedOption");

/**
 * Makes a non-record option (enrichment suggestion, Create, Create and edit,
 * Search more) inert once the connection drops after it was loaded. Record
 * suggestions are returned unchanged. `onSelect` is only wrapped when the option
 * has one: AutoComplete derives `unselectable` from its presence, so adding it to
 * "No records"/"Start typing" would make them selectable online.
 *
 * @param {Many2XAutocomplete} autocomplete
 * @param {Object} option
 */
function guardAutocompleteOption(autocomplete, option) {
    if (!option || option.data?.record) {
        return option;
    }
    const guarded = {
        ...option,
        [CRM_OFFLINE_GUARDED_OPTION]: true,
        get unselectable() {
            return option.unselectable || autocomplete.crmOfflineInlineSearch;
        },
    };
    if (option.onSelect) {
        guarded.onSelect = (...args) =>
            autocomplete.crmOfflineInlineSearch ? undefined : option.onSelect(...args);
    }
    return guarded;
}

/**
 * Wraps a source's options (array or loader function, whose arguments, e.g.
 * `(request, shouldSearchWorldWide)`, are forwarded unchanged).
 *
 * @param {Many2XAutocomplete} autocomplete
 * @param {Object} source
 */
function guardAutocompleteSource(autocomplete, source) {
    const guardAll = (options) =>
        Array.isArray(options)
            ? options.map((option) => guardAutocompleteOption(autocomplete, option))
            : options;
    const { options } = source;
    if (typeof options !== "function") {
        return { ...source, options: guardAll(options) };
    }
    return {
        ...source,
        options: (...args) => {
            const result = options(...args);
            return typeof result?.then === "function" ? result.then(guardAll) : guardAll(result);
        },
    };
}

patch(Many2XAutocomplete.prototype, {
    /**
     * True for a lead view's autocomplete while offline. Read by the
     * `web.Many2XAutocomplete` extension: on a phone the field then searches inline
     * (cached records) instead of opening the "Search more" dialog.
     */
    get crmOfflineInlineSearch() {
        return isLeadAutocomplete(this) && this.offlinePlugin.isOffline();
    },

    get sources() {
        if (!isLeadAutocomplete(this)) {
            return super.sources;
        }
        if (this.offlinePlugin.isOffline()) {
            // Cached records only: no enrichment source (e.g. partner autocomplete).
            return [this.optionsSource];
        }
        return super.sources.map((source) => guardAutocompleteSource(this, source));
    },

    onSearchMore() {
        if (this.crmOfflineInlineSearch) {
            return Promise.resolve();
        }
        return super.onSearchMore(...arguments);
    },

    onBarcodeSearch() {
        if (this.crmOfflineInlineSearch) {
            return Promise.resolve();
        }
        return super.onBarcodeSearch(...arguments);
    },
});

/**
 * @param {Object} [option] an option normalized by AutoComplete
 * @returns {boolean} whether it is a guarded lead option that is inert now
 */
function isInertGuardedOption(option) {
    return Boolean(option?.[CRM_OFFLINE_GUARDED_OPTION] && option.unselectable);
}

patch(AutoComplete.prototype, {
    /**
     * `makeOption` replaces `unselectable` with a plain boolean (`!option.onSelect`)
     * computed once, which would leave a guarded lead option selectable after the
     * connection drops. A guarded option gets a live accessor instead: unselectable
     * when the framework says so or while its guard holds. While the guard alone
     * makes it inert, its row also carries the framework's offline-disabled styling
     * (`o_disabled_offline`); informational options ("No records", "Start
     * typing...") keep their look. Both are read during render, so the dropdown
     * re-renders when the connection changes. Other options are returned unchanged.
     */
    makeOption(option) {
        const made = super.makeOption(...arguments);
        if (!option?.[CRM_OFFLINE_GUARDED_OPTION]) {
            return made;
        }
        const { cssClass, unselectable } = made;
        const isDisabledOffline = () => !unselectable && Boolean(option.unselectable);
        Object.defineProperties(made, {
            unselectable: {
                configurable: true,
                enumerable: true,
                get: () => unselectable || isDisabledOffline(),
            },
            cssClass: {
                configurable: true,
                enumerable: true,
                get: () =>
                    isDisabledOffline() ? mergeClasses(cssClass, "o_disabled_offline") : cssClass,
            },
        });
        return made;
    },

    /**
     * The framework only ever activates selectable options. A guarded option
     * highlighted online is no longer shown active once it turns inert.
     */
    isActiveSourceOption([sourceIndex, optionIndex]) {
        const active = super.isActiveSourceOption(...arguments);
        if (active && isInertGuardedOption(this.sources[sourceIndex]?.options[optionIndex])) {
            return false;
        }
        return active;
    },

    /**
     * No `aria-activedescendant` (nor scroll target) for an inert guarded option,
     * as in `isActiveSourceOption`.
     */
    get activeSourceOptionId() {
        const id = super.activeSourceOptionId;
        if (id === undefined || isInertGuardedOption(this.activeOption)) {
            return undefined;
        }
        return id;
    },
});

// -----------------------------------------------------------------------------
// Guard: Sales Team form multi-membership button
// -----------------------------------------------------------------------------

const patchedTeamFormControllers = new WeakSet();

/**
 * Stops the multi-membership activation offline before its manager probe
 * (`user.hasGroup`) and its `set_bool` call.
 *
 * @param {{Controller?: typeof import("@web/views/form/form_controller").FormController}} [view]
 */
function guardTeamFormView(view) {
    const Controller = view?.Controller;
    if (!Controller || patchedTeamFormControllers.has(Controller)) {
        return;
    }
    patchedTeamFormControllers.add(Controller);
    patch(Controller.prototype, {
        beforeExecuteActionButton(clickParams) {
            if (
                clickParams?.name === "crm_team_activate_multi_membership" &&
                this.offlinePlugin.isOffline()
            ) {
                return Promise.resolve(false);
            }
            return super.beforeExecuteActionButton(...arguments);
        },
    });
}

const viewRegistry = registry.category("views");
const teamFormView = viewRegistry.get("crm_team_form", null);
if (teamFormView) {
    guardTeamFormView(teamFormView);
} else {
    // sales_team registers the view; patch it when it arrives if it is not yet there.
    viewRegistry.addEventListener("UPDATE", ({ detail }) => {
        if (detail.operation === "add" && detail.key === "crm_team_form") {
            guardTeamFormView(detail.value);
        }
    });
}
