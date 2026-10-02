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
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    crmReportError,
    getCrmActivityLimit,
    getCrmActivitySubfields,
    setCrmActivityLimit,
    useCrmOffline,
} from "@crm/mobile/crm_offline_hooks";
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

/** Field types whose record value is a list (its change is a list of commands). */
const X2MANY_TYPES = Object.freeze(["one2many", "many2many"]);

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
     *
     * The record shows its changes over its values, so a change of these fields
     * (such as a probability restored from the lead's queued save when the lead is
     * reopened) would hide the won values: it is dropped from the form's changes.
     * The queued save is left as it is (the won call replays after it), and nothing
     * is saved.
     */
    applyOfflineWon() {
        const values = {};
        for (const [fieldName, value] of Object.entries(OFFLINE_WON_VALUES)) {
            if (fieldName in this.activeFields) {
                values[fieldName] = value;
            }
        }
        if (!Object.keys(values).length) {
            return;
        }
        for (const fieldName in values) {
            delete this._changes[fieldName];
        }
        if (!Object.keys(this._changes).length) {
            this.dirty = false;
        }
        this._applyValues(values);
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

    /**
     * @override
     * Before the onchange request of the form's root is built (its changes, which
     * hold every value of a new record, and its specification), the controller's
     * `crmLeaveMobileVariant` hook gives the root the desktop variant when the
     * screen widened since its phone load. Other records and forms without the hook
     * are unaffected.
     */
    _getOnchangeValues() {
        if (toRaw(this.model.root) === toRaw(this)) {
            this.model.hooks.crmLeaveMobileVariant?.(this.config);
        }
        return super._getOnchangeValues(...arguments);
    }

    /**
     * Forgets the loaded value of `fieldName`, a field the record's configuration
     * stops loading (`CrmFormController.crmLeaveMobileVariant`), so that the record
     * holds the values of its loaded fields only, as after a load: the values of a
     * new record are part of its changes, and each x2many value needs its field in
     * `activeFields` to build the evaluation context. Unsaved changes are kept: a
     * field with a change is not forgotten.
     *
     * @param {string} fieldName
     * @returns {boolean} whether the record no longer holds a value of `fieldName`
     */
    crmForgetLoadedValue(fieldName) {
        if (fieldName in this._changes) {
            return false;
        }
        delete this._values[fieldName];
        delete this.data[fieldName];
        delete this._textValues[fieldName];
        delete this._initialTextValues[fieldName];
        delete this.evalContext[fieldName];
        delete this.evalContextWithVirtualIds[fieldName];
        this._removeInvalidFields(fieldName);
        return true;
    }

    /**
     * Whether a `crmRefresh` load of this record runs: the root reload must not
     * restore the lead's queued save into the form again, because the form kept
     * its changes (restoring them would overwrite later edits of the same fields).
     *
     * @returns {boolean}
     */
    get crmRefreshing() {
        return Boolean(this._crmRefreshState) && !this._crmRefreshState.saving;
    }

    /**
     * Refreshes the lead with the server values (the cache offline) through the
     * model's own root-load machinery (the controller's load variant, the RPC cache
     * and `onRootLoaded`), keeping the form's unsaved changes. It runs in the model
     * mutex and replaces no record, so an edit or a save made meanwhile waits behind
     * it and applies to the refreshed record. Nothing happens once the model shows
     * another record.
     *
     * - `dropRestored`: the changes still holding the value the form restored from
     *   the record's queued save are dropped instead of kept (that save left the
     *   queue: replayed, its values are the server's; discarded, they must not be
     *   queued again by a later save);
     * - `save` (online, a lead with an id): once the lead is refreshed, the changes
     *   it kept, when there are any, are saved. The save starts from the refreshed
     *   values, so what the CRM save adds from them (the email and phone to
     *   synchronize with the partner) is the server's current state, never a value
     *   from before the refresh. When the save does not happen (invalid record), the
     *   changes stay in the form, unsaved.
     *
     * A request made while another one waits to start is merged into it.
     *
     * @param {{dropRestored?: boolean, save?: boolean}} [options]
     * @returns {Promise<void>}
     */
    crmRefresh({ dropRestored = false, save = false } = {}) {
        const waiting = this._crmWaitingRefresh;
        if (waiting) {
            waiting.dropRestored ||= dropRestored;
            waiting.save ||= save;
            return waiting.promise;
        }
        const request = markRaw({ dropRestored, save, promise: null });
        const start = () => {
            if (this._crmWaitingRefresh === request) {
                this._crmWaitingRefresh = null;
            }
        };
        this._crmWaitingRefresh = request;
        // `_askChanges` (pending field values) waits until the mutex is free, so it is
        // awaited before entering it: inside, it would never resolve.
        request.promise = this.model._askChanges().then(
            () =>
                this.model.mutex.exec(() => {
                    start();
                    return this._crmRefresh(request);
                }),
            (error) => {
                start();
                throw error;
            }
        );
        return request.promise;
    }

    /**
     * Fields of the form's changes that still hold the value restored from the
     * record's queued save (`setOfflineChanges`): edited since, a field holds an
     * edit of the user instead.
     *
     * @returns {string[]}
     */
    crmRestoredUnmodifiedFields() {
        const restored = this._crmRestored;
        // The record replaces its changes object whenever it resets its changes
        // (load, save, discard): the restored values are then gone.
        if (!restored || restored.changes !== this._changes) {
            return [];
        }
        return Object.keys(restored.signatures).filter(
            (fieldName) =>
                fieldName in this._changes &&
                this._crmChangeSignature(fieldName) === restored.signatures[fieldName]
        );
    }

    /**
     * Makes the changes restored from the record's queued save the form's own
     * unsaved edits (the offline systray handed that save over to the form).
     */
    crmAdoptRestoredChanges() {
        this._crmRestored = null;
    }

    /**
     * @override
     * Remembers the changes the restoration of the lead's queued save put in the
     * form (with the values an onchange derived from them), so a reconciliation
     * can tell them from edits made afterwards.
     */
    setOfflineChanges() {
        const restoration = super.setOfflineChanges(...arguments);
        if (!restoration) {
            return restoration;
        }
        return restoration.then((result) => {
            const signatures = {};
            for (const fieldName in this._changes) {
                signatures[fieldName] = this._crmChangeSignature(fieldName);
            }
            this._crmRestored = markRaw({ changes: this._changes, signatures });
            return result;
        });
    }

    /**
     * @override
     * An offline save made after the record's previous one left the queue
     * (replayed or discarded) queues its own changes only, at its own time.
     */
    _offlineSave() {
        this._crmForgetUnqueuedOfflineSave();
        return super._offlineSave(...arguments);
    }

    /**
     * @override
     * During a `crmRefresh` load, the loaded values replace the record's values
     * while its unsaved changes are kept, except those the refresh drops. Values an
     * offline save of this record committed stay while that save is still queued
     * (pending or parked), as neither the server nor the cache has them yet. Every
     * other call (the record's creation, other loads, a save's reload) is the
     * parent's.
     */
    _setData(data, options = {}) {
        const refresh = this._crmRefreshState;
        if (!refresh || refresh.saving) {
            super._setData(...arguments);
            return;
        }
        for (const fieldName of refresh.dropFields) {
            delete this._changes[fieldName];
        }
        const queuedValues = this._crmQueuedSaveValues();
        super._setData(data, { ...options, keepChanges: true });
        Object.assign(this._values, queuedValues);
        const queuedTextValues = this._getTextValues(queuedValues);
        Object.assign(this._initialTextValues, queuedTextValues);
        Object.assign(this._textValues, queuedTextValues, this._getTextValues(this._changes));
        this.dirty = Object.keys(this._changes).length > 0;
        this.data = { ...this._values, ...this._changes };
        this._setEvalContext();
    }

    /**
     * Body of `crmRefresh`, run in the model mutex.
     *
     * @param {{dropRestored: boolean, save: boolean}} request
     */
    async _crmRefresh({ dropRestored, save }) {
        if (toRaw(this.model.root) !== toRaw(this)) {
            return;
        }
        this._crmForgetUnqueuedOfflineSave();
        const refresh = markRaw({
            dropFields: dropRestored ? this.crmRestoredUnmodifiedFields() : [],
            saving: false,
        });
        this._crmRefreshState = refresh;
        try {
            await this._load();
            if (save) {
                await this._crmSaveRefreshedChanges(refresh);
            }
        } finally {
            this._crmRefreshState = null;
        }
    }

    /**
     * Saves the changes the refresh load kept (`refresh.dropFields` were dropped),
     * through the CRM save, which starts from the refreshed values. It happens while
     * the model still shows this record, the lead has an id (a record without one
     * would be created again), the connection is still up after the load and at
     * least one change is written. A save that does not happen (invalid record)
     * leaves the changes in the form.
     *
     * @param {{dropFields: string[], saving: boolean}} refresh
     * @returns {Promise<void>}
     */
    async _crmSaveRefreshedChanges(refresh) {
        if (
            toRaw(this.model.root) !== toRaw(this) ||
            !this.resId ||
            this.model.offlinePlugin.isOffline()
        ) {
            return;
        }
        const toWrite = this._getChanges();
        delete toWrite.id;
        if (!Object.keys(toWrite).length) {
            return;
        }
        refresh.saving = true;
        await this._save();
    }

    /**
     * Comparable form of the change of `fieldName`: its commands for an x2many
     * field (the list object stays the same when edited), the value otherwise.
     *
     * @param {string} fieldName
     */
    _crmChangeSignature(fieldName) {
        const value = this._changes[fieldName];
        return X2MANY_TYPES.includes(this.fields[fieldName].type) && value
            ? JSON.stringify(value._getCommands())
            : value;
    }

    /** Whether the record's own offline save (`offlineId`) is queued (pending or parked). */
    _crmIsOwnSaveQueued() {
        return Boolean(this._offlineId) && this._offlineId in this.model.offlinePlugin._ormToSync();
    }

    /**
     * Forgets the changes and time stamp of the record's own offline save once it
     * left the queue, so they are neither queued again nor ordered at its old time
     * by a later offline save. The key is kept: the framework reuses it.
     */
    _crmForgetUnqueuedOfflineSave() {
        if (this._offlineChanges && !this._crmIsOwnSaveQueued()) {
            this._offlineChanges = undefined;
            this._offlineTimeStamp = undefined;
        }
    }

    /**
     * Values of the record's own still-queued offline save for the fields that
     * are not changes of the form: the queued value of a scalar field (a value the
     * form shows instead, such as the won probability, is applied again with the
     * queued state), the current list of an x2many field.
     *
     * @returns {Object}
     */
    _crmQueuedSaveValues() {
        const values = {};
        if (!this._offlineChanges || !this._crmIsOwnSaveQueued()) {
            return values;
        }
        for (const fieldName in this._offlineChanges) {
            if (fieldName in this._changes || !(fieldName in this.activeFields)) {
                continue;
            }
            values[fieldName] = X2MANY_TYPES.includes(this.fields[fieldName].type)
                ? this._values[fieldName]
                : this._offlineChanges[fieldName];
        }
        return values;
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
 * Builds a fresh `related` structure (`{activeFields, fields}`, the shape the
 * relational model uses for x2many sub-fields) for the lead's `activity_ids`
 * loaded by the phone variant of the lead form: the sub-fields the mobile pipeline
 * loads (`CRM_ACTIVITY_SUBFIELDS`), readonly, so the activity sheet lists the
 * lead's rows from the form's own (cached) root load. Every call returns new,
 * mutable objects: the model owns what it is given.
 *
 * @returns {{activeFields: Object, fields: Object}}
 */
function crmActivityRelated() {
    const activeFields = {};
    const fields = getCrmActivitySubfields({ readonly: true });
    for (const name of Object.keys(fields)) {
        activeFields[name] = makeActiveField({ readonly: true });
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
 * won, archive and delete while their calls wait, and refreshes the lead from the
 * server (or the cache offline), keeping the form's unsaved edits, when they leave
 * the queue by replay or discard; parked (rejected) entries stay queued, so their
 * local state stays and the offline systray shows the error.
 *
 * On a phone the root load also requests the lead's activity rows ("mobile
 * variant"); otherwise it requests exactly what the arch declares ("desktop
 * variant", the current specification). A root loaded on a phone takes the desktop
 * variant before its next save or onchange once the screen widened. Offline, when
 * the mobile variant was never cached, the load is retried once with the desktop
 * variant.
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
        /**
         * Queue keys of the displayed lead's calls (its own offline save, won, archive,
         * delete and activity calls), tracked for the lead `crmOwnLead` (its id, or the
         * record of a new lead): another lead displayed (pager) starts a new set.
         */
        this.crmOwnKeys = new Set();
        this.crmOwnLead = null;
        /**
         * Queued save this form was opened with from the offline systray. Online, the
         * systray removes it from the queue once the form shows its changes: its
         * removal hands them over to the form, as unsaved edits, and is no discard.
         */
        this.crmHandOverKey = this.props.offlineId || null;
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
                this.crmOwn(
                    Promise.resolve().then(() => {
                        if (status(this) === "mounted") {
                            return this.crmLeaveDeletedLead();
                        }
                    })
                );
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
        // Mobile UI exists only on small screens: the activity sheet does not stay
        // over the desktop form. The form keeps its record and unsaved edits.
        useEffect(() => {
            if (!this.crmOffline.isSmall) {
                untrack(() => this.crmActivitiesSheet.close());
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

        // Replayed keys leave the set, parked ones stay. After a replay that removed
        // some of the lead's calls and left none of them queued, the server values
        // replace the local presentation (won, archived): edits made since the form
        // restored the lead's queued save are saved, while the replayed values it
        // restored are not sent again. A parked call keeps the local presentation.
        this.crmOffline.onReplayed(() => {
            if (this.crmHandOverKey && !this.crmOffline.isQueued(this.crmHandOverKey)) {
                this.crmHandOverKey = null;
            }
            const ownKeys = this.crmCurrentOwnKeys();
            let replayed = false;
            for (const key of ownKeys) {
                if (!this.crmOffline.isQueued(key)) {
                    ownKeys.delete(key);
                    replayed = true;
                }
            }
            if (replayed && !ownKeys.size) {
                return this.crmOwn(this.crmReconcile({ dropRestored: true, save: true }));
            }
        });
        // A discarded call of the lead reverts its presentation (from the cache when
        // offline). Discarding the lead's own queued save drops the changes the form
        // restored from it (so a later save does not queue them again); edits made
        // since are kept, as are all changes when another call is discarded.
        this.crmOffline.onEntriesDiscarded("crm.lead", (keys) => {
            const ownKeys = this.crmCurrentOwnKeys();
            let discarded = keys.filter((key) => ownKeys.has(key));
            for (const key of discarded) {
                ownKeys.delete(key);
            }
            const handOverKey = this.crmHandOverKey;
            if (handOverKey && keys.includes(handOverKey)) {
                this.crmHandOverKey = null;
                if (!this.crmOffline.isOffline()) {
                    discarded = discarded.filter((key) => key !== handOverKey);
                    const root = this.model.root;
                    if (root?.offlineId === handOverKey) {
                        root.crmAdoptRestoredChanges();
                    }
                }
            }
            if (!discarded.length) {
                return;
            }
            const offlineId = this.model.root?.offlineId;
            const dropRestored = Boolean(offlineId) && discarded.includes(offlineId);
            return this.crmOwn(this.crmReconcile({ dropRestored }));
        });
        // A discarded activity call of the lead only leaves the set: its sheet follows
        // the queue itself.
        this.crmOffline.onEntriesDiscarded("mail.activity", (keys) => {
            const ownKeys = this.crmCurrentOwnKeys();
            for (const key of keys) {
                ownKeys.delete(key);
            }
        });

        // Back online while the desktop-variant fallback is active: load the mobile
        // variant again, keeping the form's changes.
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            if (!isOffline && this.crmDesktopFallback) {
                this.crmDesktopFallback = false;
                untrack(() => this.crmOwn(this.crmReconcile()));
            }
        });
    }

    /**
     * @override
     * Adds `crmUseDesktopSpec`, consumed by `CrmFormModel.load`, the activity
     * sheet's "Show more" hook `crmLoadMoreActivities` and `crmLeaveMobileVariant`,
     * consumed by `CrmFormRecord._getOnchangeValues`, to the parent's hooks.
     */
    get modelParams() {
        const params = super.modelParams;
        params.hooks.crmUseDesktopSpec = () => this.crmUseDesktopSpec();
        params.hooks.crmLoadMoreActivities = (resId) => this.crmLoadMoreActivities(resId);
        params.hooks.crmLeaveMobileVariant = (config) => this.crmLeaveMobileVariant(config);
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
     * Owns a promise this controller starts without a caller awaiting it (effects,
     * queue callbacks, the deferred restoration of a queued save, the mount
     * microtask). A lost connection is the sanctioned offline outcome (the cache or
     * the next reconnection takes over) and ends there; any other error goes to the
     * framework error handling, the way the action service shows an error of a
     * mounted controller (`Promise.reject(error)` in its `onError`), once even when
     * merged reconciliations share it (`crmReportError`).
     *
     * @param {any} promise
     * @returns {Promise<void>} resolved once `promise` settled
     */
    crmOwn(promise) {
        return Promise.resolve(promise).then(() => {}, crmReportError);
    }

    /**
     * Refreshes the displayed lead after its queued calls left the queue, or at the
     * end of the offline fallback (from the cache when offline), keeping the form's
     * unsaved changes as `CrmFormRecord.crmRefresh` describes; then shows its name
     * and the state of its still-queued calls.
     *
     * Asked for while the form's first root load runs (the model is not ready yet),
     * it runs once that load has completed, unless the controller is destroyed by
     * then: that load may have read the lead, or chosen its load variant, before the
     * replay, the discard or the reconnection. Requests made meanwhile then start
     * together and are merged into one refresh (`crmRefresh`); none runs when the
     * first load never completes.
     *
     * @param {{dropRestored?: boolean, save?: boolean}} [options]
     * @returns {Promise<void>}
     */
    async crmReconcile(options) {
        if (!this.model.isReady()) {
            await this.model.whenReady.promise;
            if (status(this) === "destroyed") {
                return;
            }
        }
        const root = this.model.root;
        if (!root) {
            return;
        }
        await root.crmRefresh(options);
        if (status(this) !== "destroyed" && toRaw(this.model.root) === toRaw(root)) {
            this.env.config.setDisplayName(this.displayName());
            this.crmApplyQueuedState();
        }
    }

    /**
     * The tracked queue keys (`crmOwnKeys`) of the displayed lead: a new, empty set
     * when the form displays another lead than the one they were tracked for.
     *
     * @returns {Set<string>}
     */
    crmCurrentOwnKeys() {
        const root = this.model.root;
        const lead = root ? root.resId || toRaw(root) : null;
        if (lead !== this.crmOwnLead) {
            this.crmOwnLead = lead;
            this.crmOwnKeys = new Set();
        }
        return this.crmOwnKeys;
    }

    /**
     * Adds to the displayed lead's `crmOwnKeys` its queued calls:
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
        const ownKeys = this.crmCurrentOwnKeys();
        const { offlineId, resId } = root;
        for (const { key, value } of this.crmOffline.queuedEntries("crm.lead")) {
            if ((offlineId && key === offlineId) || (resId && value.args?.[0]?.includes?.(resId))) {
                ownKeys.add(key);
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
                ownKeys.add(key);
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

    /**
     * Leaves the form of a lead whose delete is queued (once).
     *
     * @returns {any} what leaving started, for its caller to own
     */
    crmLeaveDeletedLead() {
        this.crmPendingHistoryBack = false;
        if (this.crmHistoryBackDone) {
            return;
        }
        this.crmHistoryBackDone = true;
        return this.env.config.historyBack();
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
        this.crmCurrentOwnKeys().add(key);
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
                    this.crmCurrentOwnKeys().add(entry.key);
                    this.crmOwn(this.crmLeaveDeletedLead());
                }
            },
        };
    }

    /**
     * @override
     * Re-applies the local state of the lead's queued calls after every root load
     * (`crmApplyQueuedState`), so it survives reopening the lead while they wait,
     * once the parent restored the lead's queued save into the form and set the
     * display name. Two root loads differ:
     * - a `crmRefresh` load kept the form's changes, and restoring the queued save
     *   again would overwrite later edits of the same fields: only the display name
     *   and the queued state are applied;
     * - a reload run inside the model mutex (`Record.load`, an online archive, a
     *   delete or duplicate opening another record) awaits this hook while holding
     *   the mutex, and the restoration's update waits for that mutex, so awaiting it
     *   would never resolve. The restoration then runs once the mutex is free, and
     *   the queued state is applied now and again after it.
     */
    async onRootLoaded() {
        const root = this.model.root;
        if (root?.crmRefreshing) {
            this.env.config.setDisplayName(this.displayName());
            this.crmApplyQueuedState();
            return;
        }
        if (this.model.mutex._queueSize > 0) {
            const restoration = super.onRootLoaded(...arguments);
            this.crmApplyQueuedState();
            this.crmOwn(
                restoration.then(() => {
                    if (status(this) !== "destroyed" && toRaw(this.model.root) === toRaw(root)) {
                        this.crmApplyQueuedState();
                    }
                })
            );
            return;
        }
        await super.onRootLoaded(...arguments);
        this.crmApplyQueuedState();
    }

    /**
     * Applies the local state of the displayed lead's queued calls:
     * - a queued `action_set_won` (pending or parked) shows the lead as won;
     * - the latest queued archive/unarchive sets `active` to the value it will set;
     * - a pending (not parked) `unlink` leaves the form (lead reached by URL or
     *   breadcrumb), once it is mounted.
     */
    crmApplyQueuedState() {
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
                this.crmOwn(this.crmLeaveDeletedLead());
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
        const mobile =
            this.crmOffline.isSmall &&
            !this.crmDesktopFallback &&
            this.crmHasActivityVariant(config);
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
            // Each lead has its own page size, read from the remembered preference,
            // never from this controller: the lead's form opened again, even cold
            // and offline, then issues the request of its last visit, whose cache
            // key holds the page "Show more" reached. A new record has none.
            activeFields.activity_ids = {
                ...activeFields.activity_ids,
                related: crmActivityRelated(),
                limit: config.resId
                    ? getCrmActivityLimit(this.crmActivityScope(config.resId))
                    : CRM_MOBILE_ACTIVITY_LIMIT,
            };
        }
        config.activeFields = markRaw(activeFields);
    }

    /**
     * Whether the load variants apply to `config`: a `crm.lead` configuration with
     * active fields and a one2many `activity_ids` the arch does not declare (an
     * arch declaring it keeps its own declaration). The phone variant adds that
     * field on a small screen without the offline fallback; the desktop variant
     * leaves it out.
     *
     * @param {Object} config root configuration
     * @returns {boolean}
     */
    crmHasActivityVariant(config) {
        return (
            !this.crmArchHasActivities &&
            Boolean(toRaw(config.activeFields)) &&
            config.fields?.activity_ids?.type === "one2many" &&
            config.resModel === "crm.lead"
        );
    }

    /**
     * @override
     * Before the `web_save` of the form's root builds its specification from the
     * root's fields, the root leaves the phone variant when the screen widened since
     * its phone load (`crmLeaveMobileVariant`), so the save requests, and then
     * parses, the desktop fields.
     *
     * @param {Object} record record about to be saved
     */
    async onWillSaveRecord(record) {
        if (toRaw(record) === toRaw(this.model.root)) {
            this.crmLeaveMobileVariant(record.config);
        }
        return super.onWillSaveRecord(...arguments);
    }

    /**
     * `crmLeaveMobileVariant` model hook, run before a request is built from the
     * root's own configuration (`onWillSaveRecord`, and the root's onchange in
     * `CrmFormRecord._getOnchangeValues`). The root keeps the variant of its last
     * root load until the next one, and widening the screen does not reload it, so
     * a root loaded on a phone still holds the `activity_ids` the phone variant
     * added. On a wide screen, `config.activeFields` is then replaced by a fresh
     * object without that field (never mutated; `config.fields` is left as it is)
     * and the root forgets the field's loaded value: the request is the desktop
     * one, and its result is parsed with the fields it asked for. The form keeps
     * its unsaved changes; the activity sheet is closed on a wide screen.
     *
     * Nothing changes on a small screen (the phone variant, or the offline fallback
     * that keeps the loaded rows of the displayed lead), for another configuration
     * than the root's, for an arch declaring `activity_ids`, when the root already
     * has the desktop variant, or when it holds a change of `activity_ids`. The
     * phone variant is never applied here: the next root load on a small screen
     * applies it (`onWillLoadRoot`).
     *
     * @param {Object} config configuration a request is about to be built from
     */
    crmLeaveMobileVariant(config) {
        const root = this.model.root;
        if (
            this.crmOffline.isSmall ||
            !config ||
            !root ||
            toRaw(config) !== toRaw(root.config) ||
            !this.crmHasActivityVariant(config)
        ) {
            return;
        }
        const currentActiveFields = toRaw(config.activeFields);
        // The arch declares no `activity_ids`, so an entry present was added by the
        // phone variant.
        if (!("activity_ids" in currentActiveFields)) {
            return; // desktop variant already
        }
        if (!root.crmForgetLoadedValue("activity_ids")) {
            return;
        }
        const activeFields = { ...currentActiveFields };
        delete activeFields.activity_ids;
        config.activeFields = markRaw(activeFields);
        this.crmLastVariant = "desktop";
    }

    /**
     * Scope of the activity page size remembered for the phone root load of the
     * lead `resId`: the lead and the form's action, whose context is part of
     * that load's request, hence of its cache key, like the page size.
     *
     * @param {number} resId
     * @returns {string}
     */
    crmActivityScope(resId) {
        return `lead:${this.env.config?.actionId ?? ""}:${resId}`;
    }

    /**
     * `crmLoadMoreActivities` model hook, the activity sheet's "Show more": online
     * on a phone, with the phone variant applied to the displayed lead `resId`,
     * raises the activity rows it loads by one page (`CRM_MOBILE_ACTIVITY_LIMIT`)
     * and refreshes the lead in place (`CrmFormRecord.crmRefresh`), so the larger
     * page lands in the form's own (cached) root load. It never issues a separate
     * `mail.activity` read. The refresh runs in the model mutex, replaces no
     * record and keeps the form's unsaved changes: nothing is saved first, and an
     * edit made while it runs waits behind it and applies to the refreshed lead.
     *
     * The lead's raised page size is remembered (`setCrmActivityLimit`) before the
     * refresh, which reads it, so that the lead's form opened again issues the same
     * request and is served the cached larger page offline. The previous page size
     * is remembered again when the displayed lead did not load that page: the
     * refresh failed (a lost connection resolves, any other error propagates), or
     * it did not apply the phone variant with that page to this lead (the form
     * moved to another record, or the screen widened, meanwhile).
     *
     * @param {number} resId lead whose sheet asks for more activities
     * @returns {Promise<void>}
     */
    async crmLoadMoreActivities(resId) {
        const root = this.model.root;
        if (
            !this.crmOffline.isSmall ||
            this.crmOffline.isOffline() ||
            this.crmLastVariant !== "mobile" ||
            !this.model.isReady() ||
            !root?.resId ||
            root.resId !== resId
        ) {
            return;
        }
        const scope = this.crmActivityScope(resId);
        const previousLimit = getCrmActivityLimit(scope);
        const limit = previousLimit + CRM_MOBILE_ACTIVITY_LIMIT;
        setCrmActivityLimit(scope, limit);
        try {
            await root.crmRefresh();
        } catch (error) {
            setCrmActivityLimit(scope, previousLimit);
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            return;
        }
        // A refresh that loaded gave the record its configuration, page size
        // included. The lead lacks the larger page when the refresh did not run
        // (another record shown), loaded another lead (a save moving the pager
        // reuses the record) or applied the desktop variant (no activity rows).
        const loadedLimit = toRaw(root.activeFields).activity_ids?.limit || 0;
        if (toRaw(this.model.root) !== toRaw(root) || root.resId !== resId || loadedLimit < limit) {
            setCrmActivityLimit(scope, previousLimit);
        }
    }

    /**
     * Opens the mobile activity sheet of the displayed lead (phone "Activities"
     * button). The sheet reads the form's current root on every render, so it
     * follows reloads; it closes when the form shows another record, and when the
     * screen widens.
     *
     * A direct call opens nothing unless the screen is small, the form is not in a
     * dialog and it shows a synced `crm.lead` (one with a server id).
     *
     * @param {MouseEvent} ev
     */
    openMobileActivities(ev) {
        const leadId = this.model.root?.resId;
        if (
            !this.crmOffline.isSmall ||
            this.env.inDialog ||
            this.props.resModel !== "crm.lead" ||
            !leadId
        ) {
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
