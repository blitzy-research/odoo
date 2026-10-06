/** Shared CRM offline hooks and execution guards backed by the framework `OfflinePlugin`. */

import {
    computed,
    effect,
    immediateEffect,
    onMounted,
    onPatched,
    onWillDestroy,
    onWillPatch,
    onWillUnmount,
    proxy,
    signal,
    toRaw,
    untrack,
    useEffect,
    useListener,
    usePlugin,
} from "@odoo/owl";
import { MailComposerFormRenderer } from "@mail/chatter/web/mail_composer_form";
import { ActivityButton } from "@mail/core/web/activity_button";
import { Avatar } from "@mail/views/web/fields/avatar/avatar";
import { CardMany2OneAvatarUserField } from "@mail/views/web/fields/many2one_avatar_user_field/kanban_many2one_avatar_user_field";
import { Many2OneAvatarUserField } from "@mail/views/web/fields/many2one_avatar_user_field/many2one_avatar_user_field";
import { MailActivityMixinListRescheduleDropdown } from "@mail/views/web/list/mail_activity_list_reschedule";
import { AutoComplete } from "@web/core/autocomplete/autocomplete";
import { browser } from "@web/core/browser/browser";
// The `loadState()` guard must inspect the state the action service itself falls
// back to when called without arguments (the web client's boot): `router.current`.
import { router } from "@web/core/browser/router";
import { CommandPalette } from "@web/core/commands/command_palette";
import { datetimePickerService } from "@web/core/datetime/datetimepicker_service";
import { useDropdownState } from "@web/core/dropdown/dropdown_hooks";
import { getActiveHotkey } from "@web/core/hotkeys/hotkey_service";
import { ConnectionLostError, rpcBus } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { useActiveElement } from "@web/core/ui/ui_service";
import { user } from "@web/core/user";
import { mergeClasses } from "@web/core/utils/classname";
import { useService } from "@web/core/utils/hooks";
import { omit } from "@web/core/utils/objects";
import { patch } from "@web/core/utils/patch";
import { getTabableElements } from "@web/core/utils/ui";
import { Record } from "@web/model/relational_model/record";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { useEnv, useSubEnv } from "@web/owl2/utils";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { session } from "@web/session";
import { CardCompiler } from "@web/views/card/card_compiler";
import { CardRenderer } from "@web/views/card/card_renderer";
import { kanbanColorPickerField } from "@web/views/fields/kanban_color_picker/kanban_color_picker_field";
import { Many2ManyTagsField } from "@web/views/fields/many2many_tags/many2many_tags_field";
import { KanbanMany2One } from "@web/views/fields/many2one/many2one";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { FormController } from "@web/views/form/form_controller";
import { KanbanDropdownMenuWrapper } from "@web/views/kanban/kanban_dropdown_menu_wrapper";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { toStringExpression } from "@web/views/utils";
import { View } from "@web/views/view";
import { ViewButton } from "@web/views/view_button/view_button";
import { viewService } from "@web/views/view_service";
import { actionService } from "@web/webclient/actions/action_service";
import { computeAppsAndMenuItems } from "@web/webclient/menus/menu_helpers";
// Registers the command palette's menu provider, patched below.
import "@web/webclient/menus/menu_providers";
import { menuService } from "@web/webclient/menus/menu_service";
import { NavBar } from "@web/webclient/navbar/navbar";
import { SettingsFormController } from "@web/webclient/settings_form_view/settings_form_controller";
import { settingsFormView } from "@web/webclient/settings_form_view/settings_form_view";

// -----------------------------------------------------------------------------
// Frozen sets (generated from offline_inventory.md, "Generated sets")
// -----------------------------------------------------------------------------

/**
 * Builds a Set whose own `add`, `delete` and `clear` throw and whose own
 * properties are frozen: this stops ordinary API misuse, not borrowed
 * `Set.prototype` methods.
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
 * (or the record's) context `module` key, as the CRM settings page sets it. CRM's
 * own settings method matches whatever settings page shows it (the General
 * Settings show the CRM app too).
 *
 * @type {ReadonlyArray<Readonly<{resModel: string, name: string|null, contextModule?: string}>>}
 */
export const CRM_OFFLINE_BUTTON_METHODS = Object.freeze([
    Object.freeze({ resModel: "res.partner", name: "action_view_opportunity" }),
    Object.freeze({ resModel: "utm.campaign", name: "action_redirect_to_leads_opportunities" }),
    Object.freeze({ resModel: "res.config.settings", name: null, contextModule: "crm" }),
    Object.freeze({ resModel: "res.config.settings", name: "action_crm_assign_leads" }),
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

/**
 * Action `xml_id`s of the CRM bound mail composers (`mail.compose.message`): a
 * composer they opened is a CRM transient wizard, while composers opened by any
 * other action are CRM's only when they write to leads (`CRM_LEAD_MAIL_WIZARD_KEYS`).
 */
const CRM_COMPOSER_ACTIONS = freezeSet([
    "crm.action_lead_mail_compose",
    "crm.action_lead_mass_mail",
]);

/**
 * Mail wizards of a lead's chatter, by the context key naming the model they write
 * to: the full composer (`default_model`) and the followers wizard of the followers
 * menu (`default_res_model`, also set by `crm.mail_followers_edit_action_from_lead`).
 * Opened with `crm.lead` there, such a wizard is a CRM transient wizard of the
 * read-only lead chatter; opened on any other model, it is mail's.
 */
const CRM_LEAD_MAIL_WIZARD_KEYS = Object.freeze({
    "mail.compose.message": "default_model",
    "mail.followers.edit": "default_res_model",
});

/** `xml_id` of the CRM lead meetings action (`calendar.event`), in `CRM_OFFLINE_DISABLED_ACTIONS`. */
const CRM_MEETINGS_ACTION = "crm.act_crm_opportunity_calendar_event_new";

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
// Activity page sizes
// -----------------------------------------------------------------------------

/**
 * Activity page sizes raised by "Show more", per root load scope, kept in memory
 * for the web-client session (the offline plugin instance) and never persisted:
 * a new session requests the first page, which its first online visit cached.
 *
 * @type {WeakMap<OfflinePlugin, Map<string, number>>}
 */
const activityLimits = new WeakMap();

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
 * Whether the framework offline queue can hold calls in this browsing context.
 * `OfflinePlugin.scheduleORM` refuses every call outside a secure context (a
 * plain-http LAN origin) with `NonSecureContextError`, so there a CRM control whose
 * offline action queues a call can never work offline and must not claim
 * `data-available-offline`. It makes the framework's own test, read on every call.
 *
 * @returns {boolean}
 */
export function isCrmOfflineQueueUsable() {
    return Boolean(window.isSecureContext);
}

/**
 * Offline where the framework queue cannot hold a call (`isCrmOfflineQueueUsable`):
 * a CRM control whose offline action queues one then drops `data-available-offline`,
 * so the framework disables it with its `o_disabled_offline` state, and its action
 * does nothing. A control the framework does not disable, the Delete of a lead card
 * menu opened online, takes that state from CRM (`KanbanRecord.crmDeleteBlocked`).
 * The connection signal of `plugin` is read first, so a render calling it follows
 * the connection. Always `false` online and in a secure context.
 *
 * @param {OfflinePlugin} [plugin]
 * @returns {boolean}
 */
export function isCrmOfflineQueueBlocked(plugin) {
    return Boolean(plugin?.isOffline()) && !isCrmOfflineQueueUsable();
}

/**
 * Tells whether a view button is a CRM DISABLE control: an `object`/`action`
 * button on a lead, team or stage record, or the campaign's lead counter, not
 * tagged `data-available-offline`, or tagged so where the offline queue its
 * offline action needs cannot be used (`isCrmOfflineQueueUsable`, e.g. "Won").
 * Pure: it reads no signal.
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
    if (attrs && "data-available-offline" in attrs && isCrmOfflineQueueUsable()) {
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
 * Tells whether a view, form or record holds a lead's meeting (`calendar.event`):
 * opened by the CRM meetings action (`CRM_MEETINGS_ACTION`), or in a context naming
 * a lead the way the server links a new meeting to it (`calendar.event.default_get`
 * in `crm/models/calendar.py`): `default_opportunity_id`, set by the lead's
 * Schedule Meeting and by the calendar opened for a lead's meeting activity, or
 * `default_res_model` "crm.lead", set by the calendar opened from a lead's activity
 * scheduling. Meetings have no offline support, so offline such a meeting is
 * neither written nor queued. Pure: it reads no signal.
 *
 * @param {string} [resModel]
 * @param {Object} [context]
 * @param {string|false} [actionXmlId] `xml_id` of the action that opened the view
 * @returns {boolean}
 */
function isCrmOfflineMeeting(resModel, context, actionXmlId) {
    return (
        resModel === "calendar.event" &&
        (actionXmlId === CRM_MEETINGS_ACTION ||
            Boolean(context?.default_opportunity_id) ||
            context?.default_res_model === "crm.lead")
    );
}

/**
 * Tells whether a form, or its record, holds a CRM record that is never saved
 * offline. These are the CRM transient records that only their buttons use: a CRM
 * wizard, the settings opened with `context.module` "crm" (the CRM settings page),
 * a mail composer opened by a CRM bound action (`CRM_COMPOSER_ACTIONS`, read from
 * the opening action's `xml_id`), or a mail wizard of the lead chatter, opened on
 * leads (`CRM_LEAD_MAIL_WIZARD_KEYS`, read from the form's context). They also
 * include a lead's meeting (`isCrmOfflineMeeting`). Offline, saving or reloading
 * such a record cannot work: its `web_save` is a transient or meeting write, never
 * queued, and the settings model reads no cache. Pure: it reads no signal.
 *
 * @param {string} [resModel]
 * @param {Object} [context]
 * @param {string|false} [actionXmlId] `xml_id` of the action that opened the form
 * @returns {boolean}
 */
function isCrmOfflineTransientForm(resModel, context, actionXmlId) {
    return (
        CRM_WIZARD_MODELS.has(resModel) ||
        (resModel === "res.config.settings" && context?.module === "crm") ||
        (resModel === "mail.compose.message" && CRM_COMPOSER_ACTIONS.has(actionXmlId)) ||
        (Object.hasOwn(CRM_LEAD_MAIL_WIZARD_KEYS, resModel) &&
            context?.[CRM_LEAD_MAIL_WIZARD_KEYS[resModel]] === "crm.lead") ||
        isCrmOfflineMeeting(resModel, context, actionXmlId)
    );
}

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
 * Whether a URL query string carries the "New Lead" deep-link flag: only
 * `crm_quick_create=1`, the value the PWA shortcut sends, sets it.
 *
 * @param {string} search URL query string, e.g. `location.search`
 * @returns {boolean}
 */
export function isQuickCreateDeepLink(search) {
    return new URLSearchParams(search).get("crm_quick_create") === "1";
}

/**
 * The "New Lead" deep-link flag (PWA shortcut), set only by `crm_quick_create=1`
 * and read once, at module evaluation, before the router rewrites the URL.
 * `pending` is the test seam: tests set it.
 */
export const quickCreateDeepLink = {
    pending: isQuickCreateDeepLink(browser.location.search),
};

/**
 * Consumes and clears the pending quick-create flag, returning whether it was set.
 * Does not open a sheet; the caller controls that action.
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

function byTimeStamp(a, b) {
    return (a.value.extras?.timeStamp || 0) - (b.value.extras?.timeStamp || 0);
}

function isParked(entry) {
    return Boolean(entry.value.extras?.error);
}

/**
 * Tells whether a value read back from the queue is a field-value mapping (a
 * non-null, non-array object), the shape of a `web_save` values argument and of
 * its display values (`extras.changes`).
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

// -----------------------------------------------------------------------------
// Entry index (one pass over the queue, shared by every projection)
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} CrmEntryIndex
 * @property {Map<string|undefined, Object[]>} byModel entries per `value.model`, in
 *  the order of the indexed list (the queue order)
 * @property {Map<string, Object>} byKey entry per `entry.key`
 * @property {Map<Object, number>} positions position of each entry in the indexed list
 * @property {Map<number, Object[]>} leadWritesById `crm.lead` calls of
 *  `LEAD_WRITE_METHODS` per id their `args[0]` array targets
 * @property {Map<any, Object[]>} leadCreatesByStage `crm.lead` creations
 *  (`isCreateSave`) per `args[1].stage_id`
 * @property {Map<any, Object[]>} activityCreatesByLead `mail.activity` creations on
 *  `crm.lead` per `res_id` of their values
 * @property {Set<number>} doneActivityIds activity ids a `mail.activity`
 *  `action_done` targets
 *
 * Every per-id bucket is in replay order (`extras.timeStamp`, ties in list order).
 */

function addToBucket(buckets, id, entry) {
    const bucket = buckets.get(id);
    if (bucket) {
        bucket.push(entry);
    } else {
        buckets.set(id, [entry]);
    }
}

/**
 * Indexes queue entries (the framework queue, or the entries a replay hold keeps)
 * in one pass, so that each projection reads its lead's or stage's entries
 * directly instead of filtering every entry. Bucket membership follows the
 * projections' own matching rules: a call targets the ids its `args[0]` array
 * holds, a falsy id targets nothing, and a `NaN` stage or lead, which no strict
 * comparison matches, is left out.
 *
 * @param {Array<{key: string, value: Object}>} entries
 * @returns {CrmEntryIndex}
 */
function buildEntryIndex(entries) {
    const index = {
        byModel: new Map(),
        byKey: new Map(),
        positions: new Map(),
        leadWritesById: new Map(),
        leadCreatesByStage: new Map(),
        activityCreatesByLead: new Map(),
        doneActivityIds: new Set(),
    };
    entries.forEach((entry, position) => {
        const { value } = entry;
        index.positions.set(entry, position);
        index.byKey.set(entry.key, entry);
        addToBucket(index.byModel, value?.model, entry);
        if (value?.model === "crm.lead") {
            const ids = value.args?.[0];
            if (LEAD_WRITE_METHODS.has(value.method) && Array.isArray(ids)) {
                for (const id of new Set(ids)) {
                    if (id) {
                        addToBucket(index.leadWritesById, id, entry);
                    }
                }
            }
            if (isCreateSave(value) && !Number.isNaN(value.args[1].stage_id)) {
                addToBucket(index.leadCreatesByStage, value.args[1].stage_id, entry);
            }
        } else if (value?.model === "mail.activity") {
            const vals = value.method === "create" && value.args?.[0]?.[0];
            if (vals && vals.res_model === "crm.lead" && !Number.isNaN(vals.res_id)) {
                addToBucket(index.activityCreatesByLead, vals.res_id, entry);
            }
            const ids = value.args?.[0];
            if (value.method === "action_done" && Array.isArray(ids)) {
                for (const id of ids) {
                    index.doneActivityIds.add(id);
                }
            }
        }
    });
    // Stable sorts: entries of one time stamp keep the list order.
    for (const buckets of [
        index.leadWritesById,
        index.leadCreatesByStage,
        index.activityCreatesByLead,
    ]) {
        for (const bucket of buckets.values()) {
            bucket.sort(byTimeStamp);
        }
    }
    return index;
}

/**
 * The indexed lead writes that concern `record`: its own offline save
 * (`record.offlineId`, any method of its model) and the lead methods targeting
 * `record.resId`, possibly queued through another `Record` instance of the same
 * lead. Each entry is listed once, in replay order (ties in list order).
 *
 * @param {CrmEntryIndex} index
 * @param {Object} record
 * @returns {Object[]} a new array
 */
function leadWritesIn(index, record) {
    const writes = [];
    const own = record.offlineId ? index.byKey.get(record.offlineId) : undefined;
    if (own && own.value?.model === record.resModel) {
        writes.push(own);
    }
    if (record.resModel === "crm.lead" && record.resId) {
        for (const entry of index.leadWritesById.get(record.resId) || []) {
            if (entry !== own) {
                writes.push(entry);
            }
        }
    }
    if (writes.length > 1) {
        writes.sort((a, b) => byTimeStamp(a, b) || index.positions.get(a) - index.positions.get(b));
    }
    return writes;
}

/**
 * Derived index of each offline plugin's queue (`buildEntryIndex` of
 * `_ormToSync()`), rebuilt once per queue change and shared by every hook of that
 * plugin. It stores nothing beyond the queue it is derived from.
 *
 * A computed joins the scope it is created in and stops following its sources
 * when that scope ends, while other components still read it: readers therefore
 * read the queue signal themselves first (`readQueueIndex`), which keeps them
 * subscribed, and the computed recomputes at its next read.
 *
 * @type {WeakMap<OfflinePlugin, () => CrmEntryIndex>}
 */
const queueIndexes = new WeakMap();

/**
 * @param {OfflinePlugin} plugin
 * @returns {CrmEntryIndex} the index of the plugin's current queue
 */
function readQueueIndex(plugin) {
    plugin._ormToSync();
    let index = queueIndexes.get(plugin);
    if (!index) {
        index = untrack(() => computed(() => buildEntryIndex(Object.values(plugin._ormToSync()))));
        queueIndexes.set(plugin, index);
    }
    return index();
}

// -----------------------------------------------------------------------------
// Online lead writes made during a replay (sent after the queued writes ahead)
// -----------------------------------------------------------------------------

/**
 * Lead fields a queued `crm.lead` call writes: the values of a `web_save`, the
 * stage, probability and active state `action_set_won` sets, the active state of
 * an archive or unarchive; none for any other call (an `unlink` writes none).
 *
 * @param {{method?: string, args?: any}} value
 * @returns {string[]}
 */
function writtenLeadFields(value) {
    switch (value?.method) {
        case "web_save":
            return isFieldMapping(value.args?.[1]) ? Object.keys(value.args[1]) : [];
        case "action_set_won":
            return ["stage_id", "probability", "active"];
        case "action_archive":
        case "action_unarchive":
            return ["active"];
        default:
            return [];
    }
}

/**
 * The pending (not parked) queued writes of the lead of `record` (`leadWritesIn`:
 * the record's own offline save, or a call targeting its id) whose replay could
 * overwrite a write of `fieldNames` sent now: for a field write, every one writing a
 * field of the lead (`writtenLeadFields`), whatever fields it names; for a delete
 * (`fieldNames` is `null`), every pending one, which the delete would make fail. The
 * fields a call names are not all the fields its replay changes: the server
 * recomputes stored fields it does not name (a team or type change recomputes the
 * lead's stage), so no write of the lead is independent of another one. In replay
 * order; none for a record that is not a saved lead. Reads the queue reactively,
 * through the shared per-lead index (`readQueueIndex`).
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} record
 * @param {string[]|null} fieldNames the fields the write sets; `null` for a delete
 * @returns {{key: string, value: Object}[]}
 */
export function crmPendingLeadWrites(plugin, record, fieldNames) {
    if (record?.resModel !== "crm.lead" || !record.resId) {
        return [];
    }
    return leadWritesIn(readQueueIndex(plugin), record).filter(
        (entry) =>
            !isParked(entry) && (fieldNames === null || writtenLeadFields(entry.value).length > 0)
    );
}

/**
 * Tells whether the replay running on `plugin` has still to send a queued write of
 * the lead of `record` that an online write of `fieldNames` made now must follow
 * (`crmPendingLeadWrites`: any pending write of a field of the lead, or any pending
 * call of it for a delete). Always `false` outside a replay and for a record that is
 * not a saved lead. The connection state the plugin reports plays no part here: the
 * replay sends the calls it read when it started until one of them is lost, so a
 * connection reported lost meanwhile (by another request) may well be up, and a
 * write sent then would still reach the server ahead of those calls. Reads the
 * replay state and the queue reactively.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} record
 * @param {string[]|null} fieldNames
 * @returns {boolean}
 */
function hasLeadWriteAhead(plugin, record, fieldNames) {
    return plugin.syncingORM() && crmPendingLeadWrites(plugin, record, fieldNames).length > 0;
}

/**
 * Turn of a write of the leads of `records` (a pipeline card's save, stage choice or
 * delete) made while the replay has still to send queued writes of them, whatever
 * connection state the plugin reports. The framework's replay sends the queue in
 * time-stamp order, one call a second, while an online call is sent at once: a
 * write the user makes after those queued writes would reach the server before
 * them and be overwritten by them (a delete would make them fail). The write
 * therefore waits until no pending write ahead of it remains (`hasLeadWriteAhead`):
 * the replay sent or parked each of them, or the replay ended. It is then sent as
 * any write is (a card save whose turn comes while the connection is still reported
 * lost, with such a write still pending because the replay stopped on it, is queued
 * after it instead: `CrmKanbanRecord._crmQueuesSave`).
 *
 * The wait also ends, with writes still ahead, as soon as the plugin reports the
 * connection lost or the owner of the write is destroyed (`isDestroyed`): the
 * replay's request may then never be answered (a request has no time-out, and a
 * connection reported lost does not stop the replay), and nothing would end the
 * wait otherwise. The write is then queued after the writes ahead instead of being
 * sent ("queue only"): the running replay may still send them, so a write sent then
 * would reach the server first. The replay that follows sends it after them
 * (`crmReplayQueued`, and the replay's own end, `OfflinePlugin._syncORM`). The queue
 * is neither read for conflicts nor changed: nothing is dropped, merged or
 * reordered, and no request is added while the write waits. The effect following
 * the replay is stopped at every outcome.
 *
 * Sent at its turn, the write reaches the server in whatever session the browser
 * then holds, which another user, or the same user id on another database served on
 * this origin, may have opened meanwhile (in another tab). So the turn's outcome
 * carries the user who made the write and the database of the session they made it
 * in, read when its wait starts (`CrmWriteOrigin`), which its request sends in its
 * context (`crmContextWithOrigin`): the server refuses it in another user's session,
 * as it refuses a queued call replayed there, and in a session of another database,
 * and nothing is applied. A write queued only carries the identity every queued CRM
 * call carries (the CRM `OfflinePlugin.scheduleORM`).
 *
 * @param {OfflinePlugin} plugin
 * @param {Object[]} records the datapoints of the leads the write targets
 * @param {string[]|null} [fieldNames] the fields it writes; `null` for a delete
 * @param {(() => boolean)|null} [isDestroyed] signal of the destruction of the
 *  write's owner (its model)
 * @returns {Promise<CrmWriteTurn>|undefined} `undefined` when the write may be sent
 *  now, which is always the case with no replay running, so that it is then sent as
 *  before, without any added wait; else a promise resolved at its turn with its
 *  outcome (`CrmWriteTurn`): `queueOnly` is `false` once no write is ahead of it,
 *  `true` when it is to be queued only, and `origin` is the origin of the write
 */
export function crmLeadWriteTurn(plugin, records, fieldNames = null, isDestroyed = null) {
    const isAhead = () => records.some((record) => hasLeadWriteAhead(plugin, record, fieldNames));
    if (!untrack(isAhead)) {
        return undefined;
    }
    const origin = Object.freeze({
        [CRM_OFFLINE_UID_KEY]: user.userId,
        [CRM_OFFLINE_DB_KEY]: session.db,
    });
    let stop;
    const turn = new Promise((resolve) => {
        // Created outside any computation, so that only `stop` disposes of it. Its
        // first run is synchronous; it runs again on every change of the sync, queue,
        // connection and owner signals it reads.
        stop = untrack(() =>
            effect(() => {
                if (!isAhead()) {
                    resolve(false);
                } else if (plugin.isOffline() || isDestroyed?.()) {
                    resolve(true);
                }
            })
        );
    });
    return turn.then((queueOnly) => {
        stop();
        return { queueOnly, origin };
    });
}

/**
 * Origin of a lead write held for its turn (`crmLeadWriteTurn`): the context keys
 * naming the user who made it (`CRM_OFFLINE_UID_KEY`), the one every queued CRM call
 * carries, and the database of the session they made it in (`CRM_OFFLINE_DB_KEY`),
 * by which the server refuses a call made by another user than the caller, or in a
 * session of another database.
 *
 * @typedef {{crm_offline_uid: number|false, crm_offline_db: string}} CrmWriteOrigin
 */

/**
 * Outcome of the turn of a lead write held for it (`crmLeadWriteTurn`). `queueOnly`
 * is `true` when the wait ended with writes of the lead still ahead of it (the
 * connection reported lost, or the write's owner destroyed): the write is then
 * queued after them without being sent. It is `false` once none is ahead: the write
 * then goes on as any write does, and its request sends `origin`, read when the wait
 * started, in its context (`crmContextWithOrigin`).
 *
 * @typedef {{queueOnly: boolean, origin: CrmWriteOrigin}} CrmWriteTurn
 */

/**
 * The context a lead write sends: `context` with its origin added when it was held
 * for its turn (`crmLeadWriteTurn`); the very `context` given for a write sent at
 * once (no `origin`), whose call is sent as before.
 *
 * @param {Object|undefined} context
 * @param {CrmWriteOrigin} [origin]
 * @returns {Object|undefined}
 */
export function crmContextWithOrigin(context, origin) {
    return origin ? { ...context, ...origin } : context;
}

/**
 * Makes the replay deliver a CRM call that was just queued instead of being sent (a
 * write released "queue only" by `crmLeadWriteTurn` or the lead form's replay hold,
 * or a save queued while the connection is still reported lost). The request the
 * call would have sent was also what told the framework that the connection is back.
 * So, while the connection is reported lost, the plugin checks it (`checkConnection`,
 * the check the offline systray offers): when it is back, the replay starts and
 * sends the queue in time-stamp order, the call last; otherwise nothing changes.
 * Online with no replay running, the replay starts. A running replay read the queue
 * before the call was queued: its end starts the next one (`OfflinePlugin._syncORM`).
 * Nothing is awaited.
 *
 * @param {OfflinePlugin} plugin
 */
export function crmReplayQueued(plugin) {
    untrack(() => {
        if (plugin.isOffline()) {
            crmOwnEffectPromise(plugin.checkConnection());
        } else if (!plugin.syncingORM()) {
            crmOwnEffectPromise(plugin._syncORM());
        }
    });
}

/**
 * An online write of a lead record waiting for its turn (`crmLeadWriteTurn`: behind
 * every pending queued write of the lead, whatever fields it writes), or made at it,
 * as the CRM kanban model marks it on the record (`crmTurnWrite`, see
 * `CrmKanbanModel.crmWriteInTurn`): the record's values of `fieldNames`, the fields
 * the write sets, show over every queued or replayed write of the lead stamped up to
 * `timeStamp`, and the later ones show over them. Its `timeStamp` is
 * `crmTurnWriteTimeStamp`: not before any write of the lead queued or replayed when
 * it was made, so that those, made before it, never show over it. `undefined` for a
 * record without such a write.
 *
 * @typedef {{timeStamp: number, fieldNames: string[]}} CrmTurnWrite
 */

/**
 * Time stamp of an online write of the lead of `record` made now and waiting for its
 * turn (`CrmTurnWrite`): now, or the latest time stamp of the lead's writes queued or
 * just replayed (`leadWritesIn` of the queue and of the replay hold, the writes
 * `projectLead` applies) when that is later. A queued write may be stamped past the
 * clock (one that must replay after another write queued in the same millisecond is
 * stamped one past it), and the online write, made after all of them, must still
 * apply after them; on a tie, `projectLead` applies it last. Nothing in the queue is
 * changed. Later writes of those fields through the record itself (a save, the
 * mobile `crmWriteStage`) are in the record's values the write shows, so they show
 * whatever their time stamp. Reads the queue and the hold without tracking them.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} record
 * @returns {number}
 */
export function crmTurnWriteTimeStamp(plugin, record) {
    return untrack(() => {
        // Without a replay hold (no mobile pipeline yet), no write was kept: none is
        // created here.
        const indexes = replayHolds.has(plugin)
            ? [readQueueIndex(plugin), readHeldIndex(plugin)]
            : [readQueueIndex(plugin)];
        let timeStamp = Date.now();
        for (const index of indexes) {
            for (const { value } of leadWritesIn(index, record)) {
                timeStamp = Math.max(timeStamp, value.extras?.timeStamp || 0);
            }
        }
        return timeStamp;
    });
}

// -----------------------------------------------------------------------------
// Replay hold (entries the replay just sent, until the views reload)
// -----------------------------------------------------------------------------

/** Models whose replayed entries the mobile views keep showing until they reload. */
const HELD_MODELS = freezeSet(["crm.lead", "mail.activity"]);

/**
 * Key, on a root configuration, of the replay token `markRootLoad` gives its load.
 * A symbol: spread and `Object.assign` copy it with the configuration, while no
 * request, cache key or serialized state includes it.
 */
const REPLAY_TOKEN = Symbol("crmReplayToken");

/**
 * @typedef {Object} CrmReplayHolder
 * @property {(entry: {key: string, value: Object}) => boolean} accept
 * @property {Map<string, {entry: Object, seq: number}>} entries the entries it holds
 *
 * @typedef {Object} CrmReplayHold
 * @property {number} seq number of the last capture
 * @property {Set<CrmReplayHolder>} holders the mounted holders
 * @property {import("@odoo/owl").Signal<Object[]>} held the entries some holder holds
 * @property {() => CrmEntryIndex} index `buildEntryIndex` of `held`
 */

/**
 * Replay hold of each offline plugin.
 *
 * The framework's replay removes each entry from the queue as soon as its call
 * succeeds, and the views showing it reload only afterwards: the projections, read
 * from the queue alone, would meanwhile drop a lead created offline (and its share
 * of the stage count and revenue), a logged activity or a completion, until the
 * reload shows the server record. The hold keeps in memory, for the mounted
 * components that ask for it (`holdReplayed`), the `crm.lead` and `mail.activity`
 * entries the replay has just removed, and the projections keep showing them as
 * pending until that component displays a root loaded from the server after their
 * replay. It creates no queue, cache, store or persistence and serves no RPC read:
 * like `crmServerValues`, it only bridges the time until the reconciliation reload
 * replaces what it holds. The queue itself, and everything that reads it to decide
 * what to replay or discard (`queuedEntries`, `isQueued`, `onReplayed`,
 * `onEntriesDiscarded`, the pending-sync badge, the systray), never sees it.
 *
 * @type {WeakMap<OfflinePlugin, CrmReplayHold>}
 */
const replayHolds = new WeakMap();

/**
 * Publishes the entries the mounted holders hold (each key once, in capture order).
 *
 * @param {CrmReplayHold} hold
 */
function publishHeld(hold) {
    const byKey = new Map();
    for (const holder of hold.holders) {
        for (const item of holder.entries.values()) {
            if (!byKey.has(item.entry.key)) {
                byKey.set(item.entry.key, item);
            }
        }
    }
    const items = [...byKey.values()].sort((a, b) => a.seq - b.seq);
    hold.held.set(Object.freeze(items.map(({ entry }) => entry)));
}

/**
 * Gives the entries a replay has just removed from the queue to the mounted
 * holders accepting them; an entry no holder accepts is not kept. A holder whose
 * `accept` throws keeps nothing of the entry, and the error is reported.
 *
 * @param {CrmReplayHold} hold
 * @param {Object[]} entries
 */
function keepReplayed(hold, entries) {
    hold.seq++;
    let kept = false;
    for (const holder of hold.holders) {
        for (const entry of entries) {
            let accepted = false;
            try {
                accepted = holder.accept(entry);
            } catch (error) {
                crmReportError(error);
            }
            if (accepted) {
                holder.entries.set(entry.key, { entry, seq: hold.seq });
                kept = true;
            }
        }
    }
    if (kept) {
        publishHeld(hold);
    }
}

/**
 * The replay hold of `plugin`, created at the first call. Its capture is a single
 * immediate effect per plugin: it runs inside every write of the queue, before
 * any render can show the queue without an entry the replay has just sent. An
 * entry that leaves the queue while `syncingORM()` is true has been replayed
 * (parked entries are re-scheduled under their key and never leave); one that
 * leaves outside a replay was discarded, and is not kept. The queue is compared by
 * key, as the replay replaces the whole queue object when it starts.
 *
 * The capture runs inside the framework's replay loop, where an exception would
 * park the call it has just replayed: nothing it runs may throw, and an error is
 * reported through `crmReportError` instead.
 *
 * @param {OfflinePlugin} plugin
 * @returns {CrmReplayHold}
 */
function getReplayHold(plugin) {
    let hold = replayHolds.get(plugin);
    if (hold) {
        return hold;
    }
    const held = signal(Object.freeze([]));
    hold = { seq: 0, holders: new Set(), held, index: null };
    replayHolds.set(plugin, hold);
    untrack(() => {
        // Readers read `held` themselves first (see `queueIndexes`).
        hold.index = computed(() => buildEntryIndex(held()));
        let previous = new Map();
        immediateEffect(() => {
            const current = new Map(Object.entries(plugin._ormToSync()));
            untrack(() => {
                const removed = previous;
                previous = current;
                try {
                    if (!plugin.syncingORM()) {
                        return;
                    }
                    const replayed = [];
                    for (const [key, entry] of removed) {
                        if (
                            !current.has(key) &&
                            HELD_MODELS.has(entry?.value?.model) &&
                            !isParked(entry)
                        ) {
                            replayed.push(entry);
                        }
                    }
                    if (replayed.length) {
                        keepReplayed(hold, replayed);
                    }
                } catch (error) {
                    crmReportError(error);
                }
            });
        });
    });
    return hold;
}

/**
 * @param {OfflinePlugin} plugin
 * @returns {CrmEntryIndex} the index of the entries the plugin's replay hold keeps
 */
function readHeldIndex(plugin) {
    const hold = getReplayHold(plugin);
    hold.held();
    return hold.index();
}

/**
 * Entries of one projection bucket in replay order: the held ones (already
 * replayed) and the queued ones. A key queued again counts once, as queued; on a
 * time-stamp tie the held entry comes first, as it was queued before.
 *
 * @param {Object[]|undefined} queued bucket of the queue index
 * @param {Object[]|undefined} held bucket of the held index
 * @returns {Object[]} not to be mutated (it may be one of the buckets)
 */
function withHeld(queued, held) {
    if (!held?.length) {
        return queued || [];
    }
    if (!queued?.length) {
        return held;
    }
    const queuedKeys = new Set(queued.map(({ key }) => key));
    return [...held.filter(({ key }) => !queuedKeys.has(key)), ...queued].sort(byTimeStamp);
}

/**
 * Provisional card data of a lead creation entry (`leadCreatesByStage`): its key,
 * the display values its save recorded (`extras.changes`, else the saved values),
 * and whether its replay was rejected (parked).
 *
 * @param {{key: string, value: Object}} entry
 * @returns {{key: string, name: any, contact_name: any, partner_id: any,
 *  expected_revenue: any, stage_id: any, parked: boolean}}
 */
function provisionalLead(entry) {
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

function getActivityTypesRevision(plugin) {
    let revision = activityTypesRevisions.get(plugin);
    if (!revision) {
        revision = signal(0);
        activityTypesRevisions.set(plugin, revision);
    }
    return revision;
}

/**
 * Per offline plugin instance (the session, as above), the ids of the activity
 * types the last successful warm-up read, in the server's order (`sequence, id`).
 * Ids only: the labels stay in the framework relational-field cache. They select
 * and order the cached types the activity sheet offers, so a type archived or set
 * up for another model, which the cache keeps once a lead or another app has
 * cached it, is not offered.
 *
 * @type {WeakMap<OfflinePlugin, number[]>}
 */
const warmedActivityTypeIds = new WeakMap();

/**
 * Reads the activity types usable on leads (active, generic or `crm.lead`) from
 * the server, in the model's order (`sequence, id`). The warm-up and the online
 * read without relational-field cache share it, so both offer the same types.
 *
 * @param {Object} orm the ORM service
 * @returns {Promise<{id: number, display_name: string}[]>}
 */
async function readLeadActivityTypes(orm) {
    const { records } = await orm.webSearchRead(
        "mail.activity.type",
        [["res_model", "in", [false, "crm.lead"]]],
        { specification: { display_name: {} } }
    );
    return records;
}

/**
 * Resolves with the rows of `read`, a read of the framework relational-field cache
 * (`searchMany2XRecords`, `readMany2XRecords`), or with `undefined`, the value those
 * reads resolve with when there is no cache, when it reaches a row this session
 * cannot decrypt. The cache is shared by every user of the browser, while each
 * user's rows are encrypted with that user's key: the Web Crypto API rejects a row
 * written by another user with an "OperationError", which fails the whole read.
 * Such a read has nothing usable for this user. Every other error propagates.
 *
 * @template T
 * @param {Promise<T>} read
 * @returns {Promise<T|undefined>}
 */
async function readDecryptableCache(read) {
    try {
        return await read;
    } catch (error) {
        if (error instanceof DOMException && error.name === "OperationError") {
            return undefined;
        }
        throw error;
    }
}

// -----------------------------------------------------------------------------
// Asynchronous work started by effects
// -----------------------------------------------------------------------------

/** Errors `crmReportError` already handed to the framework error service. */
const crmReportedErrors = new WeakSet();

/**
 * Ignore `ConnectionLostError`; report other unawaited-work failures through
 * standard unhandled-promise handling, once per error object.
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
// Replay: one delivery per queued CRM call
// -----------------------------------------------------------------------------

/**
 * Models whose queued calls the framework replay (`OfflinePlugin._syncORM`) sends
 * through `crmReplayCall`. Calls of every other model are replayed unchanged.
 */
const CRM_REPLAY_MODELS = freezeSet(["crm.lead", "crm.stage", "crm.team", "mail.activity"]);

/** Offline plugin instances whose replay goes through `crmReplayCall`. */
const crmReplayPlugins = new WeakSet();

/**
 * Context key of the delivery key a quick create sends with its lead create, a
 * `crm.lead` record (a lead form, a kanban quick create) with every create of its
 * new lead once it entered the offline flow (`Record` patch of `crm_form.js`: a save
 * started while the connection is reported lost, the create queued when a request
 * is lost, and every later save of the still-new lead, online ones included), any
 * lead create queued without one (`OfflinePlugin.scheduleORM` patch below), and the
 * activity sheet with each activity it schedules, online and in its queued replay
 * alike. The framework replay is at-least-once (a create whose answer is lost
 * stays queued and is sent again), so the server's `crm.lead` `web_save` and
 * `mail.activity` `create` register the key with the record they create and answer
 * any later delivery of that key with this record instead of creating another one;
 * only a lead create flagged as a later save of its lead
 * (`CRM_OFFLINE_CREATE_WRITE`) writes its values there.
 */
export const CRM_OFFLINE_CREATE_KEY = "crm_offline_create_key";

/**
 * Context key (value `true`) of a lead create that is a later save of the lead its
 * delivery key (`CRM_OFFLINE_CREATE_KEY`) names: a save of a still-new lead once a
 * delivery of its key was sent or queued, or a queued create queued again under its
 * key. The server writes the values of such a delivery on the lead the key already
 * created; a delivery without it (the same create sent again because its answer was
 * lost) writes nothing, so a save made since by the lead's id keeps its values.
 */
export const CRM_OFFLINE_CREATE_WRITE = "crm_offline_create_write";

/**
 * Context key of the id of the user who queued a call of `CRM_REPLAY_MODELS`, or
 * made an online lead write held for its turn in a replay (`crmLeadWriteTurn`). The
 * offline store is shared by every session of the browser, and pages that do not
 * load this module (website, portal) replay it in whatever session they have, so
 * the server refuses a call carrying this key whose user is not the caller.
 */
export const CRM_OFFLINE_UID_KEY = "crm_offline_uid";

/**
 * Context key asking a `crm.lead` `web_search_read` to list, under the same key of
 * its answer, the stage choices of its search: the stages the same search shows
 * when grouped by stage (`loadStageChoices`). Sent by the online discard reload of
 * an ungrouped small-screen list only (`CrmKanbanModel`).
 */
export const CRM_STAGE_CHOICES_KEY = "crm_stage_choices";

/**
 * Context key of the database of the session in which an online lead write held for
 * its turn in a replay was made (`crmLeadWriteTurn`), sent with the user who made it
 * (`CRM_OFFLINE_UID_KEY`). Several databases served on one origin share the
 * browser's session cookie, and a user id names a user of one database only (the
 * administrator has the same id in each of them): signed in on another database
 * meanwhile (in another tab), the browser would send the write there, as that
 * database's user of the same id. So the server refuses a call carrying this key
 * that reaches another database than this one.
 */
export const CRM_OFFLINE_DB_KEY = "crm_offline_db";

/**
 * A new delivery key (`CRM_OFFLINE_CREATE_KEY`): 128 random bits as 32 lowercase
 * hexadecimal digits, the format the server accepts. `crypto.getRandomValues` is
 * available on every origin, unlike `crypto.randomUUID` (secure contexts only),
 * and a non-secure origin still sends the key with its online save.
 *
 * @returns {string}
 */
export function newCrmOfflineCreateKey() {
    let key = "";
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
        key += byte.toString(16).padStart(2, "0");
    }
    return key;
}

/** Format of a delivery key (`CRM_OFFLINE_CREATE_KEY`) the server accepts. */
const CRM_OFFLINE_CREATE_KEY_FORMAT = /^[0-9a-f]{32}$/;

/**
 * Whether `key` is a delivery key (`CRM_OFFLINE_CREATE_KEY`) in the format the server
 * accepts: 32 lowercase hexadecimal digits.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isCrmOfflineCreateKey(key) {
    return typeof key === "string" && CRM_OFFLINE_CREATE_KEY_FORMAT.test(key);
}

/**
 * Whether a call is a lead create: a `crm.lead` `web_save` without ids.
 *
 * @param {string} model
 * @param {string} method
 * @param {any[]} [args]
 * @returns {boolean}
 */
function isCrmLeadCreate(model, method, args) {
    return (
        model === "crm.lead" &&
        method === "web_save" &&
        Array.isArray(args?.[0]) &&
        args[0].length === 0
    );
}

/**
 * The delivery key context of a lead create queued without a valid key, under the
 * queue key `id`: the key of the create already queued under that key, with the
 * later-save flag (`CRM_OFFLINE_CREATE_WRITE`), since the create queued again holds
 * values that may extend a version of the lead already delivered; otherwise a new
 * key.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} [id] queue key the create is queued under
 * @returns {Object}
 */
function queuedLeadCreateKeyContext(plugin, id) {
    const queued =
        id === undefined || id === null ? undefined : untrack(() => plugin._ormToSync()[id]);
    const value = queued?.value;
    const key = value?.kwargs?.context?.[CRM_OFFLINE_CREATE_KEY];
    if (isCrmLeadCreate(value?.model, value?.method, value?.args) && isCrmOfflineCreateKey(key)) {
        return { [CRM_OFFLINE_CREATE_KEY]: key, [CRM_OFFLINE_CREATE_WRITE]: true };
    }
    return { [CRM_OFFLINE_CREATE_KEY]: newCrmOfflineCreateKey() };
}

/**
 * Removes a replayed call from the offline store and waits until it is removed.
 * The call was delivered, so a failure is reported and does not reject: a rejected
 * call would be parked as refused.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 */
async function removeReplayedFromStore(plugin, key) {
    try {
        await plugin._idb.delete(OfflinePlugin.ORM_SYNC_TABLE_NAME, key);
    } catch (error) {
        crmReportError(error);
    }
}

/**
 * Arguments (`args`, the very array sent) of the calls the replay of each offline
 * plugin started sending through `crmReplayCall` and that have not failed since: in
 * flight, or delivered. A call that failed (connection lost, refused) leaves the set.
 * Plugins and arguments are keyed raw (`toRaw`): views read them through reactive
 * proxies, the replay through the plugin itself.
 *
 * @type {WeakMap<OfflinePlugin, WeakSet<any[]>>}
 */
const crmSentReplayArgs = new WeakMap();

/**
 * Per offline plugin, the arguments queued calls held before `rewriteCrmQueuedCall`
 * replaced them → the queue key of each call. A running replay sends each call with
 * the arguments it read when it started, so `crmReplayCall` finds a rewritten call
 * by them and sends the arguments its entry holds instead. Keyed raw, as
 * `crmSentReplayArgs` is.
 *
 * @type {WeakMap<OfflinePlugin, WeakMap<any[], string>>}
 */
const crmRewrittenReplayArgs = new WeakMap();

/**
 * Per offline plugin, the arguments (`args`, as sent) of each `crm.lead` `web_save`
 * holding x2many commands (a list value) that its replay delivered through
 * `crmReplayCall`, by queue key, in delivery order, for the lifetime of the page. A
 * lead form reads them (`crmDeliveredArgs`) to tell whether the queued save creating
 * or linking records of its lists was delivered once that save left the queue: the
 * queue no longer holds it then, and the framework reuses a record's key for its
 * later saves. Keyed raw, as `crmSentReplayArgs` is.
 *
 * @type {WeakMap<OfflinePlugin, Map<string, any[][]>>}
 */
const crmDeliveredReplayArgs = new WeakMap();

/**
 * Whether a replay of `plugin` started sending the queued call `entry` as it holds it
 * now (its `args`), and that call has not failed: it is in flight, or delivered and
 * about to leave the queue. Such a call can no longer be rewritten
 * (`rewriteCrmQueuedCall`): what the server receives is what was sent. A call whose
 * sending failed is replayed again with what its entry holds then.
 *
 * @param {OfflinePlugin} plugin
 * @param {{key: string, value: Object}} entry a queue entry
 * @returns {boolean}
 */
export function isCrmReplaySent(plugin, entry) {
    const sent = crmSentReplayArgs.get(toRaw(plugin));
    return Boolean(entry && sent?.has(toRaw(entry.value.args)));
}

/**
 * The arguments of the `crm.lead` `web_save` calls holding x2many commands that the
 * replay of `plugin` delivered under the queue key `key` during the lifetime of the
 * page, oldest first (`crmDeliveredReplayArgs`): a new array, empty when it delivered
 * none. A call parked, discarded, or still queued unsent is not among them, nor one
 * the replay of another page delivered: this page reads that one as discarded.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 * @returns {any[][]}
 */
export function crmDeliveredArgs(plugin, key) {
    return [...(crmDeliveredReplayArgs.get(toRaw(plugin))?.get(key) || [])];
}

/**
 * Records `args`, delivered by the replay of `plugin` for the queued call `key`
 * (`crmReplayCall`), in `crmDeliveredReplayArgs` when it is a `crm.lead` `web_save`
 * holding x2many commands; any other call is not recorded.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 * @param {string} model
 * @param {string} method
 * @param {any[]} args
 */
function recordDeliveredArgs(plugin, key, model, method, args) {
    const values = args?.[1];
    if (
        model !== "crm.lead" ||
        method !== "web_save" ||
        !isFieldMapping(values) ||
        !Object.values(values).some(Array.isArray)
    ) {
        return;
    }
    let delivered = crmDeliveredReplayArgs.get(toRaw(plugin));
    if (!delivered) {
        delivered = new Map();
        crmDeliveredReplayArgs.set(toRaw(plugin), delivered);
    }
    const ofKey = delivered.get(key);
    if (ofKey) {
        ofKey.push(toRaw(args));
    } else {
        delivered.set(key, [toRaw(args)]);
    }
}

/**
 * Rewrites the queued call `key` of `plugin` with the arguments `args` and the extras
 * `extras`, keeping its model, method and keyword arguments, unless a replay already
 * sent it as it is (`isCrmReplaySent`) or it left the queue. Rewritten while a
 * replay runs, before that replay reached it, the call is still sent at its place
 * in that replay, with the arguments and keyword arguments its entry holds when its
 * turn comes, not with those the replay read when it started (`crmReplayCall`).
 * The call must be one the replay finds by its arguments: any call but a keyed lead
 * create (`leadCreateDeliveryKey`), whose rewrites `crmReplayCall` follows by its
 * delivery key.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 * @param {any[]} args
 * @param {Object} extras the call's extras, its time stamp and error included
 * @returns {boolean} whether the call was rewritten
 */
export function rewriteCrmQueuedCall(plugin, key, args, extras) {
    const entry = untrack(() => plugin._ormToSync()[key]);
    if (!entry || isCrmReplaySent(plugin, entry)) {
        return false;
    }
    let rewritten = crmRewrittenReplayArgs.get(toRaw(plugin));
    if (!rewritten) {
        rewritten = new WeakMap();
        crmRewrittenReplayArgs.set(toRaw(plugin), rewritten);
    }
    // Arguments an earlier rewrite replaced keep pointing at the key as well.
    rewritten.set(toRaw(entry.value.args), key);
    const { model, method, kwargs } = entry.value;
    plugin.scheduleORM(model, method, args, kwargs, { id: key, extras });
    return true;
}

/**
 * The queue entry of a call the replay sends with the arguments `args` it read before
 * `rewriteCrmQueuedCall` replaced them, when that entry is still queued for the same
 * model and method; `undefined` otherwise.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} model
 * @param {string} method
 * @param {any[]} args
 * @returns {{key: string, value: Object}|undefined}
 */
function rewrittenReplayEntry(plugin, model, method, args) {
    const key = crmRewrittenReplayArgs.get(toRaw(plugin))?.get(toRaw(args));
    const entry = key && plugin._ormToSync()[key];
    return entry && entry.value.model === model && entry.value.method === method
        ? entry
        : undefined;
}

/**
 * Sends a call of the framework replay, which takes the cross-tab replay lock,
 * sends each queued call through its plugin's silent ORM and only starts the
 * removal of a delivered one from the offline store. When the last call is
 * delivered it releases the lock at once, so another tab taking it could still
 * read that call and send it again. So a delivered call of `CRM_REPLAY_MODELS`
 * (found by its `args`, the very array the replay sends) resolves only once it
 * has left the offline store, before the replay can release the lock.
 *
 * The arguments a call is sent with are recorded until it fails
 * (`isCrmReplaySent`), and, for a delivered lead save holding x2many commands, for
 * the lifetime of the page (`crmDeliveredArgs`). A call rewritten since the replay
 * read it (`rewriteCrmQueuedCall`), found by the arguments it held then, is sent
 * with the arguments and keyword arguments its entry holds now, and is then handled
 * as a call found by its arguments: delivered, it leaves the offline store; refused,
 * it is parked with them (`scheduleORM`); with the connection lost, its entry stays
 * as it is.
 *
 * Every other outcome is the framework's: the call is sent unchanged, a lost
 * connection stops the replay and keeps the entry, and any other error parks it.
 * A lead or activity create whose answer is lost is therefore sent again,
 * verbatim: it carries the delivery key of its quick create, lead record or
 * scheduled activity (`CRM_OFFLINE_CREATE_KEY`), by which the server answers a
 * create it already made instead of making it twice, and writes nothing on it
 * unless the create is flagged as a later save of the lead
 * (`CRM_OFFLINE_CREATE_WRITE`).
 *
 * One exception keeps a lead form's later values: the replay sends each call as it
 * read it when it started, then removes or parks the entry under its key, whatever
 * that entry holds by then. A lead form whose save of its still-new lead is queued
 * into the lead's pending create (same key, same delivery key) while the replay
 * sends that create would lose the save's values. So for a keyed lead create
 * (`leadCreateDeliveryKey`) whose entry holds other values by the time its delivery
 * ends (found by its delivery key when it was rewritten before it was sent), the
 * entry is kept as it is, with those values (`keepRewrittenCreate`): delivered, it
 * stays queued and stored, and the next replay sends it again, flagged as the later
 * save of the lead it is (`CRM_OFFLINE_CREATE_WRITE`, which a lead record sends with
 * every save of its still-new lead once its create was queued), which the server
 * answers by writing those values on the lead it created; refused, it is parked
 * with those values. Calls of any other kind are never kept.
 *
 * @param {OfflinePlugin} plugin
 * @param {Object} silentOrm the plugin's silent ORM, with the settings of the ORM
 *  the call is made on
 * @param {string} model
 * @param {string} method
 * @param {any[]} args
 * @param {Object} kwargs
 */
async function crmReplayCall(plugin, silentOrm, model, method, args, kwargs) {
    if (!CRM_REPLAY_MODELS.has(model)) {
        return silentOrm.call(model, method, args, kwargs);
    }
    const entries = Object.values(plugin._ormToSync());
    const deliveryKey = leadCreateDeliveryKey({ model, method, args, kwargs });
    let entry =
        entries.find(
            ({ value }) => value.args === args && value.model === model && value.method === method
        ) ||
        (deliveryKey && entries.find(({ value }) => leadCreateDeliveryKey(value) === deliveryKey));
    if (!entry) {
        entry = rewrittenReplayEntry(plugin, model, method, args);
        if (entry) {
            ({ args, kwargs } = entry.value);
        }
    }
    if (!entry) {
        return silentOrm.call(model, method, args, kwargs);
    }
    /** Whether the entry now holds other values than the call sent (keyed creates only). */
    const isRewritten = () => {
        const stored = deliveryKey && plugin._ormToSync()[entry.key];
        return (
            Boolean(stored) &&
            stored.value.args !== args &&
            leadCreateDeliveryKey(stored.value) === deliveryKey
        );
    };
    let sent = crmSentReplayArgs.get(toRaw(plugin));
    if (!sent) {
        sent = new WeakSet();
        crmSentReplayArgs.set(toRaw(plugin), sent);
    }
    sent.add(toRaw(args));
    let result;
    try {
        result = await silentOrm.call(model, method, args, kwargs);
    } catch (error) {
        sent.delete(toRaw(args));
        if (!(error instanceof ConnectionLostError) && isRewritten()) {
            keepRewrittenCreate(plugin, entry.key, "refused");
        }
        throw error;
    }
    recordDeliveredArgs(plugin, entry.key, model, method, args);
    if (isRewritten()) {
        keepRewrittenCreate(plugin, entry.key, "delivered");
    } else {
        await removeReplayedFromStore(plugin, entry.key);
    }
    return result;
}

/**
 * The delivery key (`CRM_OFFLINE_CREATE_KEY`) of a lead create (`isCrmLeadCreate`,
 * the calls the CRM `OfflinePlugin.scheduleORM` keys) whose context carries one in
 * the format the server accepts (`isCrmOfflineCreateKey`); `undefined` for any other
 * call.
 *
 * @param {{model?: string, method?: string, args?: any, kwargs?: Object}} value
 * @returns {string|undefined}
 */
function leadCreateDeliveryKey(value) {
    const key = value?.kwargs?.context?.[CRM_OFFLINE_CREATE_KEY];
    return isCrmLeadCreate(value?.model, value?.method, value?.args) && isCrmOfflineCreateKey(key)
        ? key
        : undefined;
}

/**
 * Keyed lead creates whose queued entry the running replay must keep as it is
 * (`crmReplayCall`), per offline plugin: queue key → outcome of the delivery that
 * read older values. The framework's next step on that key consumes it: the removal
 * of a delivered call (`removeScheduledORM`), or the parking of a refused one
 * (`scheduleORM` with the error). Cleared when the replay ends.
 *
 * @type {WeakMap<OfflinePlugin, Map<string, "delivered"|"refused">>}
 */
const keptRewrittenCreates = new WeakMap();

/**
 * @param {OfflinePlugin} plugin
 * @param {string} key
 * @param {"delivered"|"refused"} outcome
 */
function keepRewrittenCreate(plugin, key, outcome) {
    let kept = keptRewrittenCreates.get(plugin);
    if (!kept) {
        kept = new Map();
        keptRewrittenCreates.set(plugin, kept);
    }
    kept.set(key, outcome);
}

/**
 * Consumes the mark `keepRewrittenCreate` set on `key` for `outcome`.
 *
 * @param {OfflinePlugin} plugin
 * @param {string} key
 * @param {"delivered"|"refused"} outcome
 * @returns {boolean} whether `key` was marked so
 */
function takeRewrittenCreate(plugin, key, outcome) {
    const kept = keptRewrittenCreates.get(plugin);
    if (kept?.get(key) !== outcome) {
        return false;
    }
    kept.delete(key);
    return true;
}

/**
 * Whether the queue of `plugin` holds a pending (not parked) call of
 * `CRM_REPLAY_MODELS`.
 *
 * @param {OfflinePlugin} plugin
 * @returns {boolean}
 */
function hasPendingCrmCall(plugin) {
    return Object.values(plugin._ormToSync()).some(
        (entry) => CRM_REPLAY_MODELS.has(entry.value?.model) && !isParked(entry)
    );
}

/**
 * Resolved once no replay of `plugin` runs (`syncingORM` unset), at once when none
 * does. The replay runs inside a lock request, whose promise may resolve before the
 * replay has finished (a lock manager that grants the lock without awaiting its
 * holder), so the end of a replay is read from the plugin's own replay state rather
 * than from that promise.
 *
 * @param {OfflinePlugin} plugin
 * @returns {Promise<void>}
 */
function crmReplayEnded(plugin) {
    if (!untrack(() => plugin.syncingORM())) {
        return Promise.resolve();
    }
    let stop;
    const ended = new Promise((resolve) => {
        // Created outside any computation, so that only `stop` disposes of it.
        stop = untrack(() =>
            effect(() => {
                if (!plugin.syncingORM()) {
                    resolve();
                }
            })
        );
    });
    return ended.then(() => stop());
}

/**
 * Makes the framework replay of `plugin` send its calls through `crmReplayCall`,
 * once per plugin instance. The replay reads `plugin.orm.silent` for each call; the
 * replacement ORM inherits everything else from the plugin's own. A call is sent
 * through the ORM it is made on, so an ORM derived from the replacement keeps its
 * settings: the cache options of `plugin.orm.silent.cache(...)`, through which the
 * CRM lead form refreshes its cached reads after a replay, still write the cache.
 *
 * @param {OfflinePlugin} plugin
 */
function installCrmReplay(plugin) {
    if (crmReplayPlugins.has(plugin)) {
        return;
    }
    crmReplayPlugins.add(plugin);
    const orm = plugin.orm;
    plugin.orm = Object.create(orm, {
        silent: {
            get() {
                const silentOrm = orm.silent;
                const send = silentOrm.call;
                return Object.assign(Object.create(silentOrm), {
                    call(model, method, args, kwargs) {
                        // `this`: this ORM, or one derived from it (`cache()`).
                        const callOrm = Object.create(this, { call: { value: send } });
                        return crmReplayCall(plugin, callOrm, model, method, args, kwargs);
                    },
                });
            },
        },
    });
}

/**
 * The identity of this web client's session: its user and its database. A queued
 * call of `CRM_REPLAY_MODELS` carries it as `extras.crmOrigin`, so that only a
 * session of that user on that database loads, shows and replays it
 * (`isForeignCrmEntry`).
 *
 * @returns {{uid: number|false, db: string}}
 */
function currentCrmOrigin() {
    return { uid: user.userId, db: session.db };
}

/**
 * Tells whether a queued call of `CRM_REPLAY_MODELS`, read from the offline store,
 * belongs to another identity than this session's. The offline store is shared by
 * every session of the browser, while a call must be shown and replayed only to
 * and by the user who queued it. Its owner is the identity it was queued with
 * (`extras.crmOrigin`: user and database); a call queued without one is owned by
 * the user its call context names (`kwargs.context.uid`, which the web client
 * sends with every call). A call naming neither cannot be attributed and is kept,
 * as the framework keeps every call. A session without a user owns no attributed
 * call. Calls of every other model are the framework's, and never foreign here.
 *
 * @param {{model?: string, kwargs?: Object, extras?: Object}} value a stored queue
 *  entry's value
 * @returns {boolean}
 */
function isForeignCrmEntry(value) {
    if (!CRM_REPLAY_MODELS.has(value?.model)) {
        return false;
    }
    const { uid, db } = currentCrmOrigin();
    const origin = value.extras?.crmOrigin;
    if (isFieldMapping(origin)) {
        return !uid || origin.uid !== uid || (origin.db ?? null) !== (db ?? null);
    }
    const contextUid = value.kwargs?.context?.uid;
    if (Number.isInteger(contextUid)) {
        return !uid || contextUid !== uid;
    }
    return false;
}

patch(OfflinePlugin.prototype, {
    /**
     * Queues a call as the framework does. A call of `CRM_REPLAY_MODELS` also
     * carries, in its `extras`, the identity of the session queuing it
     * (`currentCrmOrigin`), unless its extras already name one: the framework
     * parks a refused call by queuing it again under its key with
     * `{...extras, error}`, and it stays its first owner's.
     *
     * Such a call is also sent with the id of the user queuing it in its context
     * (`CRM_OFFLINE_UID_KEY`), unless its context already names one, as the parked
     * call queued again with its stored kwargs does. Pages that do not load this
     * module replay the shared offline store without the filter above, in their
     * own session, and the server refuses a call whose context names another
     * user than the caller. Only queued calls carry the key, and the online lead
     * writes held for their turn in a replay (`crmLeadWriteTurn`): every other
     * online call is sent unchanged.
     *
     * A lead create (`crm.lead` `web_save` without ids) queued without a valid
     * delivery key (`CRM_OFFLINE_CREATE_KEY`) gets one, whoever queues it: the key
     * of the lead create already queued under the same queue key (`options.id`),
     * flagged as a later save of that lead (`CRM_OFFLINE_CREATE_WRITE`), or else a
     * new key. Its replay, sent again whenever its answer is lost, then creates the
     * lead once. A valid key the caller sent is kept as it is, and saves with ids
     * and calls of other models get none. Its model, method and args are queued,
     * and replayed, unchanged; the caller's kwargs and options are not modified.
     *
     * The replay parks a refused call with the values it read when it started. A
     * keyed lead create whose entry was rewritten with a lead form's later values
     * meanwhile (`crmReplayCall`), and a call rewritten before its turn came
     * (`rewriteCrmQueuedCall`: the replay parks it with the arguments it held before),
     * are parked with the values their entry holds instead, so that retrying them from
     * the offline systray sends the user's last values.
     *
     * @param {string} model
     * @param {string} method
     * @param {any[]} args
     * @param {Object} kwargs
     * @param {{id?: string, extras?: Object}} options
     * @returns {string} the queue key
     */
    scheduleORM(model, method, args, kwargs, options) {
        const parksRewritten =
            Boolean(options?.extras?.error) &&
            (takeRewrittenCreate(this, options.id, "refused") ||
                crmRewrittenReplayArgs.get(toRaw(this))?.get(toRaw(args)) === options.id);
        if (parksRewritten) {
            const stored = untrack(() => this._ormToSync()[options.id]);
            if (stored) {
                ({ model, method, args, kwargs } = stored.value);
                const { error } = options.extras;
                options = { ...options, extras: { ...stored.value.extras, error } };
            }
        }
        if (CRM_REPLAY_MODELS.has(model)) {
            if (options && !options.extras?.crmOrigin) {
                options = {
                    ...options,
                    extras: { ...options.extras, crmOrigin: currentCrmOrigin() },
                };
            }
            if (!(kwargs?.context && CRM_OFFLINE_UID_KEY in kwargs.context)) {
                kwargs = {
                    ...kwargs,
                    context: { ...kwargs?.context, [CRM_OFFLINE_UID_KEY]: user.userId },
                };
            }
            if (
                isCrmLeadCreate(model, method, args) &&
                !isCrmOfflineCreateKey(kwargs.context[CRM_OFFLINE_CREATE_KEY])
            ) {
                kwargs = {
                    ...kwargs,
                    context: {
                        ...kwargs.context,
                        ...queuedLeadCreateKeyContext(this, options?.id),
                    },
                };
            }
        }
        return super.scheduleORM(model, method, args, kwargs, options);
    },

    /**
     * Loads the queue from the offline store as the framework does, without the
     * calls of another identity (`isForeignCrmEntry`). The store is shared by every
     * session of the browser, so a user's pending CRM calls would otherwise be
     * shown to, and replayed as, the next user signing in on it. Left out of the
     * queue, they are not projected (pipeline, cards, lead form, activity sheet),
     * listed in the systray, replayed nor discarded: they stay in the store,
     * unchanged, until a session of their own user loads them. This only keeps
     * them out of another user's web client; it does not protect the store itself.
     *
     * The framework sets the queue from the whole store. Setting it so, then
     * removing the foreign calls, would show them to the queue's immediate effects
     * in between (the replay hold would take them for replayed calls and project
     * them), so the store is read here and the queue set once, already filtered.
     *
     * Every other call is loaded exactly as stored, a parked one with its error.
     * A call the server refused because it was sent in another user's session (a
     * page without this module replayed it there) stays parked like any refused
     * call: the replay skips it, and the systray shows the server's error, where
     * its user discards it, or reopens an edit to save it again.
     */
    async _updateScheduledORMList() {
        const table = await this._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME);
        const entries = table.map((v) => ({ key: v.key, value: JSON.parse(v.value) }));
        this._ormToSync.set(
            Object.fromEntries(
                entries
                    .filter(({ value }) => !isForeignCrmEntry(value))
                    .map((entry) => [entry.key, entry])
            )
        );
    },

    /**
     * Removes a call from the queue as the framework does, except a keyed lead
     * create the running replay delivered with older values than its entry now
     * holds (`crmReplayCall`): that entry stays queued and stored, and the next
     * replay sends it.
     *
     * @param {string} key
     */
    removeScheduledORM(key) {
        if (takeRewrittenCreate(this, key, "delivered")) {
            return;
        }
        return super.removeScheduledORM(...arguments);
    },

    /**
     * Replays the queue with the CRM delivery guarantees of `crmReplayCall`.
     *
     * The replay sends the calls it read when it started. A CRM call queued after
     * that (a write released "queue only" during the replay, `crmLeadWriteTurn`), or
     * kept by it (`crmReplayCall`), is therefore not sent by it, and no other replay
     * starts while the connection stays up. So when the replay ends online with such
     * a call pending (not parked) and no other replay running, the next one starts
     * at once. This ends: each replay removes or parks every call it sends, and stops
     * with the connection lost. The replay has ended once the plugin no longer
     * reports one running (`crmReplayEnded`).
     */
    async _syncORM() {
        installCrmReplay(this);
        try {
            await super._syncORM(...arguments);
            await crmReplayEnded(this);
        } finally {
            keptRewrittenCreates.delete(this);
        }
        if (
            isCrmOfflineQueueUsable() &&
            !this.isOffline() &&
            !this.syncingORM() &&
            hasPendingCrmCall(this)
        ) {
            crmOwnEffectPromise(this._syncORM());
        }
    },
});

// -----------------------------------------------------------------------------
// Queued lead deletes (replayed after every queued call of the leads they delete)
// -----------------------------------------------------------------------------

/**
 * Time stamp of a `crm.lead` `unlink` of the ids `resIds` (its `args[0]`) about to be
 * queued with the time stamp `timeStamp`: one more than the latest time stamp of the
 * queued calls of any of those leads (pending or parked: every `crm.lead` call whose
 * `args[0]` array targets one of them), when that is not before `timeStamp`; else
 * `timeStamp`. Reads the queue without subscribing the running computation, if any.
 *
 * @param {OfflinePlugin} plugin
 * @param {any} resIds
 * @param {number} timeStamp
 * @returns {number}
 */
function leadUnlinkTimeStamp(plugin, resIds, timeStamp) {
    if (!Array.isArray(resIds) || !resIds.length) {
        return timeStamp;
    }
    const ids = new Set(resIds);
    let leadUnlinkStamp = timeStamp;
    for (const { value } of Object.values(untrack(() => plugin._ormToSync()))) {
        const targets = value?.model === "crm.lead" ? value.args?.[0] : undefined;
        if (Array.isArray(targets) && targets.some((id) => ids.has(id))) {
            leadUnlinkStamp = Math.max(leadUnlinkStamp, (value.extras?.timeStamp || 0) + 1);
        }
    }
    return leadUnlinkStamp;
}

patch(OfflinePlugin.prototype, {
    /**
     * Queues a call as the framework does, except that a new `crm.lead` `unlink` is
     * stamped after every queued call, pending or parked, of each lead it deletes
     * (`leadUnlinkTimeStamp`): a delete from a pipeline card or the kanban selection
     * (offline, its request lost, or held during a replay then queued without being
     * sent), from the lead form or from a lead list. The framework stamps it with the
     * clock, and the replay sends the queue in time-stamp order, while CRM stamps a
     * lead write after the lead's queued calls when the clock has not passed them (a
     * form's follow-up write, Won, a card save, a stage chosen on the phone), and a
     * clock set back leaves earlier writes ahead of it: the delete would then be sent
     * first, and the lead's older calls would fail on the deleted lead and park. The
     * delete is stamped as it is queued, so the queue never holds it at an earlier
     * place, and the replay sends those calls first, whatever time stamps they carry.
     *
     * A call queued again under its key (the replay parking a refused delete) keeps
     * its time stamp, and every other call is queued unchanged: the queue is neither
     * read for conflicts nor otherwise changed. Online, nothing is queued, so nothing
     * changes.
     *
     * @param {string} model
     * @param {string} method
     * @param {any[]} args
     * @param {Object} kwargs
     * @param {{id?: string, extras?: Object}} options
     * @returns {string} the queue key
     */
    scheduleORM(model, method, args, kwargs, options) {
        const extras = options?.extras;
        if (model === "crm.lead" && method === "unlink" && Number.isFinite(extras?.timeStamp)) {
            const key = options.id;
            const requeued =
                key !== undefined && key !== null && key in untrack(() => this._ormToSync());
            const timeStamp = requeued
                ? extras.timeStamp
                : leadUnlinkTimeStamp(this, args?.[0], extras.timeStamp);
            if (timeStamp !== extras.timeStamp) {
                options = { ...options, extras: { ...extras, timeStamp } };
            }
        }
        return super.scheduleORM(model, method, args, kwargs, options);
    },
});

// -----------------------------------------------------------------------------
// Keyboard focus of the mobile pipeline and its bottom sheets
// -----------------------------------------------------------------------------

/**
 * Focuses the first candidate that takes the focus: one in the document, not
 * disabled, not inert, and displayed (a hidden element refuses the focus).
 *
 * @param {Iterable<HTMLElement|null|undefined>} candidates
 * @returns {boolean} whether one of them was focused
 */
export function crmFocusFirst(candidates) {
    for (const el of candidates) {
        if (!el?.isConnected || el.matches(":disabled") || el.closest("[inert]")) {
            continue;
        }
        el.focus();
        if (document.activeElement === el) {
            return true;
        }
    }
    return false;
}

/**
 * Gives the focus back from a closing bottom sheet (the `onClose` of its opener)
 * to the first usable candidate, typically the control that opened it. The focus
 * is taken only from a bottom sheet or from the body it falls back to: focus the
 * user moved elsewhere is left alone.
 *
 * @param {Iterable<HTMLElement|null|undefined>} candidates
 * @returns {boolean} whether one of them was focused
 */
export function crmReturnFocusFromSheet(candidates) {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest(".o_bottom_sheet")) {
        return false;
    }
    return crmFocusFirst(candidates);
}

/**
 * Keyboard focus of a mobile bottom sheet's content (`rootRef`, given
 * `tabindex="-1"` so a pointer inside it keeps the focus in the sheet):
 * - once mounted, the sheet's heading (`headingRef`, `tabindex="-1"`) takes the
 *   focus. It is focused before the sheet becomes the UI active element, whose
 *   activation would otherwise focus the first control, which can be an input
 *   raising the phone keyboard over the sheet's slide-in;
 * - the sheet is the UI active element while it is open: Tab and Shift+Tab cycle
 *   through its controls, and hotkeys of the page behind it are not dispatched;
 * - from the sheet itself or its heading, which precede every control, Tab
 *   reaches the first control and Shift+Tab wraps to the last one (the active
 *   element only wraps from the first and the last controls).
 *
 * Returning the focus on close is the opener's (`crmReturnFocusFromSheet`).
 *
 * @param {() => HTMLElement|null} rootRef
 * @param {() => HTMLElement|null} headingRef
 */
export function useCrmSheetFocus(rootRef, headingRef) {
    const focusHeading = () => headingRef()?.focus({ preventScroll: true });
    const onKeydown = (ev) => {
        const hotkey = getActiveHotkey(ev);
        if (hotkey !== "tab" && hotkey !== "shift+tab") {
            return;
        }
        const tabables = getTabableElements(ev.currentTarget);
        if (!tabables.length || tabables.includes(document.activeElement)) {
            return;
        }
        ev.preventDefault();
        (hotkey === "tab" ? tabables[0] : tabables.at(-1)).focus();
    };
    let listenedEl = null;
    onMounted(() => {
        focusHeading();
        listenedEl = rootRef();
        listenedEl?.addEventListener("keydown", onKeydown);
    });
    onWillUnmount(() => listenedEl?.removeEventListener("keydown", onKeydown));
    useActiveElement(rootRef);
    // A sheet without any enabled control: its activation focused the sheet itself.
    onMounted(() => {
        if (document.activeElement === rootRef()) {
            focusHeading();
        }
    });
}

/**
 * Focus kept as `useCrmFocusKeeper` found it before a patch.
 *
 * @typedef {{el: HTMLElement, info: Object}} CrmLostFocus
 */

/**
 * Keeps the keyboard focus on a usable control of a mobile component when one of
 * its own patches disables or removes the focused control (which leaves the focus
 * on the body). Only focus that was inside `rootRef` before the patch is kept, so
 * the focus is never taken from elsewhere.
 *
 * - `describe(el, root)` runs before the patch for the focused element, and returns
 *   what `candidates` needs to know about it, or `null` to keep nothing;
 * - `candidates({el, info}, root)` runs after a patch that lost the focus, and
 *   returns the elements to focus, in order of preference. The lost element comes
 *   first anyway: re-enabled, it takes the focus back.
 *
 * A focused control left disabled and `aria-busy="true"` (a running request) is
 * waited for. Meanwhile the focus is parked on `park(lost, root)`, an element of
 * the root taking the focus (such as a heading with `tabindex="-1"`), so that it
 * never sits on the body, from which Tab would leave the component (a bottom
 * sheet's Tab trap only sees keys pressed inside it). The first patch where the
 * control is no longer busy resolves the wait, as above, but only while the focus
 * is still on the park element (or on the body, without one): focus the user
 * moved elsewhere meanwhile is never taken back.
 *
 * @param {() => HTMLElement|null} rootRef
 * @param {{
 *  describe?: (el: HTMLElement, root: HTMLElement) => Object|null,
 *  candidates: (lost: CrmLostFocus, root: HTMLElement) => Array<HTMLElement|null|undefined>,
 *  park?: (lost: CrmLostFocus, root: HTMLElement) => HTMLElement|null|undefined,
 * }} params
 */
export function useCrmFocusKeeper(rootRef, { describe = () => ({}), candidates, park }) {
    /** @type {CrmLostFocus|null} focus inside the root before the running patch */
    let focused = null;
    /**
     * Busy control that lost the focus at a previous patch, and the element the
     * focus was parked on meanwhile (`null` when none could take it).
     *
     * @type {(CrmLostFocus & {park: HTMLElement|null})|null}
     */
    let waiting = null;
    function stopWaiting() {
        waiting?.park?.removeEventListener("blur", onParkBlur);
        waiting = null;
    }
    // The focus moved from the park element to another one: the user moved it, so
    // the wait is dropped. A blur without a new target (the window losing the
    // focus, the element leaving the page) keeps it.
    function onParkBlur(ev) {
        if (ev.relatedTarget) {
            stopWaiting();
        }
    }
    /**
     * Waits for a busy control, with the focus parked on `parkedOn` when it is
     * there already, else on the park element, which takes it without scrolling
     * (the sheet's heading of a long list stays out of sight).
     *
     * @param {CrmLostFocus} lost
     * @param {HTMLElement|null} root
     * @param {HTMLElement|null} parkedOn
     */
    const wait = (lost, root, parkedOn) => {
        let parkEl = parkedOn;
        if (!parkEl && park && root) {
            const el = park(lost, root);
            if (el?.isConnected && root.contains(el) && !el.closest("[inert]")) {
                el.focus({ preventScroll: true });
                parkEl = document.activeElement === el ? el : null;
            }
        }
        waiting = { el: lost.el, info: lost.info, park: parkEl };
        parkEl?.addEventListener("blur", onParkBlur);
    };
    const isOnBody = (active) => !active || active === document.body;
    onWillPatch(() => {
        focused = null;
        const root = rootRef();
        const active = document.activeElement;
        if (waiting) {
            if (isOnBody(active) || active === waiting.park || active === waiting.el) {
                // The focus has not moved since the control lost it: the wait
                // carries over this patch, and the park element holding the focus
                // is never taken for a control that lost it.
                return;
            }
            stopWaiting();
        }
        if (root && !isOnBody(active) && root.contains(active)) {
            const info = describe(active, root);
            if (info) {
                focused = { el: active, info };
            }
        }
    });
    onPatched(() => {
        const active = document.activeElement;
        let lost = focused;
        focused = null;
        /** @type {HTMLElement|null} park element that still has the focus */
        let parkedOn = null;
        if (waiting) {
            const pending = waiting;
            stopWaiting();
            if (!lost && (isOnBody(active) || active === pending.park || active === pending.el)) {
                lost = pending;
                parkedOn = pending.park && active === pending.park ? pending.park : null;
            }
        }
        const isLost =
            lost &&
            (isOnBody(active) ||
                Boolean(parkedOn) ||
                (active === lost.el && (!active.isConnected || active.matches(":disabled"))));
        if (!isLost) {
            return;
        }
        const root = rootRef();
        if (lost.el.isConnected && lost.el.getAttribute("aria-busy") === "true") {
            wait(lost, root, parkedOn);
            return;
        }
        if (root) {
            crmFocusFirst([lost.el, ...candidates(lost, root)]);
        }
    });
    onWillUnmount(stopWaiting);
}

// -----------------------------------------------------------------------------
// useCrmOffline
// -----------------------------------------------------------------------------

/**
 * Setup-only access to CRM's framework offline state and queue; reads remain live
 * and participate in render/effect tracking.
 */
export function useCrmOffline() {
    const plugin = usePlugin(OfflinePlugin);
    const ui = useService("ui");
    const orm = useService("orm");
    const env = useEnv();
    // Capturing starts with the first CRM component of the session (`getReplayHold`).
    const hold = getReplayHold(plugin);

    const isOffline = () => plugin.isOffline();

    /**
     * Queued entries of a model, in queue order: a new array on each call.
     *
     * @param {string} model
     */
    const queuedEntries = (model) => [...(readQueueIndex(plugin).byModel.get(model) || [])];

    /**
     * A `Record.offlineId` survives the replay of its entry, so a key is pending
     * only while it is still in the queue.
     *
     * @param {string} [key]
     */
    const isQueued = (key) => key !== undefined && key !== null && key in plugin._ormToSync();

    /** Queued lead writes of `record` (`leadWritesIn`), in replay order. */
    const leadWrites = (record) => (record ? leadWritesIn(readQueueIndex(plugin), record) : []);

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

    /**
     * Every lead stage of the framework relational-field cache, read without a
     * request (online and offline), in the cache's (id) order; `[]` when none is
     * cached, as outside a secure context, where the framework caches nothing, and
     * when the cache holds a stage this session cannot decrypt
     * (`readDecryptableCache`). An entry without a name (removed while it was read)
     * is left out.
     *
     * @returns {Promise<{id: number, display_name: string}[]>}
     */
    const getCachedStages = async () => {
        // Not `searchMany2XRecords`: that autocomplete search returns its first page only.
        const keys =
            (await plugin._idb.getAllKeys(OfflinePlugin.MANY2X_TABLE_PREFIX + "crm.stage")) || [];
        if (!keys.length) {
            return [];
        }
        const stages =
            (await readDecryptableCache(plugin.readMany2XRecords("crm.stage", keys))) || [];
        return stages.filter((stage) => stage.display_name);
    };

    /**
     * Stores stage choices the server listed (`loadStageChoices`, or a root reload
     * that asked for them, `CRM_STAGE_CHOICES_KEY`) in the framework
     * relational-field cache, where `getCachedStages()` reads them offline.
     *
     * @param {{id: number, display_name: string}[]} stages
     * @returns {Promise<void>}
     */
    const cacheStageChoices = (stages) => plugin.cacheMany2XSearch("crm.stage", stages);

    return {
        isOffline,

        /**
         * Offline where the framework queue cannot hold a call (a non-secure
         * origin, `isCrmOfflineQueueUsable`): a control whose offline action queues
         * one then drops `data-available-offline`, so the framework disables it with
         * its `o_disabled_offline` state and re-enables it online. Always `false`
         * online and in a secure context, where those controls are unchanged.
         */
        isOfflineQueueBlocked() {
            return isCrmOfflineQueueBlocked(plugin);
        },

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
         * ignored: the values it would display are left as they were. The writes the
         * replay has just sent stay applied until the view reloads (`holdReplayed`).
         * An online write of the record made during the replay (`crmTurnWrite`)
         * applies the record's values of the fields it writes at its time stamp,
         * after the writes stamped up to it (on a tie, it was made last), which are
         * all those of the lead queued or replayed when it was made, even stamped
         * past the clock (`crmTurnWriteTimeStamp`): the card shows it at once, while
         * it waits for its turn, and until the view reloads.
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
            let writes = leadWrites(record);
            const heldWrites = leadWritesIn(readHeldIndex(plugin), record);
            if (heldWrites.length) {
                // Stable: on a time-stamp tie the replayed write applies first.
                writes = [...heldWrites, ...writes].sort(byTimeStamp);
            }
            /** @type {CrmTurnWrite|undefined} */
            let turnWrite = record.crmTurnWrite;
            const applyTurnWrite = () => {
                for (const fieldName of turnWrite.fieldNames) {
                    if (fieldName in values) {
                        values[fieldName] = record.data[fieldName];
                    }
                }
                turnWrite = undefined;
            };
            for (const entry of writes) {
                const { method, extras } = entry.value;
                if (turnWrite && (extras?.timeStamp || 0) > turnWrite.timeStamp) {
                    applyTurnWrite();
                }
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
                    return null;
                }
            }
            if (turnWrite) {
                applyTurnWrite();
            }
            return values;
        },

        /**
         * Leads created offline (queued `web_save` without id) in a stage, in
         * replay order, as provisional card data. Entries that are not creations
         * (target ids other than an empty array, values not a mapping) are ignored.
         * A creation the replay has just sent stays listed, never parked, until the
         * view reloads and shows the created lead (`holdReplayed`).
         *
         * @param {number|false} stageId
         */
        pendingCreates(stageId) {
            const entries = withHeld(
                readQueueIndex(plugin).leadCreatesByStage.get(stageId),
                readHeldIndex(plugin).leadCreatesByStage.get(stageId)
            );
            return entries.map(provisionalLead);
        },

        /**
         * Leads created offline (as `pendingCreates`) in a stage that none of
         * `stageIds` is, in replay order, as provisional card data: e.g. a creation
         * in a stage deleted on the server since it was queued, which its replay
         * parks. The caller shows them where it shows its own stages' creations, so
         * that every creation the queue holds keeps a card.
         *
         * @param {Set<number|false>} stageIds the stages the caller displays
         */
        pendingCreatesOutside(stageIds) {
            const queued = readQueueIndex(plugin).leadCreatesByStage;
            const held = readHeldIndex(plugin).leadCreatesByStage;
            const entries = [];
            for (const stageId of new Set([...queued.keys(), ...held.keys()])) {
                if (!stageIds.has(stageId)) {
                    entries.push(...withHeld(queued.get(stageId), held.get(stageId)));
                }
            }
            // Stable: entries of one time stamp keep their stage's replay order.
            return entries.sort(byTimeStamp).map(provisionalLead);
        },

        /**
         * Activities scheduled offline on a lead, in replay order. `activity_type_id`
         * and `user_id` are ids, `date_deadline` a "YYYY-MM-DD" string. An activity
         * the replay has just created stays listed, never parked, until the opener
         * reloads the lead with it (`holdReplayed`).
         *
         * @param {number} leadId
         */
        pendingActivities(leadId) {
            const entries = withHeld(
                readQueueIndex(plugin).activityCreatesByLead.get(leadId),
                readHeldIndex(plugin).activityCreatesByLead.get(leadId)
            );
            return entries.map((entry) => {
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
         * Whether "mark done" of this activity waits in the queue, or was just
         * replayed and the opener has not reloaded the lead without it yet
         * (`holdReplayed`).
         *
         * @param {number} activityId
         */
        isActivityDonePending(activityId) {
            const queued = readQueueIndex(plugin).doneActivityIds;
            const held = readHeldIndex(plugin).doneActivityIds;
            return Boolean(activityId) && (queued.has(activityId) || held.has(activityId));
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
         * Activity page size the mobile root loads of `scope` request in this
         * session: the one "Show more" raised it to, `CRM_MOBILE_ACTIVITY_LIMIT`
         * otherwise. A `scope` names root loads whose requests differ only by that
         * page size, e.g. a pipeline action and search, or a lead form.
         *
         * @param {string} scope
         * @returns {number}
         */
        getActivityLimit(scope) {
            return activityLimits.get(plugin)?.get(scope) ?? CRM_MOBILE_ACTIVITY_LIMIT;
        },

        /**
         * Sets the activity page size of `scope` for this session. A limit that is
         * not an integer above `CRM_MOBILE_ACTIVITY_LIMIT` forgets the scope.
         *
         * @param {string} scope
         * @param {number} limit
         */
        setActivityLimit(scope, limit) {
            let limits = activityLimits.get(plugin);
            if (!Number.isInteger(limit) || limit <= CRM_MOBILE_ACTIVITY_LIMIT) {
                limits?.delete(scope);
                return;
            }
            if (!limits) {
                limits = new Map();
                activityLimits.set(plugin, limits);
            }
            limits.set(scope, limit);
        },

        /**
         * Online only: caches the lead activity types in the framework
         * relational-field cache so the activity sheet works offline, remembers
         * their ids in the server's order for this session, then bumps
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
                const records = await readLeadActivityTypes(orm);
                await plugin.cacheMany2XSearch("mail.activity.type", records);
                warmedActivityTypeIds.set(
                    plugin,
                    records.map(({ id }) => id)
                );
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

        /**
         * Activity types the sheet offers, first one first:
         * - once this session's warm-up succeeded: the cached types it read, in
         *   its order (`sequence, id`), so a cached type it left out (archived, or
         *   set up for another model) is not offered;
         * - before that: every cached type, in the cache's (id) order;
         * - without relational-field cache (a non-secure context, or no cache
         *   secret in the session), or when the cached types include one this
         *   session cannot decrypt (`readDecryptableCache`): online, the types read
         *   from the server as the warm-up reads them, `[]` when that read fails;
         *   offline, `[]`.
         * Online with a readable cache, and offline, no RPC is issued.
         *
         * @returns {Promise<{id: number, display_name: string}[]>}
         */
        async getActivityTypes() {
            const cached = await readDecryptableCache(
                plugin.searchMany2XRecords("mail.activity.type", "")
            );
            if (cached === undefined) {
                if (isOffline()) {
                    return [];
                }
                try {
                    const records = await readLeadActivityTypes(orm);
                    return records.map(({ id, display_name }) => ({ id, display_name }));
                } catch {
                    return [];
                }
            }
            const warmedIds = warmedActivityTypeIds.get(plugin);
            if (!warmedIds) {
                return cached;
            }
            const typesById = new Map(cached.map((type) => [type.id, type]));
            // The cache search returns a bounded number of rows: the warmed types it
            // did not return are read by id; an id absent from the cache, or read with
            // a row this session cannot decrypt, has no label.
            const missingIds = warmedIds.filter((id) => !typesById.has(id));
            if (missingIds.length) {
                const read = await readDecryptableCache(
                    plugin.readMany2XRecords("mail.activity.type", missingIds)
                );
                for (const type of read || []) {
                    if (type.display_name !== undefined) {
                        typesById.set(type.id, type);
                    }
                }
            }
            return warmedIds.filter((id) => typesById.has(id)).map((id) => typesById.get(id));
        },

        getCachedStages,

        /**
         * Stage choices of an ungrouped lead list: the stages the same list shows
         * when grouped by stage. Online they are the server's stage groups of the
         * list's domain and context with group expansion (the sales team's stages
         * and those of the list's leads, in stage order), stored in the framework
         * relational-field cache. Offline no request is made: every cached stage
         * (`getCachedStages()`, in id order, read without a request) is returned
         * with `cached` set, as when the connection drops during the read. Other
         * errors propagate.
         *
         * @param {Object} list the ungrouped root list
         * @returns {Promise<{stages: {id: number, display_name: string}[], cached: boolean}>}
         */
        async loadStageChoices(list) {
            if (!isOffline()) {
                try {
                    const groups = await orm.formattedReadGroup(
                        "crm.lead",
                        list.domain,
                        ["stage_id"],
                        [],
                        { context: { ...list.context, read_group_expand: true } }
                    );
                    const stages = groups
                        .filter((group) => group.stage_id)
                        .map(({ stage_id: [id, display_name] }) => ({ id, display_name }));
                    await cacheStageChoices(stages);
                    return { stages, cached: false };
                } catch (error) {
                    if (!(error instanceof ConnectionLostError)) {
                        throw error;
                    }
                }
            }
            return { stages: await getCachedStages(), cached: true };
        },

        cacheStageChoices,

        /**
         * The session user first, then the cached users, each once; the session user
         * alone without cache, or when the cached users include one this session
         * cannot decrypt (`readDecryptableCache`).
         *
         * @returns {Promise<{id: number, display_name: string}[]>}
         */
        async getAssignees() {
            const cached =
                (await readDecryptableCache(plugin.searchMany2XRecords("res.users", ""))) || [];
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
         * during the call): the framework queue key. With `queueOnly` (a write whose
         * turn in the replay ended without its writes ahead being sent,
         * `crmLeadWriteTurn`), the call is queued without being sent, whatever the
         * connection state, and the replay is asked to deliver it
         * (`crmReplayQueued`): the queue key.
         *
         * @param {string} model
         * @param {string} method
         * @param {any[]} args
         * @param {Object} kwargs
         * @param {Object} extras
         * @param {{queueOnly?: boolean}} [options]
         */
        async schedule(model, method, args, kwargs, extras, { queueOnly = false } = {}) {
            if (queueOnly) {
                const key = queue(model, method, args, kwargs, extras);
                crmReplayQueued(plugin);
                return key;
            }
            return (await run(model, method, args, kwargs, extras)).result;
        },

        /**
         * Schedules an activity on a lead. The user context is used (not the
         * action context) so no `default_*` key of the lead action becomes a
         * `mail.activity` default; `res_model_id` is resolved server-side. Online,
         * only a server error of the create rejects; once the activity is created,
         * the lead reload does not (`reloadRecord`).
         *
         * The context also carries a new delivery key (`CRM_OFFLINE_CREATE_KEY`),
         * one per scheduled activity. An offline create is queued with it; an
         * online create whose connection drops is queued as the very call it sent,
         * key included. A create whose answer was lost may have created the
         * activity, and its replay (sent again after another lost answer, from any
         * tab) is then answered with that activity rather than creating it twice.
         *
         * @param {Object} record the lead
         * @param {{activity_type_id: number, summary: string|false, date_deadline: string, user_id: number}} vals
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
                { context: { ...user.context, [CRM_OFFLINE_CREATE_KEY]: newCrmOfflineCreateKey() } },
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
         * Create with `list.context` plus a new delivery key (`CRM_OFFLINE_CREATE_KEY`).
         * Offline or connection-loss saves return a queue key and use `extras.changes`
         * for provisional display. The queued create is the call the online save sent,
         * key included (queued with its user, `CRM_OFFLINE_UID_KEY`, as every CRM call
         * is): a save whose answer was lost may have created the lead, and
         * its replay (any tab, after a reload) is then answered with that lead rather
         * than creating it twice. Every delivery is that same create, so none carries
         * the later-save flag (`CRM_OFFLINE_CREATE_WRITE`): a repeated one writes
         * nothing, and a save of the lead made since by its id keeps its values.
         * Online save errors propagate; committed writes resolve even when refresh
         * fails, with errors reported through `crmReportError`.
         *
         * @param {Object} list the pipeline root list
         * @param {Object} vals server values (`stage_id` is an id)
         * @param {Object} extras
         */
        async createLead(list, vals, extras) {
            const kwargs = {
                context: { ...list.context, [CRM_OFFLINE_CREATE_KEY]: newCrmOfflineCreateKey() },
                specification: {},
            };
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
         * Runs `callback` (untracked) after an online `syncingORM` true-to-false
         * transition, including empty syncs; callers that need a CRM replay must
         * track the relevant entries. Setup only. A promise `callback` returns is
         * owned by the hook (`crmOwnEffectPromise`): a lost connection is ignored,
         * any other error reaches the framework error service.
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
         * Setup only. While this component is mounted, keeps the `crm.lead` and
         * `mail.activity` entries the replay removes from the queue and `accept`
         * takes, so that `projectLead`, `pendingCreates`, `pendingActivities` and
         * `isActivityDonePending` keep showing them (as pending, never parked) until
         * the component shows what the server now holds. They are released by
         * `releaseLoaded` once a root loaded from the server, by a load started
         * after their replay (`markRootLoad`), is shown; when given,
         * `displayedRoot` is followed, and every root it returns releases at once,
         * before any render shows it. Unmounting releases everything.
         *
         * @param {(entry: {key: string, value: Object}) => boolean} accept called
         *  untracked, at the replay, for each replayed entry
         * @param {() => Object} [displayedRoot] the root the component displays,
         *  read reactively
         * @returns {{
         *  holding: () => boolean,
         *  releaseLoaded: (config: Object|undefined) => void,
         *  releaseAll: () => void,
         * }} `holding()` tells whether it holds entries; `releaseLoaded(config)`
         *  releases those replayed before the load of the root `config` started
         *  (nothing for a load `markRootLoad` did not give a token)
         */
        holdReplayed(accept, displayedRoot) {
            /** @type {CrmReplayHolder} */
            const holder = { accept, entries: new Map() };
            const release = (isReleased) => {
                let released = false;
                for (const [key, item] of holder.entries) {
                    if (isReleased(item)) {
                        holder.entries.delete(key);
                        released = true;
                    }
                }
                if (released) {
                    publishHeld(hold);
                }
            };
            const releaseLoaded = (config) => {
                const token = config ? toRaw(config)[REPLAY_TOKEN] : null;
                if (Number.isInteger(token)) {
                    release(({ seq }) => seq <= token);
                }
            };
            onMounted(() => hold.holders.add(holder));
            onWillUnmount(() => {
                hold.holders.delete(holder);
                if (holder.entries.size) {
                    holder.entries.clear();
                    publishHeld(hold);
                }
            });
            if (displayedRoot) {
                // Immediate: the root prop is set before the render that shows it.
                const stop = untrack(() =>
                    immediateEffect(() => {
                        const root = displayedRoot();
                        untrack(() => releaseLoaded(root?.config));
                    })
                );
                onWillDestroy(stop);
            }
            return {
                holding: () => holder.entries.size > 0,
                releaseLoaded,
                releaseAll: () => release(() => true),
            };
        },

        /**
         * Gives a root load about to start (`onWillLoadRoot`) its replay token: the
         * number of the last replay capture when the load reads the server only,
         * i.e. online, after the model's first load, and for a record the one the
         * model already shows (the relational model's own no-cache rule); none
         * otherwise (served from, or first answered by, the cache). The token is
         * stored on `config` (`REPLAY_TOKEN`), which the root keeps.
         *
         * @param {Object} model the relational model loading the root
         * @param {Object} [config] root configuration about to be loaded
         */
        markRootLoad(model, config) {
            if (!config) {
                return;
            }
            untrack(() => {
                const rawModel = model && toRaw(model);
                const fromServer =
                    !plugin.isOffline() &&
                    Boolean(rawModel?.isReady()) &&
                    (!config.isMonoRecord ||
                        (Boolean(config.resId) && rawModel.root?.config.resId === config.resId));
                toRaw(config)[REPLAY_TOKEN] = fromServer ? hold.seq : null;
            });
        },

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
     * extension (`aria-disabled`, `tabindex`), so `<a>` buttons leave the tab order,
     * and `data-available-offline` is dropped: the framework would otherwise
     * re-enable a guarded "Won" on a non-secure origin.
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

    /**
     * While guarded, adds the framework's dimmed offline state (`o_disabled_offline`),
     * `pe-none` and the CRM guard marker `o_crm_offline_guarded`. The framework rule
     * `.o_disabled_offline { pointer-events: auto !important }` cancels `pe-none`;
     * the marker scopes the CRM rule (`crm_mobile_pipeline.scss`) that keeps guarded
     * links out of hit-testing, so hover and clicks pass to the element beneath. A
     * kanban card treats a click passing through such a link as the click on the link
     * (`KanbanRecord.onGlobalClick` patch), so the card does not open either.
     * Unguarded buttons keep the original class list.
     */
    getClassName() {
        const className = super.getClassName(...arguments);
        if (!this.crmOfflineGuarded) {
            return className;
        }
        return [className, "o_disabled_offline pe-none o_crm_offline_guarded"]
            .filter(Boolean)
            .join(" ");
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
 * Text the server's `/web/action/load` reads as an action id, in the forms Python's
 * `int()` accepts: Unicode `White_Space` around an optional sign and `Nd` digits,
 * single `_` between digits allowed (int()'s digit cap and Unicode version aside).
 */
const ACTION_ID_TEXT = /^\p{White_Space}*[+-]?\p{Nd}+(?:_\p{Nd}+)*\p{White_Space}*$/u;

/**
 * Pure: matches the request's form only, never evaluates it.
 *
 * @param {unknown} actionRequest
 * @returns {boolean} whether the request is an action id, as a number or as a
 *  string the server reads as one (identified by the request itself, as given)
 */
function isActionIdRequest(actionRequest) {
    return (
        typeof actionRequest === "number" ||
        (typeof actionRequest === "string" && ACTION_ID_TEXT.test(actionRequest))
    );
}

/** One Unicode decimal digit (`Nd`): the characters `ACTION_ID_TEXT` reads as digits. */
const DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * The value of a Unicode decimal digit. Unicode encodes the `Nd` characters in
 * contiguous runs of ten, ascending from 0 to 9, so a digit's value is its offset in
 * its maximal contiguous `Nd` run, modulo ten.
 *
 * @param {number} codePoint the code point of an `Nd` character
 * @returns {number} 0 to 9
 */
function decimalDigitValue(codePoint) {
    let runStart = codePoint;
    while (runStart > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(runStart - 1))) {
        runStart--;
    }
    return (codePoint - runStart) % 10;
}

/**
 * The action id an id request (`isActionIdRequest`) stands for, as the server's
 * `int()` reads it: a number truncated toward zero, or a string's sign applied to
 * its digits (any Unicode decimal digit), whitespace and underscores dropped. Every
 * form of one id therefore gives the same integer. Pure.
 *
 * @param {unknown} actionRequest
 * @returns {number|null} `null` for a request that is not an id, or whose value is
 *  not a safe integer
 */
function normalizeActionId(actionRequest) {
    if (!isActionIdRequest(actionRequest)) {
        return null;
    }
    let id;
    if (typeof actionRequest === "number") {
        id = Math.trunc(actionRequest);
    } else {
        let digits = "";
        // By code point: some decimal digits lie outside the Basic Multilingual Plane.
        for (const char of actionRequest) {
            if (DECIMAL_DIGIT.test(char)) {
                digits += decimalDigitValue(char.codePointAt(0));
            }
        }
        id = actionRequest.includes("-") ? -Number(digits) : Number(digits);
    }
    return Number.isSafeInteger(id) ? id : null;
}

/**
 * Identifies an action from what the client already holds, with no request:
 * offline, a lookup through the action service's disk-cached `loadAction` would
 * still attempt the network (the RPC cache always does on a RAM miss), so the
 * guards never call it. Reads the CRM actions the web client itself loaded in this
 * session (`knownActions`), then the action stored in the session. An id request
 * matches by its value (`normalizeActionId`), whichever id form loaded the action.
 *
 * @param {Map<number|string, Readonly<{xml_id?: string, res_model?: string}>>} knownActions
 * @param {number|string} actionRef an id (a number or a string the server reads as
 *  one), `xml_id` or path, as requested
 * @returns {Object|null} `null` when unknown
 */
function resolveKnownAction(knownActions, actionRef) {
    const id = normalizeActionId(actionRef);
    const known = knownActions.get(actionRef) ?? (id === null ? null : knownActions.get(id));
    if (known) {
        return known;
    }
    try {
        const stored = JSON.parse(browser.sessionStorage.getItem("current_action") || "{}");
        if (
            [stored.id, stored.path, stored.xml_id].filter(Boolean).includes(actionRef) ||
            (id !== null && normalizeActionId(stored.id) === id)
        ) {
            return stored;
        }
        return null;
    } catch {
        // An unreadable stored action identifies nothing.
        return null;
    }
}

/**
 * Whether an action request names a disabled action, with no request: an `xml_id`
 * of the set, or an action object carrying one (`isDisabledActionRequest`), or an id
 * the client already holds for such an action (`resolveKnownAction`). Reads no
 * signal. `doAction` requests and `type="action"` button names are both loaded by
 * the action service's `_loadAction`, so both are identified here.
 *
 * @param {Map<number|string, Readonly<{xml_id?: string, res_model?: string}>>} knownActions
 * @param {unknown} actionRequest
 * @returns {boolean}
 */
function isKnownDisabledAction(knownActions, actionRequest) {
    return (
        isDisabledActionRequest(actionRequest) ||
        (isActionIdRequest(actionRequest) &&
            CRM_OFFLINE_DISABLED_ACTIONS.has(
                resolveKnownAction(knownActions, actionRequest)?.xml_id
            ))
    );
}

/**
 * Whether a URL state opens a disabled action or a blocked CRM view type, from
 * the actions the client already holds (`resolveKnownAction`).
 *
 * @param {Map<number|string, Readonly<{xml_id?: string, res_model?: string}>>} knownActions
 * @param {Object} [state]
 * @returns {boolean}
 */
function isBlockedRouterState(knownActions, state) {
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
        const action = resolveKnownAction(knownActions, actionRef);
        if (CRM_OFFLINE_DISABLED_ACTIONS.has(action?.xml_id)) {
            return true;
        }
        resModel = resModel || action?.res_model;
    }
    return isBlockedViewType(resModel, state.view_type);
}

/**
 * Whether a `doActionButton` request is a `type="action"` button opening a disabled
 * action (`isKnownDisabledAction` of its `name`), whatever the button's model: the
 * action service loads that `name` itself, past the `doAction` guard.
 *
 * @param {Map<number|string, Readonly<{xml_id?: string, res_model?: string}>>} knownActions
 * @param {{type?: string, name?: unknown}} params
 * @returns {boolean}
 */
function isDisabledActionButton(knownActions, params) {
    return params.type === "action" && isKnownDisabledAction(knownActions, params.name);
}

/** Context keys a `mail.activity` button call names its activity's record model by. */
const ACTIVITY_RECORD_MODEL_KEYS = Object.freeze([
    "active_model",
    "default_res_model",
    "res_model",
]);

/**
 * Whether a `doActionButton` request runs `mail.activity.action_create_calendar_event`
 * (overridden by CRM) for a lead's activity, identified with no request: a
 * `crm.lead` model in the call's own context, the mail store's copy of a targeted
 * activity, or the lead view the action service displays (a dialog opened from a
 * lead keeps that view current). Reads no signal; the mail store is optional.
 *
 * @param {Object} api the action manager returned by `actionService.start`
 * @param {Object} env the action service's env
 * @param {{type?: string, resModel?: string, name?: unknown, resId?: number, resIds?: number[], context?: Object, buttonContext?: Object}} params
 * @returns {boolean}
 */
function isCrmLeadActivityCalendarCall(api, env, params) {
    if (
        params.type !== "object" ||
        params.resModel !== "mail.activity" ||
        params.name !== "action_create_calendar_event"
    ) {
        return false;
    }
    const contexts = [params.context, params.buttonContext];
    if (
        contexts.some((context) =>
            ACTIVITY_RECORD_MODEL_KEYS.some((key) => context?.[key] === "crm.lead")
        )
    ) {
        return true;
    }
    const activities = env.services["mail.store"]?.["mail.activity"];
    const activityIds = [params.resId, ...(Array.isArray(params.resIds) ? params.resIds : [])];
    if (activityIds.some((id) => id && activities?.get(id)?.res_model === "crm.lead")) {
        return true;
    }
    const controller = api.currentController;
    return (
        controller?.props?.resModel === "crm.lead" || controller?.action?.res_model === "crm.lead"
    );
}

/**
 * Wraps the action manager's public entry points in place. The object is
 * mutated, never copied: it exposes `currentController`/`currentAction` getters,
 * and its internal calls go through closures, which the view-mount guard below
 * covers. Online each wrapper returns the original's own promise.
 *
 * Offline, actions requested by id or by URL state are identified only from data
 * the client already holds, so the guards issue no request: the descriptors of
 * the CRM actions found in the web client's own `/web/action/load` responses, and
 * the action stored in the session. This index answers the guards' predicates,
 * never a load. A request it cannot identify goes to the original, whose load
 * fails like that of any uncached action, or is answered from the disk cache (an
 * action loaded in an earlier page session); the view-mount guard still stops any
 * CRM target and any view of a disabled action.
 *
 * @param {Object} api the action manager returned by `actionService.start`
 * @param {OfflinePlugin} offlinePlugin
 * @param {Object} env the action service's env
 */
function guardActionManager(api, offlinePlugin, env) {
    const { doAction, doActionButton, switchView, loadState } = api;

    /** Keyed by every reference a loaded CRM action answers to; other actions are never kept. */
    const knownActions = new Map();
    /** Payloads of the pending `/web/action/load` requests (their responses carry no URL). */
    const actionLoads = new WeakSet();
    useListener(rpcBus, "RPC:REQUEST", ({ detail }) => {
        if (detail.url === "/web/action/load") {
            actionLoads.add(detail.data);
        }
    });
    useListener(rpcBus, "RPC:RESPONSE", ({ detail }) => {
        const { data, result } = detail;
        if (!actionLoads.delete(data) || !result || typeof result !== "object") {
            return;
        }
        const isCrmAction =
            CRM_OFFLINE_DISABLED_ACTIONS.has(result.xml_id) ||
            CRM_OFFLINE_BLOCKED_VIEW_MODELS.has(result.res_model);
        const descriptor = isCrmAction
            ? Object.freeze({ xml_id: result.xml_id, res_model: result.res_model })
            : null;
        for (const key of [data.params?.action_id, result.id, result.path, result.xml_id]) {
            if (!key) {
                continue;
            }
            if (descriptor) {
                knownActions.set(key, descriptor);
            } else {
                knownActions.delete(key);
            }
        }
    });

    api.doActionButton = function crmOfflineDoActionButton(...args) {
        const [params] = args;
        // `special` buttons (wizard Cancel/close) never reach the server.
        if (
            params &&
            !params.special &&
            (isCrmOfflineButtonCall(params) ||
                isDisabledActionButton(knownActions, params) ||
                isCrmLeadActivityCalendarCall(api, env, params)) &&
            offlinePlugin.isOffline()
        ) {
            return Promise.resolve();
        }
        return doActionButton.apply(this, args);
    };

    api.doAction = function crmOfflineDoAction(...args) {
        const [actionRequest] = args;
        // An id the client does not hold goes to the original (whose load fails like
        // any other, or opens the view-mount guard's offline helper).
        if (isKnownDisabledAction(knownActions, actionRequest) && offlinePlugin.isOffline()) {
            return Promise.resolve();
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
        if (
            offlinePlugin.isOffline() &&
            isBlockedRouterState(knownActions, args[0] === undefined ? router.current : args[0])
        ) {
            // `false`: the web client opens the menu's or the default app instead.
            return Promise.resolve(false);
        }
        return loadState.apply(this, args);
    };
}

patch(actionService, {
    start(env) {
        // Resolved synchronously: the service scope only exists during `start`.
        const offlinePlugin = usePlugin(OfflinePlugin);
        const api = super.start(...arguments);
        guardActionManager(api, offlinePlugin, env);
        return api;
    },
});

// -----------------------------------------------------------------------------
// Guard: navbar menus (menu service and navbar entries)
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

/**
 * DOM state of the same entries. The framework dims a navbar entry offline from the
 * visited registry, which holds an action once any of its views was visited (a lead
 * form opened from the forecast, a report's list), so it would render the entries
 * the guard above stops as available. Offline, these entries are dimmed and, on
 * desktop, also carry `aria-disabled="true"` (`crmOfflineMenuAttrs`). Online, and for
 * every other entry, the framework's values are kept.
 */
patch(NavBar.prototype, {
    _isAvailable(menu) {
        if (this.offlinePlugin.isOffline() && CRM_OFFLINE_DISABLED_MENUS.has(menu?.xmlid)) {
            return false;
        }
        return super._isAvailable(...arguments);
    },

    /**
     * Read by the `web.NavBar.SectionsMenu`, `web.NavBar.SectionsMenu.Dropdown.MenuSlot`
     * and `web.NavBar.SectionsMenu.MoreDropdown` extensions, which pass the framework's
     * attributes of a desktop navbar entry (a section, a dropdown item or a "More"
     * entry). Offline, an entry of `CRM_OFFLINE_DISABLED_MENUS`, which `_isAvailable`
     * dims and the `selectMenu` guard stops, also gets `aria-disabled="true"`. The
     * signal is read during render, so an open dropdown follows the connection. Online,
     * and for every other menu, the framework's object is returned unchanged.
     *
     * @param {Object} menu a menu of the menu service
     * @param {Object} attrs the framework's `attrs` of the entry's `DropdownItem`
     * @returns {Object}
     */
    crmOfflineMenuAttrs(menu, attrs) {
        if (CRM_OFFLINE_DISABLED_MENUS.has(menu?.xmlid) && this.offlinePlugin.isOffline()) {
            return { ...attrs, "aria-disabled": "true" };
        }
        return attrs;
    },

    /**
     * Read by the `web.SectionMenu` extension: a leaf entry of the CRM app's phone
     * sidebar renders unavailable offline exactly when its desktop dropdown item is
     * dimmed. Other apps' entries are left as the framework renders them.
     *
     * @param {Object} section a menu of the menu service
     * @returns {boolean}
     */
    crmOfflineSectionDisabled(section) {
        return (
            this.offlinePlugin.isOffline() &&
            this.menuService.getMenu(section.appID)?.xmlid === "crm.crm_menu_root" &&
            !this._isAvailable(section)
        );
    },
});

// -----------------------------------------------------------------------------
// Guard: command palette results of the same menus
// -----------------------------------------------------------------------------

/**
 * `disabledMenuCommands` indexes, by the root menu they were computed from.
 *
 * @type {WeakMap<Object, Map<string, { category: string, name: string, xmlid: string }[]>>}
 */
const disabledMenuCommandIndexes = new WeakMap();

/**
 * The commands the palette's menu provider (`menu_providers.js`) lists for the
 * `CRM_OFFLINE_DISABLED_MENUS` menus, by `href`, each with its category (`apps` or
 * `menu_items`), its name (an app's label, a menu item's path and label) and its
 * menu's `xmlid`, all taken from `computeAppsAndMenuItems` as the provider does.
 * Several menus may open the same action, so one `href` can hold several commands.
 *
 * The menu service returns the same root menu until its menus are replaced (a
 * reload, or fetched menus differing from the stored ones), so the index is computed
 * once per root menu.
 *
 * @param {Object} menuService
 * @returns {Map<string, { category: string, name: string, xmlid: string }[]>}
 */
function disabledMenuCommands(menuService) {
    const root = menuService.getMenuAsTree("root");
    let index = disabledMenuCommandIndexes.get(root);
    if (index) {
        return index;
    }
    index = new Map();
    const add = (href, category, name, xmlid) => {
        const commands = index.get(href);
        if (commands) {
            commands.push({ category, name, xmlid });
        } else {
            index.set(href, [{ category, name, xmlid }]);
        }
    };
    const { apps, menuItems } = computeAppsAndMenuItems(root);
    for (const app of apps) {
        if (CRM_OFFLINE_DISABLED_MENUS.has(app.xmlid)) {
            add(app.href, "apps", app.label, app.xmlid);
        }
    }
    for (const item of menuItems) {
        if (CRM_OFFLINE_DISABLED_MENUS.has(item.xmlid)) {
            add(item.href, "menu_items", `${item.parents} / ${item.label}`, item.xmlid);
        }
    }
    disabledMenuCommandIndexes.set(root, index);
    return index;
}

/**
 * The provider's commands are the framework's (action, class, name, href); a command
 * opening a `CRM_OFFLINE_DISABLED_MENUS` menu is only tagged with that menu's `xmlid`
 * (`crmOfflineMenu`), whatever the connection, so a palette opened online follows it.
 * Its action still runs the guarded `selectMenu`.
 */
patch(registry.category("command_provider").get("menu"), {
    async provide() {
        // Resolved before the first `await`: the palette's scope ends there.
        const menuService = useService("menu");
        const commands = await super.provide(...arguments);
        if (!commands.length) {
            return commands;
        }
        const index = disabledMenuCommands(menuService);
        if (!index.size) {
            return commands;
        }
        for (const command of commands) {
            const { category, href, name } = command;
            const match = index
                .get(href)
                ?.find((entry) => entry.category === category && entry.name === name);
            if (match) {
                command.crmOfflineMenu = match.xmlid;
            }
        }
        return commands;
    },
});

/**
 * Offline, a tagged command (`crmOfflineMenu`) renders dimmed and `aria-disabled`,
 * without the "new tab" hint, and its link carries no `href`, so a middle click or
 * the browser's "open in new tab" opens nothing (`web.CommandPalette` extension).
 * Selecting it by click, Enter, Ctrl+Enter or its item's `executeCommand` does
 * nothing: the palette stays open, no action runs, no tab opens and no request is
 * issued. Online, and for every other command, the framework's markup and behaviour
 * are kept.
 */
patch(CommandPalette.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /**
     * Read during render, so an open palette follows the connection. The signal is
     * read only for a tagged command, so a palette listing none is not rendered
     * again when the connection changes.
     *
     * @param {Object} [command]
     * @returns {boolean}
     */
    crmOfflineCommandDisabled(command) {
        return (
            CRM_OFFLINE_DISABLED_MENUS.has(command?.crmOfflineMenu) &&
            this.crmOfflinePlugin.isOffline()
        );
    },

    /**
     * The class of a command's link: the framework's `className`, with
     * `o_disabled_offline` added while `crmOfflineCommandDisabled` holds.
     *
     * @param {Object} command
     * @returns {string|Object|undefined}
     */
    crmOfflineCommandClass(command) {
        if (this.crmOfflineCommandDisabled(command)) {
            return mergeClasses(command.className, "o_disabled_offline");
        }
        return command.className;
    },

    /**
     * The `href` of a command's link: none while `crmOfflineCommandDisabled` holds,
     * so the browser has no link to follow (`false` removes the attribute), the
     * framework's `href` otherwise.
     *
     * @param {Object} command
     * @returns {string|false|undefined}
     */
    crmOfflineCommandHref(command) {
        if (this.crmOfflineCommandDisabled(command)) {
            return false;
        }
        return command.href;
    },

    executeCommand(command) {
        if (this.crmOfflineCommandDisabled(command)) {
            return Promise.resolve();
        }
        return super.executeCommand(...arguments);
    },

    /**
     * Enter goes to the framework's method unchanged: its one wait for the search,
     * then `executeCommand` on the selected command, which the guard above checks at
     * the call. Ctrl+Enter goes to `crmOfflineOpenSelectedCommand`, as the
     * framework's new-tab branch calls `window.open` directly, through no method a
     * patch could guard after its wait.
     *
     * @param {boolean} [ctrlKey]
     * @returns {Promise<void>}
     */
    executeSelectedCommand(ctrlKey) {
        if (!ctrlKey) {
            return super.executeSelectedCommand(...arguments);
        }
        return this.crmOfflineOpenSelectedCommand();
    },

    /**
     * The framework's Ctrl+Enter branch, with the same single wait for the search:
     * the command selected once it settles opens its `href` in a new tab. The guard
     * is checked in that same continuation, right before `window.open`, so a
     * disconnection or a new selection during the wait is seen. Offline, a command
     * of a `CRM_OFFLINE_DISABLED_MENUS` menu opens nothing. Online, and for every
     * other command, this is the framework's behaviour.
     *
     * @returns {Promise<void>}
     */
    async crmOfflineOpenSelectedCommand() {
        await this.searchValuePromise;
        const selectedCommand = this.state.selectedCommand;
        if (selectedCommand?.href && !this.crmOfflineCommandDisabled(selectedCommand)) {
            window.open(selectedCommand.href, "_blank");
        }
    },
});

// -----------------------------------------------------------------------------
// Fallback: lead view descriptions cached by a wide-layout visit
// -----------------------------------------------------------------------------

/**
 * Whether an ORM call loads `crm.lead` view descriptions for the small-screen
 * layout: the view service adds `options.mobile` to `get_views` on a small screen.
 *
 * @param {string} model
 * @param {string} method
 * @param {Object} [kwargs]
 * @returns {boolean}
 */
function isLeadSmallScreenGetViews(model, method, kwargs) {
    return model === "crm.lead" && method === "get_views" && kwargs?.options?.mobile === true;
}

/**
 * The ORM the view service loads view descriptions with, where `cache()` returns
 * a cached ORM whose small-screen lead `get_views`, started offline and failed
 * with a lost connection, is issued once more through that same cached ORM
 * without `options.mobile`. Every other call and outcome is the original one.
 *
 * @param {Object} orm the view service's `orm` dependency
 * @param {OfflinePlugin} offlinePlugin
 * @returns {Object}
 */
function withLeadViewsFallback(orm, offlinePlugin) {
    return Object.assign(Object.create(orm), {
        cache(...cacheArgs) {
            const cachedOrm = orm.cache(...cacheArgs);
            return Object.assign(Object.create(cachedOrm), {
                call(model, method, args, kwargs) {
                    const startedOffline = offlinePlugin.isOffline();
                    const result = cachedOrm.call(...arguments);
                    if (!startedOffline || !isLeadSmallScreenGetViews(model, method, kwargs)) {
                        return result;
                    }
                    const options = omit(kwargs.options, "mobile");
                    return result.catch((error) => {
                        if (!(error instanceof ConnectionLostError)) {
                            throw error;
                        }
                        return cachedOrm.call(model, method, args, { ...kwargs, options });
                    });
                },
            });
        },
    });
}

patch(viewService, {
    /**
     * The view service caches `get_views` per layout: `options.mobile`, which it
     * sets on a small screen, is part of the RPC cache key. Offline on a phone, the
     * lead views a wide-layout visit cached on this device would never be read, so
     * a lead form visited at that width could not open, nor the pipeline it was
     * opened from be restored. The view service's ORM therefore issues a failed
     * offline small-screen lead `get_views` once more without `mobile` (the other
     * options keep their order, so the request is the one that visit cached).
     * `mobile` only changes the default mode of x2many sub-views, and the lead form
     * and pipeline already fall back to the desktop load variant offline. A load
     * started online keeps the framework's handling of a lost connection.
     */
    start(env, deps) {
        // Resolved synchronously: the service scope only exists during `start`.
        const offlinePlugin = usePlugin(OfflinePlugin);
        return super.start(env, { ...deps, orm: withLeadViewsFallback(deps.orm, offlinePlugin) });
    },
});

// -----------------------------------------------------------------------------
// Guard: view mount (fail-closed backstop for every act_window controller)
// -----------------------------------------------------------------------------

/**
 * Classifies a CRM view target that never opens offline. Pure: reads its arguments
 * only.
 * - "read": report and analysis views (the lead graph, pivot, calendar, activity
 *   and forecast views, every `crm.activity.report` view), and the other non-form
 *   views of a disabled action (the Recurring Plans list, the meeting calendar) or
 *   of a lead's meetings (`isCrmOfflineMeeting`: the calendar Schedule Meeting
 *   opens, with its event moves and event popover), swapped to the offline helper
 *   as soon as the connection drops, a meeting view once its quick create closes;
 * - "dialog": wizards, the team form, the CRM settings and the forms of a disabled
 *   action (a CRM bound mail composer) or of a lead's meeting, which stay mounted
 *   once loaded so entered values survive (their saves and buttons are guarded
 *   instead).
 *
 * A disabled action is recognised by the `xml_id` of the action that opened the
 * view, so its target is stopped however it was requested: an id the action guards
 * cannot identify offline (loaded in an earlier page session, then answered from the
 * disk cache), a restored URL or a breadcrumb. Lead views keep their own rules, so a
 * lead form opened from the forecast stays usable.
 *
 * @param {Object} props View props
 * @param {string|false} [actionXmlId] `xml_id` of the action that opened the view
 * @returns {"read"|"dialog"|false}
 */
function crmBlockedTarget(props, actionXmlId) {
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
    if (
        CRM_OFFLINE_DISABLED_ACTIONS.has(actionXmlId) ||
        isCrmOfflineMeeting(resModel, context, actionXmlId)
    ) {
        return type === "form" ? "dialog" : "read";
    }
    return false;
}

/**
 * Count of lead-meeting forms mounted in a dialog: the quick create a meeting calendar
 * opens. The calendar owns that dialog and closes it when it unmounts, so while one is
 * open the lead-meeting views keep the controller, under the modal, rather than lose
 * the entered values; the dialog's save is refused offline like any meeting save.
 */
const crmMeetingDialogs = proxy({ open: 0 });

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
        // Whether a mounted lead-meeting view gives way to the helper. A computed
        // notifies only when it flips, so the connection dropping under an open meeting
        // dialog re-renders nothing (a re-render reloads the controller's data).
        this.crmMeetingSwap = computed(
            () => this.crmOfflinePlugin.isOffline() && !crmMeetingDialogs.open
        );
        const { resModel, context, type } = this.props;
        if (
            this.env.inDialog &&
            type === "form" &&
            isCrmOfflineMeeting(resModel, context, this.env.config?.actionXmlId)
        ) {
            let counted = false;
            const release = () => {
                if (counted) {
                    counted = false;
                    crmMeetingDialogs.open--;
                }
            };
            onMounted(() => {
                counted = true;
                crmMeetingDialogs.open++;
            });
            onWillUnmount(release);
            onWillDestroy(release);
        }
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
     * read target while offline. A lead-meeting view waits for its open meeting
     * dialog (`crmMeetingDialogs`) to close first.
     */
    get crmOfflineBlocked() {
        const actionXmlId = this.env.config?.actionXmlId;
        const target = crmBlockedTarget(this.props, actionXmlId);
        if (!target) {
            return false;
        }
        if (this.crmLoadPending) {
            return true;
        }
        if (target !== "read") {
            return false;
        }
        if (isCrmOfflineMeeting(this.props.resModel, this.props.context, actionXmlId)) {
            return this.crmMeetingSwap();
        }
        return this.crmOfflinePlugin.isOffline();
    },

    loadView(props) {
        if (!crmBlockedTarget(props, this.env.config?.actionXmlId)) {
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
        // Every item of a lead's meeting (Archive, Unarchive, Delete, Duplicate)
        // writes or copies it, and meetings are never written offline.
        const isCrmItem =
            (CRM_ACTION_MENU_MODELS.has(this.props.resModel) && !item?.availableOffline) ||
            isCrmOfflineMeeting(
                this.props.resModel,
                this.props.context,
                this.env.config?.actionXmlId
            );
        if (isCrmItem && this.offlinePlugin.isOffline()) {
            return Promise.resolve();
        }
        return super.onItemSelected(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: Sales Teams dashboard cards and lead cards
// -----------------------------------------------------------------------------

/**
 * Whether a card is a lead whose form cannot open offline: offline, not sample data,
 * and its form not visited for the current action, the test by which the framework
 * dims the card (`KanbanRecord.getCardClasses`). Scope tested first; the signals are
 * read on each call, so a menu or card rendered online follows the connection.
 *
 * @param {CardRenderer} card
 * @returns {boolean}
 */
function isCrmLeadFormUnavailableOffline(card) {
    const { record } = card.props;
    return (
        record.resModel === "crm.lead" &&
        card.offlinePlugin.isOffline() &&
        !record.model.useSampleModel &&
        !card.offlinePlugin.isAvailableOffline(card.env.config?.actionId, "form", record.resId)
    );
}

/**
 * Whether a viewport point lies on a guarded CRM view-button link inside `root`
 * (`a.o_crm_offline_guarded.o_disabled_offline`, the links the CRM rule in
 * `crm_mobile_pipeline.scss` keeps out of hit-testing) or on one of its descendants,
 * whose boxes can overflow an inline link's own (an inline-block badge) and inherit
 * its `pointer-events`. A click there passes through the link to the card beneath.
 *
 * @param {HTMLElement|null} root
 * @param {number} x client X coordinate
 * @param {number} y client Y coordinate
 * @returns {boolean}
 */
function isPointOnCrmOfflineGuardedLink(root, x, y) {
    if (!root || !Number.isFinite(x) || !Number.isFinite(y)) {
        return false;
    }
    for (const link of root.querySelectorAll("a.o_crm_offline_guarded.o_disabled_offline")) {
        for (const el of [link, ...link.querySelectorAll("*")]) {
            for (const rect of el.getClientRects()) {
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    return true;
                }
            }
        }
    }
    return false;
}

patch(KanbanRecord.prototype, {
    /**
     * Whether the card-menu toggle carries `data-available-offline` (`web.KanbanMenu`
     * extension): on lead cards, whose menu items are queued or available offline,
     * except where the framework queue cannot hold their calls
     * (`isCrmOfflineQueueBlocked`), so the framework disables the toggle there and
     * the Delete of a menu opened online is disabled (`crmDeleteBlocked`).
     */
    get crmMenuAvailableOffline() {
        return (
            this.props.record.resModel === "crm.lead" &&
            !isCrmOfflineQueueBlocked(this.offlinePlugin)
        );
    },

    /**
     * Whether the "Delete" trigger of a lead card (its card menu's Delete, compiled
     * by `CrmLeadCardCompiler`) is disabled: offline where the framework queue cannot
     * hold the `unlink` (`isCrmOfflineQueueBlocked`, a non-secure origin). The menu
     * toggle is framework-disabled there, so only a menu opened online still shows
     * the item; it then renders disabled and inert, and `triggerAction` deletes
     * nothing, instead of opening a confirmation whose delete could only end in the
     * framework's non-secure-context notification. Read on render, so an open menu
     * follows the connection; the lead scope is tested first. Always `false` online
     * and in a secure context, where Delete confirms and queues `unlink` offline.
     *
     * @returns {boolean}
     */
    get crmDeleteBlocked() {
        return (
            this.props.record.resModel === "crm.lead" &&
            isCrmOfflineQueueBlocked(this.offlinePlugin)
        );
    },

    /**
     * Class of a blocked lead-card Delete (`crmDeleteBlocked`): the arch's own class
     * expression with the framework's offline-disabled state, `pe-none` included.
     *
     * @param {string|Object|undefined} base the arch's `t-att-class` value, if any
     * @returns {Object}
     */
    crmDeleteBlockedClass(base) {
        return mergeClasses(base, "o_disabled_offline pe-none");
    },

    /**
     * Offline, a team card whose click goes nowhere is dimmed, also when its team
     * form was visited online (the framework dims a card only by the offline
     * availability of its form): the dashboard card action is stopped by the
     * button-execution guard, and the team form a card opens by the view-mount
     * guard. A selection dialog's card (`forceGlobalClick`) selects its team
     * offline, and sample cards are inert.
     */
    getCardClasses() {
        const classes = super.getCardClasses(...arguments);
        const { canOpenRecords, forceGlobalClick, openAction, record } = this.props;
        if (
            record.resModel !== "crm.team" ||
            forceGlobalClick ||
            !(openAction || canOpenRecords) ||
            record.model.useSampleModel ||
            !this.offlinePlugin.isOffline()
        ) {
            return classes;
        }
        const classList = classes.split(" ");
        return classList.includes("o_disabled_offline")
            ? classes
            : [...classList, "o_disabled_offline"].join(" ");
    },

    /**
     * Offline, opening a team card (its "Configuration" link) or a lead card whose
     * form cannot open offline (`isCrmLeadFormUnavailableOffline`, the lead menu's
     * "Edit") does nothing: no form load is requested. Deleting a lead card where
     * its `unlink` cannot be queued (`crmDeleteBlocked`) does nothing either: no
     * confirmation, notification, request or queue entry, and the card stays.
     */
    triggerAction(params) {
        if (
            (params?.type === "open" || params?.type === "edit") &&
            ((this.props.record.resModel === "crm.team" && this.offlinePlugin.isOffline()) ||
                isCrmLeadFormUnavailableOffline(this))
        ) {
            return;
        }
        if (params?.type === "delete" && this.crmDeleteBlocked) {
            return;
        }
        return super.triggerAction(...arguments);
    },

    /**
     * Offline, a click passing through a guarded CRM view-button link of the card
     * (`isPointOnCrmOfflineGuardedLink`), such as the campaign lead counter, is the
     * click on that link: as the framework does for a click on any `<a>`
     * (`CANCEL_GLOBAL_CLICK`), the card neither opens its record or action nor toggles
     * its selection, so the click is as inert as the guarded link. Scope tested first;
     * online, on other models and elsewhere on the card the framework's click runs.
     *
     * @param {MouseEvent} ev
     * @param {boolean} newWindow
     */
    onGlobalClick(ev, newWindow) {
        const { resModel } = this.props.record;
        if (
            (CRM_VIEW_BUTTON_MODELS.has(resModel) || resModel === "utm.campaign") &&
            this.offlinePlugin.isOffline() &&
            isPointOnCrmOfflineGuardedLink(this.rootRef(), ev?.clientX, ev?.clientY)
        ) {
            return;
        }
        return super.onGlobalClick(...arguments);
    },
});

/** Rendering-context expression of a lead card's blocked Delete (`crmDeleteBlocked`). */
const CRM_DELETE_BLOCKED = "__comp__.crmDeleteBlocked";

/**
 * Sets the dynamic attribute `t-att-<name>` of a compiled card trigger to
 * `offlineExpr` while its Delete is blocked, and to the arch's own value otherwise:
 * its `t-att-<name>` expression, else its static attribute (moved into the
 * expression), else none (`false` drops the attribute).
 *
 * @param {Element} el
 * @param {string} name
 * @param {string} offlineExpr
 */
function setCrmDeleteBlockedAttribute(el, name, offlineExpr) {
    const dynamicName = `t-att-${name}`;
    let onlineExpr = "false";
    if (el.hasAttribute(dynamicName)) {
        onlineExpr = `(${el.getAttribute(dynamicName)})`;
    } else if (el.hasAttribute(name)) {
        onlineExpr = toStringExpression(el.getAttribute(name));
        el.removeAttribute(name);
    }
    el.setAttribute(dynamicName, `${CRM_DELETE_BLOCKED} ? ${offlineExpr} : ${onlineExpr}`);
}

/**
 * Card compiler of the CRM lead kanban views (`crm_mobile_pipeline`). Each
 * `type="delete"` trigger, the card menu's Delete, renders as the framework
 * renders it, and while `KanbanRecord.crmDeleteBlocked` holds (offline on a
 * non-secure origin) it takes the offline-disabled state of the team card's
 * "Configuration" link in a menu opened online: `o_disabled_offline pe-none`,
 * `aria-disabled="true"`, out of the tab order and `inert`, so no pointer, focus or
 * key reaches it (`inert` holds whatever `pointer-events` the framework's
 * `o_disabled_offline` rule computes). Its `t-key` re-creates it on each change of
 * that state, so the open dropdown refreshes its keyboard-navigable items, which
 * the `KanbanDropdownMenuWrapper` patch then rebuilds without it. A click a script
 * dispatches on it is stopped by `triggerAction` and by that wrapper. Online and in
 * a secure context every expression yields the arch's own attributes, so the DOM
 * is unchanged.
 */
export class CrmLeadCardCompiler extends CardCompiler {
    compileButton(el, params) {
        // `super` removes `type` from `el` before copying its attributes.
        const isDelete = el.getAttribute("type") === "delete";
        const compiled = super.compileButton(...arguments);
        if (!isDelete) {
            return compiled;
        }
        const baseClass = compiled.getAttribute("t-att-class") || "''";
        compiled.setAttribute(
            "t-att-class",
            `${CRM_DELETE_BLOCKED} ? __comp__.crmDeleteBlockedClass(${baseClass}) : (${baseClass})`
        );
        setCrmDeleteBlockedAttribute(compiled, "aria-disabled", "'true'");
        setCrmDeleteBlockedAttribute(compiled, "tabindex", "-1");
        setCrmDeleteBlockedAttribute(compiled, "inert", "''");
        const baseKey = compiled.hasAttribute("t-key")
            ? `(${compiled.getAttribute("t-key")})`
            : "''";
        compiled.setAttribute(
            "t-key",
            `(${CRM_DELETE_BLOCKED} ? 'crm_offline_' : 'crm_online_') + ${baseKey}`
        );
        return compiled;
    }
}

patch(CardRenderer.prototype, {
    createWidget(props) {
        super.createWidget(...arguments);
        const renderer = this;
        const widget = untrack(() => ({ ...this.dataState.widget }));
        this.dataState.widget = {
            ...widget,
            /**
             * `widget.editable`, read by the lead card menu's "Edit": its original
             * value, except `false` for a lead whose form cannot open offline
             * (`isCrmLeadFormUnavailableOffline`), so the menu offers no Edit that
             * cannot open. Evaluated lazily, so an open menu follows the connection.
             */
            get editable() {
                return widget.editable && !isCrmLeadFormUnavailableOffline(renderer);
            },
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

/** Models whose card colour write is queued offline (`web.KanbanColorPickerField` extension). */
const CRM_QUEUED_COLOR_MODELS = freezeSet(["crm.lead", "crm.team"]);

/**
 * @param {Object} field a `kanban_color_picker` field component
 * @returns {boolean} whether its record is a CRM one whose colour write cannot be
 *  queued now (`isCrmOfflineQueueBlocked`); scope tested first
 */
function isCrmColorWriteBlocked(field) {
    const { record } = field.props;
    return (
        CRM_QUEUED_COLOR_MODELS.has(record.resModel) &&
        isCrmOfflineQueueBlocked(record.model?.offlinePlugin)
    );
}

patch(kanbanColorPickerField.component.prototype, {
    /**
     * Whether the colour buttons carry `data-available-offline`: on lead and
     * sales-team records, whose colour write is queued offline, except where the
     * queue cannot hold it, so the framework disables them there.
     */
    get crmColorAvailableOffline() {
        const { record } = this.props;
        return (
            CRM_QUEUED_COLOR_MODELS.has(record.resModel) &&
            !isCrmOfflineQueueBlocked(record.model?.offlinePlugin)
        );
    },

    /**
     * Inert where the colour write cannot be queued, so no unsaved colour is left on
     * the card (a click racing the framework's disabling, or a direct call).
     */
    selectColor() {
        if (isCrmColorWriteBlocked(this)) {
            return;
        }
        return super.selectColor(...arguments);
    },
});

/**
 * Menu items a CRM guard disables offline: the team card "Configuration" link
 * (`widget.crm_offline`) and, on a non-secure origin, the lead card Delete
 * (`KanbanRecord.crmDeleteBlocked`) are the only `.dropdown-item`s that get this
 * state.
 */
const CRM_OFFLINE_DISABLED_MENU_ITEM = ".dropdown-item.o_disabled_offline[aria-disabled='true']";

/**
 * Whether a click inside a card menu was aimed at an offline-disabled item: on the
 * item itself (a script's click), or on the `[role=menuitem]` cell holding it,
 * which is where a pointer click lands, since the inert `pe-none` item takes none.
 *
 * @param {EventTarget|null} target
 */
function isCrmOfflineDisabledMenuClick(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    if (target.closest(CRM_OFFLINE_DISABLED_MENU_ITEM)) {
        return true;
    }
    return (
        target.matches("[role='menuitem']") &&
        Boolean(target.querySelector(CRM_OFFLINE_DISABLED_MENU_ITEM))
    );
}

patch(KanbanDropdownMenuWrapper.prototype, {
    /**
     * The dropdown wrapper marks all items `o-navigable` after mount/patch, ignoring
     * disabled ARIA/tabindex states. Run after it to remove the mark from
     * offline-disabled team and lead items and preserve keyboard navigation
     * elsewhere.
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

    /**
     * A click on an offline-disabled item does nothing, so it keeps the menu open:
     * a team menu opened online cannot be reopened offline (its toggle is
     * disabled), and closing it would make its queued colour picker unreachable;
     * neither can a lead menu opened online on a non-secure origin, whose "Edit"
     * of a lead form cached offline stays reachable. The item's `href="#"` is not
     * followed either, as that navigation closes the menu too.
     */
    onClick(ev) {
        if (isCrmOfflineDisabledMenuClick(ev?.target ?? null)) {
            ev.preventDefault();
            return;
        }
        return super.onClick(...arguments);
    },
});

/**
 * The team leader of a dashboard card (`many2one_avatar_user` on `user_id`) is a
 * `KanbanMany2One`, whose quick-assign (no leader set) saves the record: a
 * `crm.team` `web_save` of the leader. Offline that is team management, as on the
 * team form, so it is disabled; the card colour stays the only team write
 * reachable offline. The field's props hold no record, so the view's model
 * (`env.model`, whose root is `crm.team` on the dashboard) scopes it; lead cards
 * and every other model are left as they are.
 */
patch(KanbanMany2One.prototype, {
    /** Closes an assign popover opened online as soon as the connection drops. */
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
        useEffect(() => {
            if (this.crmOfflineAssignGuarded) {
                untrack(() => this.assignPopover.isOpen && this.assignPopover.close());
            }
        });
    },

    /**
     * True for a Sales Teams card's quick-assign while offline (scope tested
     * first). Read by the `web.KanbanMany2One` extension, so the link renders
     * disabled and follows the connection.
     */
    get crmOfflineAssignGuarded() {
        return this.env.model?.root?.resModel === "crm.team" && this.crmOfflinePlugin.isOffline();
    },

    /** Offline, a team card opens no assign popover, which also stops a direct call. */
    openAssignPopover() {
        if (this.crmOfflineAssignGuarded) {
            return;
        }
        return super.openAssignPopover(...arguments);
    },
});

/** Models whose records' avatars open no avatar card offline. */
const CRM_OFFLINE_AVATAR_MODELS = freezeSet(["crm.lead", "crm.team"]);

/**
 * Env key under which a user avatar field hands its record's model to the `Avatar`
 * it renders, whose own props only name the user.
 */
const CRM_AVATAR_RECORD_MODEL = Symbol("crmAvatarRecordModel");

/**
 * @param {object} env
 * @returns {string|undefined} the model scoping the avatars rendered under `env`: the
 *     record model a user avatar field handed down, otherwise the view's root model
 */
function crmAvatarScope(env) {
    return env[CRM_AVATAR_RECORD_MODEL] ?? env.model?.root?.resModel;
}

/**
 * The user avatar fields (`many2one_avatar_user` in forms and lists, CRM's
 * `many2one_avatar_leader_user` through inheritance, `card.many2one_avatar_user` on
 * kanban cards) expose their record's model to their avatar. The record, not the
 * view's root, is what scopes the avatar guard below: a lead list inside another
 * model's form (the merge and mass-convert wizards' lead lists) shows lead avatars,
 * and a lead view may embed records of other models. A field adds the key only where
 * it changes that scope: on a lead or team record, or on another model's record
 * rendered where the inherited scope is a lead or a team (an activity list inside a
 * lead form). Any other field leaves the env untouched, as its avatar already
 * resolves the same scope from it; the fields render and behave as before.
 */
for (const AvatarUserField of [Many2OneAvatarUserField, CardMany2OneAvatarUserField]) {
    patch(AvatarUserField.prototype, {
        setup() {
            super.setup(...arguments);
            const recordModel = this.props.record?.resModel;
            if (
                CRM_OFFLINE_AVATAR_MODELS.has(recordModel) ||
                CRM_OFFLINE_AVATAR_MODELS.has(crmAvatarScope(this.env))
            ) {
                useSubEnv({ [CRM_AVATAR_RECORD_MODEL]: recordModel });
            }
        },
    });
}

/**
 * An avatar opens mail's avatar card, whose contact read (`/mail/store`, fetch
 * `avatar_card`) fails offline with an uncaught `ConnectionLostError`. Offline, the
 * avatar of a lead (salesperson on pipeline and lead kanban cards, lead lists, the
 * lead form, the wizards' lead lists) or of a team (a dashboard card's leader) opens
 * no card, so that decorative read is neither issued nor queued and nothing is
 * raised; a direct `onClickAvatar` call reads the same getter. The scope is the
 * model of the record whose field renders the avatar, or, for an avatar rendered
 * outside such a field, the view's root model; it is tested before the connection,
 * so other models' avatars never read the offline signal and open as the framework
 * renders them. Online every avatar opens its card as before, and a card opened
 * online stays open with what it has loaded.
 */
patch(Avatar.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** True for a lead's or a team's avatar while offline (scope tested first). */
    get crmOfflineAvatarGuarded() {
        return (
            CRM_OFFLINE_AVATAR_MODELS.has(crmAvatarScope(this.env)) &&
            this.crmOfflinePlugin.isOffline()
        );
    },

    get canOpenPopover() {
        const canOpen = super.canOpenPopover;
        if (!canOpen) {
            return canOpen;
        }
        return !this.crmOfflineAvatarGuarded;
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
// Guard: lead activity buttons (kanban_activity, list_activity)
// -----------------------------------------------------------------------------

/**
 * @param {ActivityButton} button
 * @returns {boolean} whether a lead's activity button is offline (scope tested first)
 */
function isLeadActivityButtonOffline(button) {
    const { record } = button.props;
    return record.resModel === "crm.lead" && Boolean(record.model?.offlinePlugin?.isOffline());
}

/**
 * The activity button of the lead kanban cards (`kanban_activity`) and of the
 * Opportunities list (`list_activity`, whose button is a subclass). Its popover
 * fetches the lead's activities from the server, so offline the framework disables
 * the `<button>` and this guard stops a direct call as well.
 */
patch(ActivityButton.prototype, {
    /** Closes a lead's popover opened online as soon as the connection drops. */
    setup() {
        super.setup(...arguments);
        useEffect(() => {
            if (isLeadActivityButtonOffline(this)) {
                untrack(() => this.popover.isOpen && this.popover.close());
            }
        });
    },

    /**
     * Offline, a lead's button opens no popover, so nothing is fetched; closing a
     * popover still open stays allowed, and issues no request.
     */
    onClick() {
        if (isLeadActivityButtonOffline(this) && !this.popover.isOpen) {
            return Promise.resolve();
        }
        return super.onClick(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: lead activity reschedule dropdown (mail_activity_mixin_list_reschedule_dropdown)
// -----------------------------------------------------------------------------

/**
 * @param {MailActivityMixinListRescheduleDropdown} dropdown
 * @returns {boolean} whether a lead's reschedule dropdown is offline (scope tested first)
 */
function isLeadRescheduleOffline(dropdown) {
    const { record } = dropdown.props;
    return record.resModel === "crm.lead" && Boolean(record.model?.offlinePlugin?.isOffline());
}

/** Env key under which a reschedule dropdown collects the date pickers of its menu. */
const CRM_RESCHEDULE_PICKERS = Symbol("crmReschedulePickers");

/**
 * Collects the date pickers created under a reschedule dropdown (its custom-date
 * item). A picker closes on click-away, or when its input leaves its parent, but not
 * when the menu holding that input closes, so the dropdown closes them itself.
 * Pickers created anywhere else are untouched.
 */
patch(datetimePickerService, {
    start() {
        const service = super.start(...arguments);
        const { create } = service;
        service.create = function crmRescheduleCreate(params, options) {
            const manager = create.call(this, params, options);
            const pickers = options?.useOwlHooks && useEnv()[CRM_RESCHEDULE_PICKERS];
            if (pickers) {
                pickers.add(manager);
                onWillDestroy(() => pickers.delete(manager));
            }
            return manager;
        };
        return service;
    },
});

/**
 * The "Reschedule" dropdown of the Opportunities list. Its items reschedule through
 * `doActionButton`, whose CRM guard stops the call offline, and the framework
 * disables its toggle `<button>`. The `mail.MailActivityMixinListRescheduleDropdown`
 * extension hands this state to its `Dropdown`, so a lead's menu opened online, and
 * the date picker opened from it, close as soon as the connection drops, as does a
 * menu opened by any other path while offline.
 */
patch(MailActivityMixinListRescheduleDropdown.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmRescheduleState = useDropdownState();
        const pickers = new Set();
        useSubEnv({ [CRM_RESCHEDULE_PICKERS]: pickers });
        useEffect(() => {
            if (isLeadRescheduleOffline(this) && this.crmRescheduleState.isOpen) {
                untrack(() => {
                    for (const picker of pickers) {
                        picker.close();
                    }
                    this.crmRescheduleState.close();
                });
            }
        });
    },
});

// -----------------------------------------------------------------------------
// Guard: relational autocomplete of the lead form (partner field)
// -----------------------------------------------------------------------------

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

/**
 * Keys of the sources a lead view's autocomplete passes to its AutoComplete: the
 * first holds that `Many2XAutocomplete` (whose `crmOfflineInlineSearch` the
 * AutoComplete patch below reads), the second marks a source added through
 * `otherSources` (e.g. the partner enrichment), as opposed to the record source.
 */
const CRM_LEAD_AUTOCOMPLETE = Symbol("crmLeadAutocomplete");
const CRM_LEAD_EXTRA_SOURCE = Symbol("crmLeadExtraSource");

/**
 * @param {Many2XAutocomplete} autocomplete
 * @param {Object} source
 * @param {boolean} [isExtra]
 */
function tagLeadSource(autocomplete, source, isExtra = false) {
    return {
        ...source,
        [CRM_LEAD_AUTOCOMPLETE]: autocomplete,
        [CRM_LEAD_EXTRA_SOURCE]: isExtra,
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
            return [tagLeadSource(this, this.optionsSource)];
        }
        const { otherSources } = this.props;
        return super.sources.map((source) =>
            tagLeadSource(
                this,
                guardAutocompleteSource(this, source),
                otherSources.includes(source)
            )
        );
    },

    /**
     * Offline, a lead view's record search reads the relational-field cache only.
     * The framework search issues `web_name_search` first and falls back to the
     * same cache once the lost connection refuses it, so every offline query would
     * still attempt a request. `searchMany2XRecords` resolves `undefined` without a
     * secure context or the session's cache secret, which is read as no cached
     * record, as is a search reaching a record this session cannot decrypt
     * (`readDecryptableCache`).
     *
     * @param {string} name
     * @returns {Promise<Object[]>}
     */
    search(name) {
        if (this.crmOfflineInlineSearch) {
            return readDecryptableCache(
                this.offlinePlugin.searchMany2XRecords(this.props.resModel, name)
            ).then((records) => records || []);
        }
        return super.search(...arguments);
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

function isInertGuardedOption(option) {
    return Boolean(option?.[CRM_OFFLINE_GUARDED_OPTION] && option.unselectable);
}

/**
 * True while the lead autocomplete whose sources `autoComplete` renders is offline
 * (`crmOfflineInlineSearch`, which reads the connection signal), false for every
 * other AutoComplete.
 *
 * @param {AutoComplete} autoComplete
 */
function isLeadAutoCompleteOffline(autoComplete) {
    return (autoComplete.props.sources || []).some((source) =>
        Boolean(source?.[CRM_LEAD_AUTOCOMPLETE]?.crmOfflineInlineSearch)
    );
}

/** Stores the value assigned to `shouldSearchWorldwide` (see the AutoComplete patch). */
const CRM_SEARCH_WORLDWIDE = Symbol("crmSearchWorldwide");

patch(AutoComplete.prototype, {
    /**
     * The "Search Worldwide" row calls `searchWorldwide(ev)`, which sets the flag
     * below and closes then reopens the dropdown, reloading its sources. That
     * handler is defined by the partner autocomplete, an AutoComplete subclass
     * outside CRM's dependencies that CRM may not import, so its prototype cannot
     * be patched from here: the handler is wrapped on the instance instead. The
     * subclass's `setup` calls this one through `super`, so its method already
     * resolves on the instance. While a lead autocomplete is offline the wrapper
     * only prevents the event's default action: a direct call opens no dropdown,
     * reloads no option and changes no state. Otherwise it returns the original's
     * own result. AutoCompletes without the handler are left unchanged.
     */
    setup() {
        super.setup(...arguments);
        const { searchWorldwide } = this;
        if (typeof searchWorldwide !== "function") {
            return;
        }
        this.searchWorldwide = function crmOfflineSearchWorldwide(...args) {
            if (isLeadAutoCompleteOffline(this)) {
                args[0]?.preventDefault?.();
                return Promise.resolve();
            }
            return searchWorldwide.apply(this, args);
        };
    },

    /**
     * The partner autocomplete (an AutoComplete subclass outside CRM's
     * dependencies) renders a "Search Worldwide" row below the options unless this
     * flag is set, passes the flag to every enrichment lookup, and sets it when that
     * row is used. The row is part of its template, not a source option, so the
     * option guards never see it. While a lead autocomplete is offline the flag
     * reads true, so the row is not rendered, in a dropdown opened online too, and
     * assigning true is ignored, so a call made offline cannot widen the next online
     * lookup. Otherwise the assigned value is stored and returned unchanged. Read
     * during render, so the row follows the connection.
     */
    get shouldSearchWorldwide() {
        return isLeadAutoCompleteOffline(this) || this[CRM_SEARCH_WORLDWIDE];
    },

    set shouldSearchWorldwide(value) {
        if (value && isLeadAutoCompleteOffline(this)) {
            return;
        }
        this[CRM_SEARCH_WORLDWIDE] = value;
    },

    /**
     * A lookup of a lead autocomplete's added source (enrichment) still pending
     * when the connection drops can stay pending offline, which would keep its
     * loading row ("Searching Autocomplete...") shown and selected. Its
     * `isLoading` reads false while the guard holds and the real state otherwise,
     * so the row comes back online while the lookup is still pending. The source
     * proxy's set trap writes through the accessor and re-reads it, so loading
     * changes still re-render. The record source keeps its own loading row, and
     * other AutoCompletes' sources are returned unchanged.
     */
    makeSource(source) {
        const made = super.makeSource(...arguments);
        const autocomplete = source?.[CRM_LEAD_EXTRA_SOURCE] && source[CRM_LEAD_AUTOCOMPLETE];
        if (!autocomplete) {
            return made;
        }
        let isLoading = made.isLoading;
        Object.defineProperty(made, "isLoading", {
            configurable: true,
            enumerable: true,
            get: () => !autocomplete.crmOfflineInlineSearch && isLoading,
            set: (value) => {
                isLoading = value;
            },
        });
        return made;
    },

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
// Guard: CRM wizard and CRM settings forms
// -----------------------------------------------------------------------------

/**
 * Settings records on which a CRM-owned settings control runs (its pre-save and the
 * "Unsaved changes" confirmation it may open), with their number of running
 * controls, keyed by raw record. Offline, such a record is neither saved nor queued,
 * and no settings button runs on it.
 *
 * @type {WeakMap<Record, number>}
 */
const crmSettingsControlRuns = new WeakMap();

/**
 * Marks a settings record for the run of a CRM-owned settings control.
 *
 * @param {Record} record
 * @returns {() => void} ends this run (called once)
 */
function startCrmSettingsControlRun(record) {
    const raw = toRaw(record);
    crmSettingsControlRuns.set(raw, (crmSettingsControlRuns.get(raw) || 0) + 1);
    return () => {
        const runs = crmSettingsControlRuns.get(raw) - 1;
        if (runs > 0) {
            crmSettingsControlRuns.set(raw, runs);
        } else {
            crmSettingsControlRuns.delete(raw);
        }
    };
}

/**
 * Tells whether a CRM-owned settings control runs on a settings record.
 *
 * @param {Record} [record]
 * @returns {boolean}
 */
function isCrmSettingsControlRun(record) {
    return Boolean(record) && crmSettingsControlRuns.has(toRaw(record));
}

/**
 * Tells whether a record's save is never queued: a CRM transient record or a lead's
 * meeting (`isCrmOfflineTransientForm`, with the `xml_id` of the action that opened
 * its view), any other record of a lead's meeting form (such as an event tag whose
 * colour the form's tag editor saves), or a settings record a CRM-owned settings
 * control runs on. Pure: it reads no signal.
 *
 * @param {Record} record
 * @returns {boolean}
 */
function isCrmOfflineTransientRecord(record) {
    const actionXmlId = record.model.env?.config?.actionXmlId;
    const root = record.model.root;
    return (
        isCrmOfflineTransientForm(record.resModel, record.context, actionXmlId) ||
        Boolean(root && isCrmOfflineMeeting(root.resModel, root.context, actionXmlId)) ||
        isCrmSettingsControlRun(record)
    );
}

/**
 * Key of a settings button, from its `type` and `name` (click parameters and arch
 * attributes carry the same strings).
 *
 * @param {string} [type]
 * @param {string} [name]
 * @returns {string}
 */
function settingsButtonKey(type, name) {
    return `${type}:${name}`;
}

/**
 * The CRM-owned controls of a settings arch: the `object` and `action` buttons and
 * links of its CRM app (`<app name="crm">`), as `settingsButtonKey`s. The General
 * Settings show that app as the CRM settings page does, under another
 * `context.module`.
 *
 * @param {Element} [xmlDoc] settings form arch
 * @returns {ReadonlySet<string>}
 */
function getCrmSettingsButtonKeys(xmlDoc) {
    const keys = new Set();
    const nodes =
        xmlDoc?.querySelectorAll("app[name='crm'] button[name], app[name='crm'] a[type][name]") ||
        [];
    for (const node of nodes) {
        const type = node.getAttribute("type");
        if (type === "object" || type === "action") {
            keys.add(settingsButtonKey(type, node.getAttribute("name")));
        }
    }
    return keys;
}

/**
 * Runs the pre-execution of a CRM-owned settings control (`beforeExecute`: the
 * settings controller's pre-save, or the "Unsaved changes" confirmation it opens)
 * with the settings record marked (`startCrmSettingsControlRun`), and stops the
 * control when the connection is lost meanwhile.
 *
 * @param {Record} record the settings record
 * @param {OfflinePlugin} offlinePlugin
 * @param {() => Promise<boolean|undefined>} beforeExecute
 * @returns {Promise<boolean|undefined>} `false` when offline once it ends, else its result
 */
async function runCrmSettingsControl(record, offlinePlugin, beforeExecute) {
    const endRun = startCrmSettingsControlRun(record);
    try {
        const proceed = await beforeExecute();
        return offlinePlugin.isOffline() ? false : proceed;
    } finally {
        endRun();
    }
}

patch(Record.prototype, {
    /**
     * Offline, refuses the save of a CRM transient record (a CRM wizard, the CRM
     * settings, a CRM bound mail composer, a mail wizard of the lead chatter, a
     * settings record a CRM-owned control runs on) or of a record of a lead's meeting
     * form or dialog before its `web_save` request, whatever calls it (a button, the
     * settings' "Unsaved changes" confirmation, a direct `save()`): nothing is
     * requested or queued, and the record keeps its changes.
     *
     * @returns {Promise<boolean>}
     */
    _save() {
        if (isCrmOfflineTransientRecord(this) && this.model.offlinePlugin.isOffline()) {
            return Promise.resolve(false);
        }
        return super._save(...arguments);
    },

    /**
     * Never queues the save of a CRM transient record or of a lead's meeting: a save
     * whose request loses the connection fails instead, and the record keeps its
     * changes.
     *
     * @returns {boolean}
     */
    _offlineSave() {
        if (isCrmOfflineTransientRecord(this)) {
            return false;
        }
        return super._offlineSave(...arguments);
    },
});

patch(FormController.prototype, {
    /**
     * Offline, stops a button of a CRM wizard, of the CRM settings, of a CRM bound
     * mail composer (its Send included), of a mail wizard of the lead chatter (the
     * full composer's Send, the followers wizard's Add) or of a lead's meeting form
     * (its "Send email" and invitation buttons) before the form saves its record,
     * which would queue a transient or meeting `web_save` (such records are never
     * queued), and before the button's own call. `special="cancel"` buttons go on, so
     * a wizard's Cancel still closes it.
     *
     * @param {Object} clickParams
     * @returns {Promise<boolean|undefined>}
     */
    beforeExecuteActionButton(clickParams) {
        if (
            isCrmOfflineTransientForm(
                this.props.resModel,
                this.props.context,
                this.env.config?.actionXmlId
            ) &&
            clickParams?.special !== "cancel" &&
            this.offlinePlugin.isOffline()
        ) {
            return Promise.resolve(false);
        }
        return super.beforeExecuteActionButton(...arguments);
    },

    /**
     * The Action-menu items of a lead's meeting form (Archive, Unarchive and Delete
     * included) lose `availableOffline`, so the menu dims them offline: each writes
     * the meeting, which is never queued, and the Action-menu guard refuses them.
     * The menu reads `availableOffline` only offline, so online it is unchanged.
     *
     * @returns {Object}
     */
    getStaticActionMenuItems() {
        const items = super.getStaticActionMenuItems(...arguments);
        if (
            !isCrmOfflineMeeting(
                this.props.resModel,
                this.props.context,
                this.env.config?.actionXmlId
            )
        ) {
            return items;
        }
        return Object.fromEntries(
            Object.entries(items).map(([key, item]) => [key, omit(item, "availableOffline")])
        );
    },
});

patch(MailComposerFormRenderer.prototype, {
    /**
     * Offline, a CRM mail composer (`isCrmOfflineTransientRecord`: a CRM bound
     * composer, the lead chatter's full composer) closes from its dialog's close
     * control. Mail runs, before the dialog closes, a `res.partner` read that carries
     * the composer's recipients back to the thread; offline it fails and the dialog
     * would stay open, with its Discard disabled. That read is skipped offline, so the
     * thread keeps the recipients it had when the composer opened. Online, and for
     * every other composer, the dialog closes as mail does.
     */
    setup() {
        super.setup(...arguments);
        const dialogData = this.env.dialogData;
        const dismiss = dialogData?.dismiss;
        if (typeof dismiss !== "function") {
            return;
        }
        const renderer = this;
        dialogData.dismiss = function crmOfflineComposerDismiss() {
            const { record } = renderer.props;
            if (isCrmOfflineTransientRecord(record) && record.model.offlinePlugin.isOffline()) {
                return Promise.resolve();
            }
            return dismiss.apply(this, arguments);
        };
    },
});

patch(SettingsFormController.prototype, {
    /** Reads the CRM-owned controls of the page's arch once. */
    setup() {
        super.setup(...arguments);
        this.crmSettingsButtonKeys = getCrmSettingsButtonKeys(this.archInfo.xmlDoc);
    },

    /**
     * The settings controller saves its record itself, without the form controller's
     * method, so the guard is repeated here. Offline, it stops before the record is
     * saved and before any "Unsaved changes" confirmation opens: every button of the
     * CRM settings page (the control panel Save, `execute`, included); a CRM-owned
     * control (`getCrmSettingsButtonKeys`) on any settings page, such as the CRM app
     * of the General Settings; and any button on a record a CRM-owned control runs
     * on, such as the Save of the confirmation that control opened online. Online, a
     * CRM-owned control runs marked (`runCrmSettingsControl`). The "cancel" button
     * (the control panel Discard) saves nothing and goes on.
     *
     * @param {Object} clickParams
     * @returns {Promise<boolean|undefined>}
     */
    beforeExecuteActionButton(clickParams) {
        if (clickParams?.name === "cancel") {
            return super.beforeExecuteActionButton(...arguments);
        }
        const isCrmControl = this.crmSettingsButtonKeys.has(
            settingsButtonKey(clickParams?.type, clickParams?.name)
        );
        if (
            (isCrmControl ||
                isCrmSettingsControlRun(this.model.root) ||
                isCrmOfflineTransientForm(
                    this.props.resModel,
                    this.props.context,
                    this.env.config?.actionXmlId
                )) &&
            this.offlinePlugin.isOffline()
        ) {
            return Promise.resolve(false);
        }
        if (!isCrmControl) {
            return super.beforeExecuteActionButton(...arguments);
        }
        return runCrmSettingsControl(this.model.root, this.offlinePlugin, () =>
            super.beforeExecuteActionButton(...arguments)
        );
    },
});

patch(settingsFormView.Model.prototype, {
    /**
     * Offline, skips a reload of the loaded CRM settings page, with no request: the
     * settings model reads no cache, so its `onchange` would fail, and the dialog whose
     * closing reloads the page (a wizard opened from a settings button) would stay
     * open. The page keeps its values. The first load is left to the original: the
     * view-mount guard already keeps the CRM settings from loading offline.
     *
     * @param {Object} [params]
     * @returns {Promise<void>}
     */
    load(params) {
        if (
            isCrmOfflineTransientForm(
                this.config.resModel,
                this.config.context,
                this.env.config?.actionXmlId
            ) &&
            this.isReady() &&
            this.offlinePlugin.isOffline()
        ) {
            return Promise.resolve();
        }
        return super.load(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Guard: Sales Team form buttons
// -----------------------------------------------------------------------------

const patchedTeamFormControllers = new WeakSet();

/**
 * Offline, the Sales Team form's controller (`crm_team_form`, used by the team and
 * the team member forms) refuses, before its parent runs:
 *
 * - the multi-membership activation, before its manager probe (`user.hasGroup`) and
 *   its `set_bool` call;
 * - every non-special `object` or `action` button of a `crm.team` record, such as
 *   `action_assign_leads` and `action_open_opportunities`. The form controller saves
 *   the record before running any such button, and offline that save would queue the
 *   team's unsaved edits as a `crm.team` `web_save` before the action service's
 *   button guard is reached.
 *
 * Nothing is saved, discarded or queued, so the form keeps its entered values.
 * Special buttons (`save`, `cancel`) and every call online go to the parent.
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
            if (
                this.props.resModel === "crm.team" &&
                !clickParams?.special &&
                ["object", "action"].includes(clickParams?.type) &&
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
