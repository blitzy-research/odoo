import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { registry } from "@web/core/registry";
import { formView } from "@web/views/form/form_view";

import {
    computed,
    markRaw,
    onMounted,
    status,
    toRaw,
    untrack,
    useEffect,
    usePlugin,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { usePopover } from "@web/core/popover/popover_hook";
import { patch } from "@web/core/utils/patch";
import {
    addFieldDependencies,
    getScheduleORMExtras,
    makeActiveField,
} from "@web/model/relational_model/utils";
import {
    RottingStatusBarDurationField,
    rottingStatusBarDurationField,
} from "@mail/js/rotting_mixin/rotting_statusbar";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { Composer } from "@mail/core/common/composer";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";
import { CrmMobileLeadActivities } from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";

/**
 * Lead form (`js_class="crm_form"`) and its offline behaviour.
 *
 * Online, and on a wide screen, the lead form behaves exactly as before: every
 * addition below checks the connection (and, for mobile code, the small-screen
 * signal) and otherwise defers to the framework. Offline it consumes the framework
 * offline plugin only (`OfflinePlugin` through `usePlugin` or the model's
 * `offlinePlugin`, and the shared `useCrmOffline()` hooks); it owns no queue, cache
 * or store of its own:
 * - the post-save rainbowman lookup is skipped (decorative read);
 * - "Won" queues `action_set_won` and shows the lead as won locally;
 * - archive, unarchive and delete, queued by the framework, show their result at
 *   once, and that state is re-applied while the queued call waits;
 * - every other `object`/`action` button of the lead form is inert;
 * - on a phone the form loads the lead's activity rows with its own (cached) root
 *   load and opens the mobile activity sheet from the control panel;
 * - the chatter and composer of a lead are read-only.
 */

/** Values the lead shows once won, applied locally (never saved) while offline. */
const OFFLINE_WON_VALUES = Object.freeze({ won_status: "won", probability: 100 });

/** `crm.lead` methods whose queued call puts the lead in its archived/unarchived state. */
const ARCHIVE_METHODS = Object.freeze(["action_archive", "action_unarchive"]);

/**
 * Orders queue entries as the framework replays them (`extras.timeStamp`).
 *
 * @param {{value: {extras?: {timeStamp?: number}}}} a
 * @param {{value: {extras?: {timeStamp?: number}}}} b
 */
function byTimeStamp(a, b) {
    return (a.value.extras?.timeStamp || 0) - (b.value.extras?.timeStamp || 0);
}

class CrmFormRecord extends formView.Model.Record {
     /**
     * override of record _save mechanism intended to affect the main form record
     * We check if the stage_id field was altered and if we need to display a rainbowman
     * message.
     *
     * This method will also simulate a real "force_save" on the email and phone
     * when needed. The "force_save" attribute only works on readonly field. For our
     * use case, we need to write the email and the phone even if the user didn't
     * change them, to synchronize those values with the partner (so the email / phone
     * inverse method can be called).
     *
     * We base this synchronization on the value of "partner_phone_update"
     * and "partner_email_update", which are computed fields that hold a value
     * whenever we need to synch.
     *
     * @override
     */
    async _save() {
        if (this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        let changeStage = false;
        const needsSynchronizationEmail =
            this._changes.partner_email_update === undefined
                ? this._values.partner_email_update // original value
                : this._changes.partner_email_update; // new value

        const needsSynchronizationPhone =
            this._changes.partner_phone_update === undefined
                ? this._values.partner_phone_update // original value
                : this._changes.partner_phone_update; // new value

        if (needsSynchronizationEmail && this._changes.email_from === undefined && this._values.email_from) {
            this._changes.email_from = this._values.email_from;
        }
        if (needsSynchronizationPhone && this._changes.phone === undefined && this._values.phone) {
            this._changes.phone = this._values.phone;
        }

        if ("stage_id" in this._changes) {
            changeStage = this._values.stage_id !== this.data.stage_id;
        }

        const res = await super._save(...arguments);
        // The rainbowman lookup is decorative: offline it is neither issued nor queued.
        // The signal is read after the save, because a connection lost during the save
        // turns the plugin offline before the queued (offline) save resolves.
        if (res && changeStage && !this.model.offlinePlugin.isOffline()) {
            await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);
        }
        return res;
    }

    /**
     * Shows the lead as won while its queued `action_set_won` waits for replay.
     *
     * The values are applied with `_applyValues`, which writes the record's values
     * without registering a change, so nothing is saved: `won_status` is computed
     * and `probability` is readonly once the lead is won. Because they are in the
     * record's values, a later offline save of other fields keeps them. Fields the
     * form does not load are skipped.
     */
    applyOfflineWon() {
        const values = {};
        for (const [fieldName, value] of Object.entries(OFFLINE_WON_VALUES)) {
            if (fieldName in this.activeFields) {
                values[fieldName] = value;
            }
        }
        if (Object.keys(values).length) {
            this._applyValues(values);
        }
    }

    /**
     * @override
     * Offline, the framework queues `action_archive`/`action_unarchive` and returns
     * the queue key without changing `active`; the lead then shows its new state at
     * once (ribbon, Archive/Unarchive items), without registering a change. Online
     * the parent reloads the record, as before.
     *
     * @param {boolean} isArchive
     */
    async _toggleArchive(isArchive) {
        const res = await super._toggleArchive(...arguments);
        if (
            this.resModel === "crm.lead" &&
            typeof res === "string" &&
            res in this.model.offlinePlugin._ormToSync() &&
            "active" in this.activeFields
        ) {
            this._applyValues({ active: !isArchive });
        }
        return res;
    }
}

class CrmFormModel extends formView.Model {
    static Record = CrmFormRecord;
    static services = [...formView.Model.services, "effect"];

    setup(params, services) {
        super.setup(...arguments);
        this.effect = services.effect;
    }

    /**
     * @override
     * Offline on a phone, the mobile variant of the root load (with the lead's
     * activity rows) may never have been cached, while a wide-layout visit cached
     * the desktop one. When the controller's `crmUseDesktopSpec` hook accepts it, the
     * load is retried once: `onWillLoadRoot` then applies the desktop variant before
     * the cache key is computed. Forms without the hook are unaffected.
     */
    async load(params = {}) {
        try {
            return await super.load(...arguments);
        } catch (e) {
            if (e instanceof ConnectionLostError && this.hooks.crmUseDesktopSpec?.()) {
                return super.load(...arguments);
            }
            throw e;
        }
    }
}

/**
 * `mail.activity` sub-fields loaded with `activity_ids` by the phone variant of the
 * lead form, the same ones the mobile pipeline loads, so the activity sheet lists
 * the lead's rows from the form's own (cached) root load.
 */
const ACTIVITY_SUBFIELDS = Object.freeze([
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
 * Builds a fresh `related` structure (`{activeFields, fields}`, the shape the
 * relational model uses for x2many sub-fields) for the lead's `activity_ids`.
 * Every call returns new, mutable objects: the model owns what it is given.
 *
 * @returns {{activeFields: Object, fields: Object}}
 */
function crmActivityRelated() {
    const activeFields = {};
    const fields = {};
    for (const field of ACTIVITY_SUBFIELDS) {
        activeFields[field.name] = makeActiveField({ readonly: true });
        fields[field.name] = { ...field, readonly: true };
        if (field.selection) {
            fields[field.name].selection = field.selection.map((option) => [...option]);
        }
    }
    return { activeFields, fields };
}

/**
 * Controller of the lead form (template `crm.CrmFormView`, a `primary` inherit of
 * `web.FormView` that adds the phone "Activities" button to the control panel).
 *
 * Offline it is the execution boundary of the lead form's buttons: "Won" is queued
 * as `action_set_won` (never `action_set_won_rainbowman`) and every other
 * `object`/`action` button is inert. It keeps the local state of the lead's queued
 * won, archive and delete while their calls wait, and reloads the lead from the
 * server (or the cache offline) when they leave the queue by replay or discard;
 * parked (rejected) entries stay queued, so their local state stays and the
 * offline systray shows the error.
 *
 * On a phone the root load also requests the lead's activity rows ("mobile
 * variant"); otherwise it requests exactly what the arch declares ("desktop
 * variant", the current specification). Offline, when the mobile variant was never
 * cached, the load is retried once with the desktop variant.
 */
export class CrmFormController extends formView.Controller {
    static template = "crm.CrmFormView";

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.crmActivitiesSheet = usePopover(CrmMobileLeadActivities, { useBottomSheet: true });

        /** Offline fallback to the desktop variant of the root load is active. */
        this.crmDesktopFallback = false;
        /** @type {"mobile"|"desktop"} variant applied to the last root load */
        this.crmLastVariant = "desktop";
        /** Queue keys of this lead's writes (own offline save, won, archive, delete). */
        this.crmOwnKeys = new Set();
        this.crmMounted = false;
        this.crmPendingHistoryBack = false;
        this.crmHistoryBackDone = false;
        /** The lead form arch declares no `activity_ids`: only the mobile variant adds it. */
        this.crmArchHasActivities = Object.values(this.archInfo.fieldNodes || {}).some(
            (fieldNode) => fieldNode.name === "activity_ids"
        );

        onMounted(() => {
            this.crmMounted = true;
            if (this.crmPendingHistoryBack) {
                // The action service commits its controller stack in the `onMounted` of
                // the action's wrapper component, which runs after this one. Going back
                // before that would read a stack without this form, leaving it mounted
                // behind the restored view (where a later reload reads the deleted
                // lead), so the form is left once the mount has completed.
                Promise.resolve().then(() => {
                    if (status(this) === "mounted") {
                        this.crmLeaveDeletedLead();
                    }
                });
            }
            this.crmWarmActivityTypes();
        });
        // A mounted form that turns small while online (or comes back online on a
        // phone) caches the activity types too; the hook warms once per session.
        useEffect(() => {
            const isSmall = this.crmOffline.isSmall;
            const isOffline = this.crmOffline.isOffline();
            if (this.crmMounted && isSmall && !isOffline) {
                untrack(() => this.crmWarmActivityTypes());
            }
        });

        // Remember the queue keys concerning the displayed lead whenever the queue
        // changes. The queue is read first: it is the signal this effect follows (the
        // model assigns its root outside any proxy, so root changes are covered by
        // `onRootLoaded` instead).
        useEffect(() => {
            this.crmOffline.queuedEntries("crm.lead");
            untrack(() => this.crmTrackOwnKeys());
        });

        // After a replay that left none of them queued, the server values replace the
        // local presentation (won, archived).
        this.crmOffline.onReplayed(() => {
            if (
                this.crmOwnKeys.size &&
                [...this.crmOwnKeys].every((key) => !this.crmOffline.isQueued(key))
            ) {
                this.crmOwnKeys.clear();
                this.crmReload({ edits: "save" });
            }
        });
        // A discarded won, archive or edit reverts (from the cache when offline).
        this.crmOffline.onEntriesDiscarded("crm.lead", (keys) => {
            const ownKeys = keys.filter((key) => this.crmOwnKeys.has(key));
            if (ownKeys.length) {
                for (const key of ownKeys) {
                    this.crmOwnKeys.delete(key);
                }
                this.crmReload();
            }
        });

        // Back online while the desktop-variant fallback is active: load the mobile
        // variant again.
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            if (!isOffline && this.crmDesktopFallback) {
                this.crmDesktopFallback = false;
                untrack(() => this.crmReload({ edits: "keep" }));
            }
        });
    }

    /**
     * @override
     * Adds `crmUseDesktopSpec`, consumed by `CrmFormModel.load`, to the parent's hooks.
     */
    get modelParams() {
        const params = super.modelParams;
        params.hooks.crmUseDesktopSpec = () => this.crmUseDesktopSpec();
        return params;
    }

    /**
     * Called when a root load failed with a lost connection. Returns `true` once,
     * when that load used the mobile variant offline on a phone: the model then
     * retries with the desktop variant, which a wide-layout visit may have cached.
     *
     * @returns {boolean}
     */
    crmUseDesktopSpec() {
        if (
            this.crmOffline.isSmall &&
            this.crmOffline.isOffline() &&
            this.crmLastVariant === "mobile" &&
            !this.crmDesktopFallback
        ) {
            this.crmDesktopFallback = true;
            return true;
        }
        return false;
    }

    /**
     * Phone only, online: caches the CRM activity types for the offline activity
     * sheet (a mobile-only request; failures are ignored by the hook).
     */
    crmWarmActivityTypes() {
        if (
            this.props.resModel === "crm.lead" &&
            this.crmOffline.isSmall &&
            !this.crmOffline.isOffline()
        ) {
            this.crmOffline.warmActivityTypes();
        }
    }

    /**
     * Reloads the lead (from the cache when offline). A load lost to the connection
     * resolves: CRM code adds no uncaught error offline.
     *
     * Unsaved edits of the form (`edits`):
     * - `"drop"` (discard reconciliation): reloaded anyway, so the changes of a
     *   discarded queued save, restored into the form on reopening, are not kept
     *   and queued again by a later save;
     * - `"save"` (replay reconciliation, online): saved instead, which reloads the
     *   lead with the server values without losing what the user typed meanwhile;
     * - `"keep"` (end of the offline fallback): left as they are; the next load
     *   applies the phone variant.
     *
     * @param {{edits?: "drop"|"save"|"keep"}} [options]
     */
    async crmReload({ edits = "drop" } = {}) {
        if (!this.model.isReady()) {
            return;
        }
        const root = this.model.root;
        if (edits !== "drop" && root && (await root.isDirty())) {
            if (edits === "save") {
                await root.save();
            }
            return;
        }
        try {
            await this.model.load();
        } catch (e) {
            if (!(e instanceof ConnectionLostError)) {
                throw e;
            }
        }
    }

    /**
     * Adds to `crmOwnKeys` the queued calls concerning the displayed lead:
     * - its own offline save (`offlineId`) and every `crm.lead` call targeting its id;
     * - the `mail.activity` calls of its activity sheet: a create on the lead, and
     *   "mark done" of one of its loaded activities. Their replay reloads the lead,
     *   so the open sheet lists the synced rows.
     */
    crmTrackOwnKeys() {
        const root = this.model.root;
        if (this.props.resModel !== "crm.lead" || !root) {
            return;
        }
        const { offlineId, resId } = root;
        for (const { key, value } of this.crmOffline.queuedEntries("crm.lead")) {
            if ((offlineId && key === offlineId) || (resId && value.args?.[0]?.includes?.(resId))) {
                this.crmOwnKeys.add(key);
            }
        }
        if (!resId) {
            return;
        }
        const activityIds = (root.data.activity_ids?.records || []).map((record) => record.resId);
        for (const { key, value } of this.crmOffline.queuedEntries("mail.activity")) {
            const createVals = value.method === "create" && value.args?.[0]?.[0];
            const isLeadCreate =
                Boolean(createVals) &&
                createVals.res_model === "crm.lead" &&
                createVals.res_id === resId;
            const isLeadDone =
                value.method === "action_done" &&
                activityIds.some((id) => value.args?.[0]?.includes?.(id));
            if (isLeadCreate || isLeadDone) {
                this.crmOwnKeys.add(key);
            }
        }
    }

    /**
     * Queued `crm.lead` calls targeting `resId` (pending and parked).
     *
     * @param {number} resId
     */
    crmEntriesFor(resId) {
        return this.crmOffline
            .queuedEntries("crm.lead")
            .filter(({ value }) => value.args?.[0]?.includes?.(resId));
    }

    /**
     * First pending (not parked) queued call of `methods` targeting `resId`.
     *
     * @param {number} resId
     * @param {string[]} methods
     */
    crmFindPending(resId, methods) {
        return this.crmEntriesFor(resId).find(
            ({ value }) => methods.includes(value.method) && !value.extras?.error
        );
    }

    /** Leaves the form of a lead whose delete is queued (once). */
    crmLeaveDeletedLead() {
        this.crmPendingHistoryBack = false;
        if (this.crmHistoryBackDone) {
            return;
        }
        this.crmHistoryBackDone = true;
        this.env.config.historyBack();
    }

    /**
     * @override
     * The lead form's offline execution boundary for `object`/`action` buttons.
     * Special buttons (`save`, `cancel`), other button types and everything online
     * go to the parent.
     */
    async beforeExecuteActionButton(clickParams) {
        if (
            this.props.resModel !== "crm.lead" ||
            clickParams.special ||
            !["object", "action"].includes(clickParams.type) ||
            !this.crmOffline.isOffline()
        ) {
            return super.beforeExecuteActionButton(...arguments);
        }
        if (clickParams.name === "action_set_won_rainbowman") {
            return this.crmQueueMarkWon();
        }
        // Convert, Lost, Restore, Schedule Meeting, Similar Leads, blacklist removal,
        // automated probability...: no save, no `call_button`.
        return false;
    }

    /**
     * Offline "Won": saves pending edits (queued as their own `web_save`), queues
     * `action_set_won` (the server picks the won stage at replay; no rainbowman
     * lookup) and shows the lead as won. Returns `false` so the button stops here.
     *
     * @returns {Promise<false>}
     */
    async crmQueueMarkWon() {
        const root = this.model.root;
        if (!(await root.save())) {
            return false;
        }
        if (!root.resId) {
            return false;
        }
        const extras = getScheduleORMExtras(this.model, [root]);
        // Replay follows `extras.timeStamp`: the won call must come after every lead
        // write queued before it (e.g. a stage set by the save above), even when the
        // clock has not moved since.
        for (const { value } of this.crmEntriesFor(root.resId)) {
            extras.timeStamp = Math.max(extras.timeStamp, (value.extras?.timeStamp || 0) + 1);
        }
        const key = this.model.offlinePlugin.scheduleORM(
            "crm.lead",
            "action_set_won",
            [[root.resId]],
            { context: root.context },
            { extras }
        );
        this.crmOwnKeys.add(key);
        root.applyOfflineWon();
        return false;
    }

    /**
     * @override
     * Runs the parent's confirmation. Offline, the framework queues the `unlink` and
     * keeps the record: the form is then left at once, the exit the online path
     * takes when no record remains.
     */
    get deleteConfirmationDialogProps() {
        const dialogProps = super.deleteConfirmationDialogProps;
        const confirm = dialogProps.confirm;
        return {
            ...dialogProps,
            confirm: async () => {
                await confirm();
                const root = this.model.root;
                if (
                    this.props.resModel !== "crm.lead" ||
                    !root?.resId ||
                    !this.crmOffline.isOffline()
                ) {
                    return;
                }
                const entry = this.crmFindPending(root.resId, ["unlink"]);
                if (entry) {
                    this.crmOwnKeys.add(entry.key);
                    this.crmLeaveDeletedLead();
                }
            },
        };
    }

    /**
     * @override
     * Re-applies the local state of the lead's queued calls after every root load,
     * so it survives reopening the lead while they wait:
     * - a queued `action_set_won` (pending or parked) shows the lead as won;
     * - the latest queued archive/unarchive sets `active` to the value it will set;
     * - a pending (not parked) `unlink` leaves the form (lead reached by URL or
     *   breadcrumb), once it is mounted.
     */
    async onRootLoaded() {
        await super.onRootLoaded(...arguments);
        const root = this.model.root;
        if (this.props.resModel !== "crm.lead" || !root?.resId) {
            return;
        }
        this.crmTrackOwnKeys();
        const entries = this.crmEntriesFor(root.resId);
        if (entries.some(({ value }) => value.method === "action_set_won")) {
            root.applyOfflineWon();
        }
        const archiveEntry = entries
            .filter(({ value }) => ARCHIVE_METHODS.includes(value.method))
            .sort(byTimeStamp)
            .at(-1);
        if (archiveEntry && "active" in root.activeFields) {
            root._applyValues({ active: archiveEntry.value.method === "action_unarchive" });
        }
        // In a dialog, going back would leave the underlying action instead.
        if (!this.env.inDialog && this.crmFindPending(root.resId, ["unlink"])) {
            this.crmPendingHistoryBack = true;
            if (this.crmMounted) {
                this.crmLeaveDeletedLead();
            }
        }
    }

    /**
     * @override
     * Applies the load-specification variant before every root load (first load,
     * reloads, pager moves), i.e. before its cache key is computed. The phone
     * variant adds `activity_ids` with the activity sheet's sub-fields; the desktop
     * variant is exactly what the arch declares. `config.activeFields` is replaced by
     * a fresh object, never mutated, and `config.fields` is left as it is.
     *
     * @param {Object} config root configuration about to be loaded
     */
    onWillLoadRoot(config) {
        super.onWillLoadRoot(...arguments);
        // A save that reloads passes the root's own configuration, after its
        // `web_save` was requested with the current fields: the result is parsed with
        // them, so they must not change here.
        if (!config || (this.model.root && toRaw(config) === toRaw(this.model.root.config))) {
            return;
        }
        if (!this.crmOffline.isOffline()) {
            this.crmDesktopFallback = false;
        }
        const currentActiveFields = toRaw(config.activeFields);
        // An arch declaring `activity_ids` itself keeps its own declaration.
        const hasField =
            !this.crmArchHasActivities &&
            Boolean(currentActiveFields) &&
            config.fields?.activity_ids?.type === "one2many";
        const mobile =
            this.crmOffline.isSmall &&
            !this.crmDesktopFallback &&
            hasField &&
            config.resModel === "crm.lead";
        this.crmLastVariant = mobile ? "mobile" : "desktop";
        if (this.crmArchHasActivities || !currentActiveFields) {
            return;
        }
        // The arch declares no `activity_ids`, so an entry present was added here.
        if (!mobile && !("activity_ids" in currentActiveFields)) {
            return; // desktop variant already: the specification stays untouched
        }
        const activeFields = { ...currentActiveFields };
        delete activeFields.activity_ids;
        if (mobile) {
            addFieldDependencies(activeFields, toRaw(config.fields), [
                {
                    name: "activity_ids",
                    type: "one2many",
                    relation: "mail.activity",
                    readonly: true,
                },
            ]);
            activeFields.activity_ids = {
                ...activeFields.activity_ids,
                related: crmActivityRelated(),
            };
        }
        config.activeFields = markRaw(activeFields);
    }

    /**
     * Opens the mobile activity sheet of the displayed lead (phone "Activities"
     * button). The sheet reads the form's current root on every render, so it
     * follows reloads; it closes when the form shows another record.
     *
     * @param {MouseEvent} ev
     */
    openMobileActivities(ev) {
        const leadId = this.model.root.resId;
        if (!leadId) {
            return;
        }
        this.crmActivitiesSheet.open(ev.currentTarget, {
            leadId,
            getLeadRecord: () => (this.model.root?.resId === leadId ? this.model.root : null),
            model: this.model,
            callTypeId: this.crmOffline.callTypeId(this.archInfo),
        });
    }
}

registry.category("views").add("crm_form", {
    ...formView,
    Model: CrmFormModel,
    Controller: CrmFormController,
});

/**
 * Stage statusbar of the lead form (`crm_form.rotting_statusbar_duration`, resolved
 * before `rotting_statusbar_duration` for this `js_class` only). Its template adds
 * `data-available-offline` to every statusbar button and dropdown stage item, so a
 * stage can be chosen offline (the change is queued by the record's offline save).
 * The attribute has no effect online.
 */
export class CrmStatusBarField extends RottingStatusBarDurationField {
    static template = "crm.RottingStatusBarDurationField";
}

registry.category("fields").add("crm_form.rotting_statusbar_duration", {
    ...rottingStatusBarDurationField,
    component: CrmStatusBarField,
});

/**
 * Badges of the CRM calls the framework's offline systray does not know. The
 * systray gives a status only to `web_save`, `unlink`, `action_archive` and
 * `action_unarchive` entries, and its template reads `status.color` and
 * `status.label` of every entry, so opening it with a queued "Won" or a queued
 * activity of the lead activity sheet would fail. Only those CRM entries, when
 * they have no status yet, get one; every other entry is left as it is.
 */
const CRM_QUEUED_CALL_STATUS = Object.freeze({
    "crm.lead": Object.freeze({
        action_set_won: Object.freeze({ label: _t("Won"), color: 10 }),
    }),
    "mail.activity": Object.freeze({
        create: Object.freeze({ label: _t("Activity scheduled"), color: 8 }),
        action_done: Object.freeze({ label: _t("Activity done"), color: 7 }),
    }),
});

const offlineSystrayItem = registry.category("systray").get("offline", null);
if (offlineSystrayItem) {
    patch(offlineSystrayItem.Component.prototype, {
        setup() {
            super.setup(...arguments);
            // `groupEntries` is a computed instance field: wrap it, keeping its sections.
            const groupEntries = this.groupEntries;
            this.groupEntries = computed(() => {
                const sections = groupEntries();
                const queue = this.offlinePlugin._ormToSync();
                for (const [, items] of sections) {
                    for (const item of items) {
                        const value = queue[item.id]?.value;
                        if (!item.status && value) {
                            const status = CRM_QUEUED_CALL_STATUS[value.model]?.[value.method];
                            if (status) {
                                item.status = status;
                            }
                        }
                    }
                }
                return sections;
            });
        },
    });
}

/**
 * Lead chatter read-only offline. Scoped to `crm.lead` threads, checked before the
 * offline signal is read, so other chatters neither subscribe to it nor change.
 * Its Send, Log note, Activities, attachment and follow controls are buttons, which
 * the framework already disables offline.
 */
patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
        // Close an open composer when the connection drops.
        useEffect(() => {
            if (this.threadModel() !== "crm.lead") {
                return;
            }
            if (this.crmOfflinePlugin.isOffline() && this.state.composerType) {
                this.state.composerType = false;
            }
        });
    },

    /**
     * @override
     * Offline, a lead thread fetches nothing: it shows the messages already in the
     * store, and resolves (no rejection, no error).
     */
    async load(thread, requestList) {
        // This Chatter has no `props` object: its `threadModel` prop is read through
        // the `propComputed` accessor `this.threadModel()`.
        const threadModel = thread?.model ?? this.threadModel();
        if (threadModel === "crm.lead" && this.crmOfflinePlugin.isOffline()) {
            return;
        }
        return super.load(...arguments);
    },
});

/**
 * A lead composer posts nothing offline, even when its handlers are called
 * directly. Other threads, and every online call, go to the original code.
 */
patch(Composer.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** Scope first (lead thread), then the offline signal. */
    get crmOfflineReadOnly() {
        return (
            this.props.composer?.thread?.model === "crm.lead" && this.crmOfflinePlugin.isOffline()
        );
    },

    /** @override */
    onKeydown(ev) {
        if (this.crmOfflineReadOnly) {
            if (ev.key === "Enter") {
                ev.preventDefault();
            }
            return;
        }
        return super.onKeydown(...arguments);
    },

    /** @override */
    async sendMessage() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.sendMessage(...arguments);
    },
});
