import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { registry } from "@web/core/registry";
import { FormCompiler } from "@web/views/form/form_compiler";
import { formView } from "@web/views/form/form_view";
import { StatusBarButtons } from "@web/views/form/status_bar_buttons/status_bar_buttons";

import {
    computed,
    effect,
    markRaw,
    onMounted,
    onWillDestroy,
    signal,
    status,
    toRaw,
    untrack,
    useEffect,
    useListener,
    usePlugin,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { x2ManyCommands } from "@web/core/orm_plugin";
import { usePopover } from "@web/core/popover/popover_hook";
import { pick } from "@web/core/utils/objects";
import { patch } from "@web/core/utils/patch";
import { Record } from "@web/model/relational_model/record";
import {
    addFieldDependencies,
    getOfflineDisplayName,
    getScheduleORMExtras,
    makeActiveField,
} from "@web/model/relational_model/utils";
import {
    RottingStatusBarDurationField,
    rottingStatusBarDurationField,
} from "@mail/js/rotting_mixin/rotting_statusbar";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { Composer } from "@mail/core/common/composer";
import { MailAttachmentDropzone } from "@mail/core/common/mail_attachment_dropzone";
import { Thread } from "@mail/core/common/thread";
import { Follower } from "@mail/core/web/follower";
import { FollowerList } from "@mail/core/web/follower_list";
import { FollowerSubtypeDialog } from "@mail/core/web/follower_subtype_dialog";
import {
    CRM_MOBILE_ACTIVITY_LIMIT,
    CRM_OFFLINE_CREATE_KEY,
    CRM_OFFLINE_CREATE_WRITE,
    crmDeliveredArgs,
    crmPendingLeadWrites,
    crmReplayQueued,
    crmReportError,
    crmReturnFocusFromSheet,
    getCrmActivitySubfields,
    isCrmOfflineCreateKey,
    isCrmOfflineQueueBlocked,
    isCrmReplaySent,
    isFieldMapping,
    newCrmOfflineCreateKey,
    rewriteCrmQueuedCall,
    useCrmOffline,
} from "@crm/mobile/crm_offline_hooks";
import { CrmMobileLeadActivities } from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";

const OFFLINE_WON_VALUES = Object.freeze({ won_status: "won", probability: 100 });

const ARCHIVE_METHODS = Object.freeze(["action_archive", "action_unarchive"]);

/** Field types whose record value is a list (its change is a list of commands). */
const X2MANY_TYPES = Object.freeze(["one2many", "many2many"]);

/** Lead contact fields the CRM save forces, each with the flag that decides it. */
const FORCED_CONTACT_FLAGS = Object.freeze({
    email_from: "partner_email_update",
    phone: "partner_phone_update",
});

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
 * Field types the lead form does not show from another record's queued save: their
 * display values (`extras.changes`) are not values the record can apply as loaded
 * ones (x2many commands, properties, references).
 */
const UNPROJECTED_TYPES = Object.freeze([
    ...X2MANY_TYPES,
    "properties",
    "reference",
    "many2one_reference",
]);

/**
 * Lead fields a queued `crm.lead` call writes when it is replayed: the values of a
 * `web_save`, the won stage and probability of `action_set_won` (which also
 * unarchives the lead), `active` for an archive or unarchive. Other calls write no
 * field of the lead.
 *
 * @param {{method: string, args?: any[]}} value queue entry value
 * @returns {string[]}
 */
function crmWrittenLeadFields(value) {
    switch (value.method) {
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

/** x2many commands naming one related record by its id (virtual for a creation). */
const RECORD_COMMANDS = Object.freeze([
    x2ManyCommands.CREATE,
    x2ManyCommands.UPDATE,
    x2ManyCommands.DELETE,
    x2ManyCommands.UNLINK,
]);

/**
 * Comparable form of an x2many command or of a value (`undefined` reads as `null`).
 *
 * @param {any} value
 * @returns {string}
 */
function crmJson(value) {
    return JSON.stringify(value === undefined ? null : value);
}

/** Whether `command` is an x2many record creation (`[0, virtualId, values]`). */
function isCreateCommand(command) {
    return Array.isArray(command) && command[0] === x2ManyCommands.CREATE;
}

/**
 * Index, in `commands` (a queued save's commands of one x2many field), of the record
 * creation `target` names: its index when the creation there still carries its
 * virtual id, else the only creation carrying that id; -1 when there is none.
 *
 * @param {any[]|undefined} commands
 * @param {{id: any, index: number}} target
 * @returns {number}
 */
function crmQueuedCreateIndex(commands, target) {
    if (!Array.isArray(commands)) {
        return -1;
    }
    const command = commands[target.index];
    if (isCreateCommand(command) && command[1] === target.id) {
        return target.index;
    }
    if (!target.id) {
        return -1;
    }
    const indexes = [];
    commands.forEach((other, index) => {
        if (isCreateCommand(other) && other[1] === target.id) {
            indexes.push(index);
        }
    });
    return indexes.length === 1 ? indexes[0] : -1;
}

/**
 * The record creations a restoration of a queued save put in an x2many list
 * (`restored`, `[0, virtualId, values]` as the list holds them right after it, in
 * order), each mapped to the creation of the queued save it stands for (`queued`,
 * that save's commands of the field): the restoration applies them in order, each
 * under a new virtual id, so the k-th restored creation is the k-th queued one. When
 * their counts differ (display values out of step with the save's arguments), a
 * restored creation is mapped to the first queued one, not mapped yet, with the same
 * values; one without such a creation is not mapped.
 *
 * @param {any[][]} restored
 * @param {any[]|undefined} queued
 * @returns {Map<string, {id: any, index: number, values: Object}>} restored virtual id →
 *   the queued creation (its virtual id and index) and the values it was restored with
 */
function crmAlignRestoredCreates(restored, queued) {
    const creates = [];
    (Array.isArray(queued) ? queued : []).forEach((command, index) => {
        if (isCreateCommand(command)) {
            creates.push({ id: command[1], index, values: command[2] });
        }
    });
    const aligned = new Map();
    const target = ({ id, index }, command) => ({ id, index, values: command[2] || {} });
    if (creates.length === restored.length) {
        restored.forEach((command, k) => aligned.set(command[1], target(creates[k], command)));
        return aligned;
    }
    const remaining = [...creates];
    for (const command of restored) {
        const k = remaining.findIndex(({ values }) => crmJson(values) === crmJson(command[2]));
        if (k >= 0) {
            aligned.set(command[1], target(remaining[k], command));
            remaining.splice(k, 1);
        }
    }
    return aligned;
}

/**
 * `commands`, a queued save's commands of one x2many field, with its record
 * creations rewritten as `children` (the form's records standing for them,
 * `CrmFormRecord._crmSplitCommands`) require: a creation none of whose records is
 * still in the list is dropped; one whose records were edited takes their edited
 * values over its own, at its place and with its own virtual id. Every other
 * command is kept as it is.
 *
 * @param {any[]} commands
 * @param {{index: number, present: boolean, values: Object}[]} children
 * @returns {any[]|null} the rewritten commands, `null` when nothing changes
 */
function crmRewrittenCreates(commands, children) {
    let changed = false;
    const rewritten = [];
    commands.forEach((command, index) => {
        const records = children.filter((child) => child.index === index);
        if (!records.length || !isCreateCommand(command)) {
            rewritten.push(command);
            return;
        }
        const present = records.filter((child) => child.present);
        if (!present.length) {
            changed = true;
            return;
        }
        const values = Object.assign({}, command[2], ...present.map((child) => child.values));
        if (crmJson(values) === crmJson(command[2] || {})) {
            rewritten.push(command);
            return;
        }
        changed = true;
        rewritten.push([command[0], command[1], values]);
    });
    return changed ? rewritten : null;
}

/**
 * Context of a delivery of the create of the still-new lead `record`: `context` with
 * the lead's delivery key (`_crmCreateKey`), and the later-save flag
 * (`CRM_OFFLINE_CREATE_WRITE`) when the delivery is a later save of the lead. A keyed
 * save decides that once, at its start (`_crmCreateWrite`), so that its request and
 * the create queued when its answer is lost agree; a create queued by a save that
 * sent no key is a later save once a delivery of the key was sent or queued
 * (`_crmCreateKeyDelivered`).
 *
 * @param {Record} record a `crm.lead` record without id holding a delivery key
 * @param {Object} [context]
 * @returns {Object}
 */
function crmLeadCreateContext(record, context) {
    const raw = toRaw(record);
    const laterSave = raw._crmCreateWrite ?? Boolean(raw._crmCreateKeyDelivered);
    return {
        ...context,
        [CRM_OFFLINE_CREATE_KEY]: raw._crmCreateKey,
        ...(laterSave ? { [CRM_OFFLINE_CREATE_WRITE]: true } : {}),
    };
}

/**
 * Delivery keys of lead creates (`CRM_OFFLINE_CREATE_KEY`) for every record of a
 * `crm.lead` without id: the lead form's (`CrmFormRecord`) and a framework record's,
 * such as the desktop kanban quick create's. The framework sends a save also while
 * the connection is reported lost, and queues it when its request is lost; a request
 * whose answer was lost may have created the lead, and the queued create, replayed at
 * least once, would create it again. The server's `crm.lead` `web_save` creates a
 * lead once per key, answers every later delivery of the key with it, and writes the
 * values of a delivery on it only when flagged as a later save of the lead
 * (`CRM_OFFLINE_CREATE_WRITE`).
 *
 * A lead enters this offline flow when a save of it starts while the connection is
 * reported lost (an urgent save excepted), or when a request of its save is lost. It
 * then holds a key (`_crmCreateKey`, on the raw record), drawn before the first
 * request that may create the lead, and sends it with every delivery of its create:
 * that request, the create queued when its answer is lost, and every later save of
 * the still-new lead, queued or online, flagged as a later save once a delivery of the
 * key was sent or queued (`_crmCreateKeyDelivered`). A lead restored from its queued
 * create takes that create's key (`CrmFormRecord._crmAdoptCreateKey`). A lead that
 * never entered the flow (saved while the connection is reported up, its requests
 * answered) sends no key and no flag. Every other record, and a lead with an id, is
 * saved and queued as the framework does.
 */
patch(Record.prototype, {
    /**
     * @override
     * While a create of a still-new lead holding a delivery key is built
     * synchronously (its queued create, its page-close beacon: `_crmSendsCreateKey`),
     * the context carries that key, and the later-save flag of the delivery
     * (`crmLeadCreateContext`). Every other read is the parent's context, unchanged.
     */
    get context() {
        const context = super.context;
        const record = toRaw(this);
        if (!record._crmSendsCreateKey || !record._crmCreateKey || this.resId) {
            return context;
        }
        return crmLeadCreateContext(record, context);
    },

    /**
     * @override
     * A save of a still-new lead runs through `_crmSaveSendingCreateKey`; every other
     * save is the parent's.
     */
    _save() {
        if (this.resModel !== "crm.lead" || this.resId) {
            return super._save(...arguments);
        }
        return this._crmSaveSendingCreateKey(() => super._save(...arguments));
    },

    /**
     * @override
     * The queued create of a still-new lead carries its delivery key in its context
     * (`context`): the key its save sent with its request, or one drawn now when that
     * request carried none (the save started while the connection was reported up),
     * with the later-save flag of the save. The framework sends that create again
     * whenever its answer is lost, and the lead's later saves name the same lead, so
     * the server creates it once. A key drawn here is dropped again when nothing is
     * queued (a non-secure origin has no queue, and the CRM never queues some
     * records); a key a request already sent is kept for the lead's later saves.
     * Every other offline save is the parent's.
     *
     * @returns {boolean}
     */
    _offlineSave() {
        if (this.resModel !== "crm.lead" || this.resId) {
            return super._offlineSave(...arguments);
        }
        const record = toRaw(this);
        const drawsKey = !record._crmCreateKey;
        if (drawsKey) {
            record._crmCreateKey = newCrmOfflineCreateKey();
            record._crmCreateKeyDelivered = false;
        }
        const sendsKey = record._crmSendsCreateKey;
        record._crmSendsCreateKey = true;
        let queued;
        try {
            queued = super._offlineSave(...arguments);
        } catch (error) {
            if (drawsKey) {
                record._crmCreateKey = undefined;
            }
            throw error;
        } finally {
            record._crmSendsCreateKey = sendsKey;
        }
        if (queued === false) {
            if (drawsKey) {
                record._crmCreateKey = undefined;
            }
        } else {
            record._crmCreateKeyDelivered = true;
        }
        return queued;
    },

    /**
     * Whether the own queued create (`offlineId`) of this new lead is pending (queued,
     * not parked). It reads the plugin's queue signal.
     *
     * @returns {boolean}
     */
    _crmIsOwnCreatePending() {
        const entry = this._offlineId && this.model.offlinePlugin._ormToSync()[this._offlineId];
        return Boolean(entry) && !entry.value.extras?.error;
    },

    /**
     * Runs `save`, the parent save of this still-new lead, so that the create it sends
     * carries the lead's delivery key (`_crmCreateKey`). A save of a lead without a
     * key that starts while the connection is reported lost (an urgent save
     * excepted) draws one first: its first request, which may reach the server and
     * create the lead although its answer is lost, already names the lead. A key that
     * is then neither sent nor queued (the record was invalid) is dropped. A lead
     * without a key otherwise is saved as the parent saves it, unchanged.
     *
     * Whether the save is a later save of the lead (`CRM_OFFLINE_CREATE_WRITE`) is
     * decided at its start (`_crmCreateWrite`): it is once a delivery of the key was
     * sent or queued (`_crmCreateKeyDelivered`), by an earlier save of the record or
     * by the queued create it was restored from. The save's request, its page-close
     * beacon and the create queued when its answer is lost (`_offlineSave`) carry
     * that decision, so the create queued after a first request repeats it without
     * the flag: sent again, it writes nothing over a save made since by the lead's id.
     * Every later save of the still-new lead writes its values on the lead the key
     * created.
     *
     * The online create is sent only once the lead's own queued create has left the
     * queue (replayed, or discarded) or is parked. While that create is still pending
     * (a replay that stopped on a lost answer, or one not started yet), sending the
     * save would let that older create, replayed later, write its values over the
     * save's: the save is queued into it instead (`_offlineSave`, through the
     * framework's lost-connection fallback), which replays the lead's create once,
     * with the save's values, in its place in the queue.
     *
     * The model's ORM is replaced until the parent save settles: its wrapper handles a
     * `crm.lead` `web_save` without ids as above and forwards every other call to the
     * model's ORM. The create-key context flag (`_crmSendsCreateKey`) is set only while
     * `save` builds its synchronous calls (the page-close beacon).
     *
     * @param {() => Promise<boolean>} save
     * @returns {Promise<boolean>}
     */
    async _crmSaveSendingCreateKey(save) {
        const record = toRaw(this);
        const model = toRaw(this.model);
        const drawsKey =
            !record._crmCreateKey &&
            !model._urgentSave &&
            untrack(() => model.offlinePlugin.isOffline());
        if (drawsKey) {
            record._crmCreateKey = newCrmOfflineCreateKey();
            record._crmCreateKeyDelivered = false;
        }
        if (!record._crmCreateKey) {
            return save();
        }
        const orm = model.orm;
        const keyedOrm = Object.assign(Object.create(orm), {
            webSave(resModel, resIds, values, kwargs) {
                if (resModel !== "crm.lead" || resIds.length) {
                    return orm.webSave(...arguments);
                }
                if (untrack(() => record._crmIsOwnCreatePending())) {
                    throw new ConnectionLostError(`/web/dataset/call_kw/${resModel}/web_save`);
                }
                const context = crmLeadCreateContext(record, kwargs?.context);
                record._crmCreateKeyDelivered = true;
                return orm.webSave(resModel, resIds, values, { ...kwargs, context });
            },
        });
        model.orm = keyedOrm;
        const previousWrite = record._crmCreateWrite;
        record._crmCreateWrite = Boolean(record._crmCreateKeyDelivered);
        const sendsKey = record._crmSendsCreateKey;
        record._crmSendsCreateKey = true;
        let promise;
        try {
            promise = save();
        } finally {
            record._crmSendsCreateKey = sendsKey;
        }
        if (model._urgentSave && !record.dirty) {
            // The page-close beacon was sent, with the key.
            record._crmCreateKeyDelivered = true;
        }
        try {
            return await promise;
        } finally {
            if (model.orm === keyedOrm) {
                model.orm = orm;
            }
            record._crmCreateWrite = previousWrite;
            if (drawsKey && !record._crmCreateKeyDelivered) {
                record._crmCreateKey = undefined;
            }
        }
    },
});

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
        // A save whose x2many lists name records or commands of a queued save of the
        // lead that no replay sent (pending, or parked) is queued at once, whatever the
        // connection state: that save is rewritten as the form leaves them, and the
        // rest of the save follows it (`_crmRoutesSave`). While the running replay has
        // still to send a queued write of the lead, or the queued create of the
        // still-new lead, any other save waits for it (`_crmAwaitLeadReplay`). A wait
        // ended by a connection reported lost, or by the end of the form, with that
        // write still pending, ends "queue only": the save is then queued after it,
        // never sent. As the replay may have failed to send, or parked, the queued
        // save the lists name meanwhile, the routing is decided again once the wait
        // ends. While the connection is reported lost, a save of a lead with such a
        // write is queued after it as well (`_crmQueuesSave`). Any other save starts
        // at once.
        let routes = untrack(() => this._crmRoutesSave());
        let queueOnly = false;
        if (!routes) {
            const leadReplay = this._crmAwaitLeadReplay();
            if (leadReplay) {
                queueOnly = await leadReplay;
                routes = untrack(() => this._crmRoutesSave());
            }
        }
        // A queued save whose only edits undo commands restored from the lead's queued
        // save writes no change the framework sees: it is queued by the CRM offline
        // save (`_crmSavesUndoneRestoredCommandsOnly`), and the replay is then asked
        // to deliver it when the save is routed or released "queue only", or the lead
        // has a pending queued write, as for any save queued while the connection is
        // reported lost (`_crmQueueSave`).
        if (untrack(() => this._crmSavesUndoneRestoredCommandsOnly(routes || queueOnly))) {
            if (!this._checkValidity({ displayNotification: true })) {
                return false;
            }
            const asksReplay = routes || queueOnly || untrack(() => this._crmQueuesSave());
            const result = this._offlineSave();
            if (asksReplay) {
                crmReplayQueued(this.model.offlinePlugin);
            }
            return result;
        }
        // Runs before the force-save statements below, which stay as they are: after a
        // partner change whose onchange was lost, the email and phone it superseded
        // are not written, online or offline (`_crmDropStaleForcedContacts`), nor
        // replayed by the lead's still-queued save (`_crmRescheduleOwnSave`).
        if (this._crmPartnerOnchangeLost && this._crmDropStaleForcedContacts()) {
            this._crmRescheduleOwnSave();
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

        // Read after the replay hold above, which ends with the replay, with the
        // sending of the lead's writes ahead, or "queue only". A save queued this way
        // needs a lead id, and only a save of a still-new lead sends its delivery key
        // (the parent's `_save`, through `_crmSaveSendingCreateKey`; a new lead
        // released "queue only" is queued into its own pending create there), so at
        // most one of the two paths changes the save. A save that is sent (its
        // request, or its page-close beacon) leaves out the x2many commands a queued
        // save of the lead does, sent or delivered by a replay
        // (`_crmSaveLeavingQueuedCommands`).
        const queues = routes || untrack(() => this._crmQueuesSave(queueOnly));
        const res = queues
            ? await this._crmQueueSave(() => super._save(...arguments))
            : await this._crmSaveLeavingQueuedCommands(() => super._save(...arguments));
        // The rainbowman lookup is decorative: offline it is neither issued nor queued.
        // The signal is read after the save, because a connection lost during the save
        // turns the plugin offline before the queued (offline) save resolves. A save
        // queued while the connection is reported lost is an offline save as well,
        // even once the connection check it starts reports the connection back. A new
        // lead whose save was queued into its still-queued create has no id to look up.
        if (res && changeStage && this.resId && !queues && !this.model.offlinePlugin.isOffline()) {
            await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);
        }
        return res;
    }

    /**
     * Holds a save of the lead until the running replay has sent the lead's queued
     * writes. The replay sends each queued call with the values it held when the
     * replay started, in queue order and one call a second, so a save sent while a
     * write of the lead is still to be replayed reaches the server first and is then
     * overwritten by it, although the user made it last.
     *
     * The save is released, to be sent, once no pending (not parked) queued
     * `crm.lead` call writing a field of the lead remains (`_crmHasPendingLeadWrite`),
     * or once the replay ends; when the replay stopped on a lost call, the save is
     * then queued after that call instead of being sent (`_crmQueuesSave`).
     *
     * It is also released, "queue only", as soon as the plugin reports the
     * connection lost or the form owning the record is destroyed (`crmDestroyed` of
     * the model) while such a call is still pending. The replay's request may then
     * never be answered (a request has no time-out, and a connection reported lost
     * does not stop the replay), and the save would otherwise keep the model mutex
     * forever. Sending the save then could still let the running replay, which may be
     * up, overwrite it with that call, so it is queued instead, after the lead's
     * queued writes, and the record's queued save the replay may still send is left
     * as it is (`_offlineSave`): the replay that follows sends the user's values last.
     * While it waits, the save holds the model mutex, as any save does: edits made
     * meanwhile apply after it, and the form's buttons stay disabled. The queue is left
     * as it is.
     *
     * A new lead (no id, so no queued write targets it) is held the same way while
     * its own queued create (`offlineId`) is pending: saving it before that create's
     * replay would create the lead a second time. Once the create has left the queue,
     * the save, which carries the create's delivery key flagged as a later save of
     * the lead (`_crmSaveSendingCreateKey`), reaches the server after it and writes
     * its values on the lead it created; when the replay ends with the create still
     * queued, or the save is released "queue only", the save is queued into it, which
     * the replay keeps if it is sending that create meanwhile (`crmReplayCall`).
     *
     * Nothing is held for an urgent save (the page is being left, and its beacon
     * cannot wait), when no replay runs, or for a save without an edit of the user
     * (`_crmHasOwnEdits`); a record without an id is held only for its own pending
     * queued create. While the connection is reported lost and no replay runs, a save
     * of a lead with an id and a pending queued write is queued after that write
     * instead (`_crmQueuesSave`). `_save` does not ask for the hold of a save naming
     * records or commands of a queued save that no replay sent: that save is queued
     * at once (`_crmRoutesSave`).
     *
     * @returns {Promise<boolean>|undefined} resolved once the save may proceed:
     *   `true` when it is to be queued only, `false` when it may be sent; `undefined`
     *   when it may be sent at once
     */
    _crmAwaitLeadReplay() {
        if (!untrack(() => this._crmIsLeadReplayPending() && this._crmHasOwnEdits())) {
            return undefined;
        }
        const plugin = this.model.offlinePlugin;
        const destroyed = this.model.crmDestroyed;
        let stop;
        const released = new Promise((resolve) => {
            // Created outside any computation, so that only `stop` disposes of it. Its
            // first run is synchronous; it runs again on every change of the signals
            // it reads: the sync and queue signals (`_crmIsLeadReplayPending`), then,
            // while the save is still held, the connection and the model's lifetime.
            stop = untrack(() =>
                effect(() => {
                    if (!this._crmIsLeadReplayPending()) {
                        resolve(false);
                    } else if (plugin.isOffline() || destroyed?.()) {
                        resolve(true);
                    }
                })
            );
        });
        return released.then((queueOnly) => {
            stop();
            return queueOnly;
        });
    }

    /**
     * Whether the save writes an edit of the user: a change other than a value
     * restored from the record's queued save and unmodified since
     * (`crmRestoredUnmodifiedFields`). An x2many list the user changed counts even
     * when it is left without commands (`_crmTrackedX2ManyFields`: the user undid a
     * command restored from that save, or removed a record a queued save creates),
     * as the save still writes what the user did there (`_crmSplitCommands`). An
     * unmodified restored value is the one its queued save sends, so writing it
     * before that save's replay overwrites nothing (a form left during the replay
     * saves it at once).
     *
     * @returns {boolean}
     */
    _crmHasOwnEdits() {
        const restored = this.crmRestoredUnmodifiedFields();
        const isEdit = (fieldName) => fieldName !== "id" && !restored.includes(fieldName);
        return (
            Object.keys(this._getChanges()).some(isEdit) ||
            this._crmTrackedX2ManyFields().some(isEdit)
        );
    }

    /**
     * Whether this save of a lead with an id (not urgent), with the lead's own queued
     * save still queued, writes no change while the user undid commands restored from
     * that save: removed a record it creates, removed a record it links, or added
     * back one it unlinks (`_crmSplitCommands`), and the save is queued: offline, or
     * `force` (`_save`: the save names records or commands of a queued save of the
     * lead that no replay sent, `_crmRoutesSave`, or the replay hold released it
     * "queue only"). Such a list is left without commands, so it is not among the
     * changes (`_getChanges`): the framework would save nothing, and the queued save
     * would still send those commands. The save is then queued by the CRM offline
     * save (`_offlineSave`), which rewrites that save and queues the inverse commands
     * after it.
     *
     * @param {boolean} [force] the save is queued whatever the connection state
     * @returns {boolean}
     */
    _crmSavesUndoneRestoredCommandsOnly(force = false) {
        if (
            !this.resId ||
            this.model._urgentSave ||
            !(force || this.model.offlinePlugin.isOffline()) ||
            !this._crmIsOwnSaveQueued()
        ) {
            return false;
        }
        const changes = this._getChanges();
        delete changes.id;
        if (Object.keys(changes).length) {
            return false;
        }
        return this._crmTrackedX2ManyFields().some((fieldName) => {
            const { commands, children } = this._crmSplitCommands(fieldName, []);
            return commands.length > 0 || children.some((child) => !child.present);
        });
    }

    /**
     * Whether the running replay has still to send a queued write the save of the
     * lead must follow (`_crmAwaitLeadReplay`): a pending queued write of a field of
     * the lead (`_crmHasPendingLeadWrite`), or the pending queued create of the
     * still-new lead. The connection state the plugin reports plays no part here; it
     * only decides how the save proceeds once released. It reads the plugin's sync
     * and queue signals, so that an effect calling it follows them.
     *
     * @returns {boolean}
     */
    _crmIsLeadReplayPending() {
        const plugin = this.model.offlinePlugin;
        if (this.model._urgentSave || !plugin.syncingORM()) {
            return false;
        }
        if (!this.resId) {
            return this._crmIsOwnCreatePending();
        }
        return this._crmHasPendingLeadWrite();
    }

    /**
     * Whether a pending (not parked) queued `crm.lead` call writes a field of the
     * lead (`crmPendingLeadWrites`): its replay, still to come, could overwrite a
     * save sent now, whatever fields each names, as the server recomputes fields a
     * call does not name. A parked call is not replayed, and an `unlink` writes no
     * field. Read from the shared per-lead index of the queue, not by going through
     * every queued call; it reads the queue signal.
     *
     * @returns {boolean}
     */
    _crmHasPendingLeadWrite() {
        return (
            crmPendingLeadWrites(this.model.offlinePlugin, this, Object.keys(this._changes))
                .length > 0
        );
    }

    /**
     * Whether the save of the lead is queued after its pending queued writes instead
     * of being sent (`_crmQueueSave`).
     *
     * The framework sends a save whatever the connection state, and queues it only
     * when its request is lost. Once the connection is back, the connection is still
     * reported lost until a request reaches the server, and no replay runs: a save
     * made meanwhile reaches the server, which takes the connection for restored,
     * and the replay then sends the lead's older queued writes over it. So, while
     * the connection is reported lost and such a write is pending
     * (`_crmHasPendingLeadWrite`), the save is queued as the framework queues a save
     * whose request is lost (`_offlineSave`), which orders it after every queued
     * call of the lead: the replay sends the older writes first, and the user's
     * values last. A save the replay hold released "queue only" (`force`) is queued
     * so whatever the connection state, while such a write is still pending.
     *
     * Every other save is sent as before: online (the replay hold applies), for a
     * record without an id (no queued write targets it; a still-new lead's save is
     * queued into its own pending create by the parent's `_crmSaveSendingCreateKey`
     * instead), for
     * an urgent save (its beacon cannot wait, and a queue entry could not be stored
     * before the page is left), and while no pending queued call writes the lead.
     *
     * @param {boolean} [force] the save was released "queue only"
     *   (`_crmAwaitLeadReplay`)
     * @returns {boolean}
     */
    _crmQueuesSave(force = false) {
        return (
            Boolean(this.resId) &&
            !this.model._urgentSave &&
            (force || this.model.offlinePlugin.isOffline()) &&
            this._crmHasPendingLeadWrite()
        );
    }

    /**
     * Runs the framework save `save` (`Record._save`) so that the lead's own
     * `web_save` is not sent: the model's ORM fails it at once as a lost connection,
     * before any request, so the framework queues the save (`_offlineSave`), exactly
     * as when its request is lost. Every step before the request runs as it does for
     * any save (validity, the controller's `onWillSaveRecord`), and every other call
     * of the model's ORM is sent unchanged meanwhile.
     *
     * The request the save would have sent was also what told the framework that the
     * connection is back. Once the save is queued, the replay is asked to deliver it
     * instead (`crmReplayQueued`): while the connection is reported lost, the plugin
     * checks it (`checkConnection`, the check the offline systray offers), and when it
     * is back the replay starts and sends the lead's queued writes, this save last;
     * online, the replay starts, or the running one starts the next when it ends.
     * Nothing is awaited, so the save ends at once.
     *
     * @param {() => Promise<boolean>} save the parent's save
     * @returns {Promise<boolean>} its result
     */
    async _crmQueueSave(save) {
        const model = toRaw(this.model);
        const orm = model.orm;
        const resModel = this.resModel;
        const resId = this.resId;
        let queued = false;
        const queuingOrm = Object.assign(Object.create(orm), {
            webSave(saveModel, resIds) {
                if (saveModel === resModel && resIds?.length === 1 && resIds[0] === resId) {
                    queued = true;
                    return Promise.reject(
                        new ConnectionLostError(`/web/dataset/call_kw/${saveModel}/web_save`)
                    );
                }
                return orm.webSave(...arguments);
            },
        });
        model.orm = queuingOrm;
        try {
            return await save();
        } finally {
            if (model.orm === queuingOrm) {
                model.orm = orm;
            }
            if (queued) {
                crmReplayQueued(model.offlinePlugin);
            }
        }
    }

    /**
     * Whether this save of the lead is queued, whatever the connection state, instead
     * of being sent (`_save`): its x2many lists name records or commands of a queued
     * save of the lead that no replay sent as that save holds them now
     * (`isCrmReplaySent`), pending or parked (`_crmSplitCommands`): a record that save
     * creates (in the list, edited or not, or removed from it), or a command restored
     * from it (a link, an unlink...), kept or undone. Sent, the save would create or
     * link those records a second time once that save is replayed (or retried, when
     * parked), and that save would replay its older values over the user's. Queued
     * (`_crmQueueSave`, `_offlineSave`), it rewrites that save in place as the form
     * leaves its records, queues the rest after every queued call of the lead, and
     * asks the replay to deliver them (`crmReplayQueued`); the record's own parked
     * save is queued again, as any offline save of the record queues it, so its
     * replay creates those records once, with the user's last values. A save naming
     * none of them is not concerned, nor is an urgent save (its beacon cannot wait,
     * and is never queued) or a record without an id.
     *
     * @returns {boolean}
     */
    _crmRoutesSave() {
        if (this.resModel !== "crm.lead" || !this.resId || this.model._urgentSave) {
            return false;
        }
        // Only these fields hold records or commands of a queued save of the lead.
        const fieldNames = this._crmTrackedX2ManyFields();
        if (!fieldNames.length) {
            return false;
        }
        const written = this._getChanges();
        return fieldNames.some((fieldName) => {
            const { children, restoration } = this._crmSplitCommands(
                fieldName,
                written[fieldName] || []
            );
            return (
                children.some((child) => !child.sent) || Boolean(restoration && !restoration.sent)
            );
        });
    }

    /**
     * Runs `save`, the parent save of this lead, so that the changes it sends (its
     * request, or its page-close beacon) leave out the x2many commands of the lead's
     * queued saves (`_crmSentChanges`): the parent reads its changes
     * (`_getChanges`) synchronously, before its first `await`, while the record says
     * so (`_crmSplitsSave`). A save whose request is lost is queued by the CRM
     * offline save, which splits its commands itself (`_offlineSave`).
     *
     * @param {() => Promise<boolean>} save
     * @returns {Promise<boolean>}
     */
    _crmSaveLeavingQueuedCommands(save) {
        const record = toRaw(this);
        const splits = record._crmSplitsSave;
        record._crmSplitsSave = true;
        try {
            return save();
        } finally {
            record._crmSplitsSave = splits;
        }
    }

    /**
     * @override
     * While the lead's save reads the changes it sends
     * (`_crmSaveLeavingQueuedCommands`), they leave out the x2many commands of the
     * lead's queued saves (`_crmSentChanges`). Every other read, of these changes or
     * of others (the queued ones, an onchange's, a sub-record's), is the parent's.
     *
     * @param {Object} [changes]
     * @param {{withReadonly?: boolean}} [options]
     */
    _getChanges(changes = this._changes, options = {}) {
        const result = super._getChanges(...arguments);
        if (
            !toRaw(this)._crmSplitsSave ||
            toRaw(changes) !== toRaw(this._changes) ||
            options.withReadonly
        ) {
            return result;
        }
        return untrack(() => this._crmSentChanges(result));
    }

    /**
     * The server values `changes` (`_getChanges`) of a save of the lead that is sent
     * (online, or by its page-close beacon), with each x2many field naming what a
     * queued save of the lead does (`_crmSplitCommands`) left with this save's own
     * commands: a record a queued save creates is created by it only, whether that
     * save is still queued or was sent or delivered by a replay, and a command
     * restored from the record's queued save is left to it. The inverse of a restored
     * link or unlink the user undid is added once a replay sent or delivered that save
     * (the server has, or receives, that command first), not while it waits: sent
     * first, it would be undone by that save's replay. A field left without commands
     * is not sent. A field naming nothing of a queued save keeps its commands.
     *
     * The edits of a record a queued save creates do not reach it once a replay sent
     * that save: the server created it with the values the replay sent, under an id
     * the form does not know. While that save waits, a save naming its records is
     * queued instead (`_crmRoutesSave`), and rewrites it with them; only an urgent save
     * (never queued) leaves them unsent then.
     *
     * @param {Object} changes modified in place
     * @returns {Object} `changes`
     */
    _crmSentChanges(changes) {
        if (this.resModel !== "crm.lead" || !this.resId) {
            return changes;
        }
        // Only these fields hold records or commands of a queued save of the lead.
        for (const fieldName of this._crmTrackedX2ManyFields()) {
            const split = this._crmSplitCommands(fieldName, changes[fieldName] || []);
            if (!split.named) {
                continue;
            }
            const commands = split.restoration?.sent ? split.commands : split.own;
            if (commands.length) {
                changes[fieldName] = commands;
            } else {
                delete changes[fieldName];
            }
        }
        return changes;
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
     * the parent reloads the record.
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
     *
     * Offline, the onchange of a lead edit is lost: on a lost connection the
     * framework gets no onchange values, so the fields the server derives from the
     * edit keep their loaded values, and two pairs of them then mislead the form:
     *
     * - a new phone keeps the loaded `phone_formatted` and `phone_sanitized`, which
     *   the phone field shows and dials instead of the number the user saved;
     * - a new partner keeps the loaded `partner_email_update` and
     *   `partner_phone_update`, so the save forces the lead's email and phone into
     *   its changes, and their replay overwrites the new partner's.
     *
     * Those fields then get `false` as onchange values, decided from the values
     * the lead holds before the change: the phone field falls back to the phone
     * itself, nothing is forced, and on replay the server computes the lead's email
     * and phone from the new partner, as the online onchange does. They enter the
     * changes as any onchange value does, so they last through the save, the queue
     * and the reopening of the lead. Only readonly fields the form loads are given,
     * so none is ever written or queued. A successful onchange keeps its own values.
     *
     * Online, choosing a partner also replaces the email and phone edited before
     * it with the partner's. Offline, those edits get their stored value back
     * instead (`_crmContactsToRevert`), which the field shows (a phone given back
     * drops its formatted and sanitized numbers, as a new phone does): the save then
     * drops them (`_crmDropStaleForcedContacts`), and on replay the server derives
     * them from the new partner. Values set in the same changes as the partner (the
     * restoration of a queued save) and edits made after it are kept. The record
     * remembers that a partner change lost its onchange (`_crmPartnerOnchangeLost`,
     * read by `_save`) and the values it gave back, until a successful onchange of
     * a partner change or a load that resets the changes.
     *
     * @param {Object} changes
     */
    _getOnchangeValues(changes) {
        if (toRaw(this.model.root) === toRaw(this)) {
            this.model.hooks.crmLeaveMobileVariant?.(this.config);
        }
        const substitute = {};
        let partnerChange = false;
        let contacts = {};
        if (this.resModel === "crm.lead") {
            partnerChange =
                "partner_id" in changes &&
                (changes.partner_id?.id || false) !== (this.data.partner_id?.id || false);
            if (partnerChange) {
                substitute.partner_email_update = false;
                substitute.partner_phone_update = false;
                contacts = this._crmContactsToRevert(changes);
            }
            if (
                ("phone" in changes && (changes.phone || false) !== (this.data.phone || false)) ||
                "phone" in contacts
            ) {
                substitute.phone_formatted = false;
                substitute.phone_sanitized = false;
            }
            for (const fieldName in substitute) {
                if (!(fieldName in this.activeFields) || !this._isReadonly(fieldName)) {
                    delete substitute[fieldName];
                }
            }
            // Writable fields the form loads (`_crmContactsToRevert`), never readonly-filtered.
            Object.assign(substitute, contacts);
        }
        const result = super._getOnchangeValues(...arguments);
        if (!partnerChange && !Object.keys(substitute).length) {
            return result;
        }
        return Promise.resolve(result).then((values) => {
            if (partnerChange) {
                this._crmPartnerOnchangeLost = !values;
                this._crmRevertedContacts = values
                    ? undefined
                    : markRaw({ ...this._crmRevertedContacts, ...contacts });
            }
            return values || (Object.keys(substitute).length ? substitute : values);
        });
    }

    /**
     * Email and phone (`FORCED_CONTACT_FLAGS`) that a change of the lead's partner
     * to `changes.partner_id` gives back their loaded value (`_crmLoadedContacts`)
     * when its onchange is lost: each field the form loads, that `changes` does not
     * set, and whose value differs from the loaded one (an edit made before the
     * partner change). The server replaces the lead's email and phone only with
     * those of a partner, so removing the partner, as a lead without an id, gives
     * nothing back.
     *
     * @param {Object} changes
     * @returns {Object} loaded values, by field name
     */
    _crmContactsToRevert(changes) {
        const loaded = this._crmLoadedContacts;
        const contacts = {};
        if (!loaded || !changes.partner_id?.id) {
            return contacts;
        }
        for (const fieldName in FORCED_CONTACT_FLAGS) {
            if (
                fieldName in this.activeFields &&
                fieldName in loaded &&
                !(fieldName in changes) &&
                (this.data[fieldName] || false) !== (loaded[fieldName] || false)
            ) {
                contacts[fieldName] = loaded[fieldName];
            }
        }
        return contacts;
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
     * Refreshes the lead in place from the server (the cache offline) through the
     * model's root load, in the model mutex: no record is replaced, so an edit or a
     * save made meanwhile waits and applies to the refreshed record. Unsaved changes
     * are kept, and the controller's `onRootLoaded` then reapplies the state of the
     * lead's queued calls. Nothing happens once the model shows another record.
     *
     * - `dropRestored`: drops the changes still holding the values restored from the
     *   record's queued save, which left the queue: replayed, the server has them;
     *   discarded, a later save must not queue them again;
     * - `save` (online, a lead with an id): then saves the kept changes from the
     *   refreshed values, so the email and phone synchronized with the partner are
     *   the server's current ones.
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
     * unsaved edits (the offline systray handed that save over to the form): the
     * record is dirty while it holds them, so the form shows them unsaved, and saving
     * or leaving it writes them. A record without changes keeps its dirty state.
     */
    crmAdoptRestoredChanges() {
        this._crmRestored = null;
        this._crmChildren = null;
        if (Object.keys(this._changes).length) {
            this.dirty = true;
        }
    }

    /**
     * @override
     * Remembers the changes the restoration of the lead's queued save put in the
     * form (with the values an onchange derived from them), so a reconciliation
     * can tell them from edits made afterwards.
     *
     * It also remembers, for each many2many field of a lead with an id, the commands
     * the restoration put in the field's list, which are that queued save's:
     * - each record creation, under the new virtual id the list gives it, is mapped
     *   to the creation of the queued save it stands for, with the values it was
     *   restored with (`crmAlignRestoredCreates`), in the registry of the records the
     *   lead's queued saves create (`_crmChildren`, which it starts anew): that
     *   record stays that creation for as long as the save stays queued, through
     *   later saves of the form (`_crmSplitCommands`);
     * - the other commands (links, unlinks, updates, a set or a clear), in
     *   `_crmRestored.commands`, for as long as the form holds the restored changes,
     *   with the save's key (`_crmRestored.key`) and the number of its deliveries the
     *   replay had made when it was restored (`_crmRestored.delivered`,
     *   `crmDeliveredArgs`), so that a later save tells whether that save is still
     *   queued, was delivered since, or left the queue undelivered (`_crmRestoration`).
     *
     * Opened without a queue key, the form restores the record's own queued save
     * (`_crmOwnQueuedSaveKey`), never a follow-up write of it (`_offlineSave`), which
     * the form shows as a later queued write instead (`crmShowQueuedWrites`).
     *
     * A new lead restored from its queued create takes that create's delivery key
     * (`_crmAdoptCreateKey`), so its later saves, queued or online, name the same
     * lead, each as a later save of it.
     *
     * @param {string} [id] queue key of the save to restore (offline systray)
     */
    setOfflineChanges(id) {
        const listedBefore = this._crmListedCommands();
        const restoration = super.setOfflineChanges(id || this._crmOwnQueuedSaveKey());
        if (!restoration) {
            return restoration;
        }
        this._crmAdoptCreateKey();
        const key = this._offlineId;
        const delivered = crmDeliveredArgs(this.model.offlinePlugin, key).length;
        return restoration.then((result) => {
            const signatures = {};
            for (const fieldName in this._changes) {
                signatures[fieldName] = this._crmChangeSignature(fieldName);
            }
            const commands = this._crmRememberRestoredCommands(key, listedBefore);
            this._crmRestored = markRaw({
                changes: this._changes,
                signatures,
                commands,
                key,
                delivered,
            });
            return result;
        });
    }

    /**
     * The commands each many2many list of the record holds, in comparable form
     * (`crmJson`), by field.
     *
     * @returns {Object<string, string[]>}
     */
    _crmListedCommands() {
        const listed = {};
        for (const fieldName in this.activeFields) {
            if (this.fields[fieldName]?.type === "many2many" && this.data[fieldName]) {
                listed[fieldName] = this.data[fieldName]._getCommands().map(crmJson);
            }
        }
        return listed;
    }

    /**
     * Remembers the commands the restoration of the queued save `key` put in the
     * many2many lists of the lead (those the lists hold now and did not hold before,
     * `listedBefore`), for the fields that save writes (`setOfflineChanges`). A record
     * without an id, or a save that is not queued, leaves nothing to remember.
     *
     * @param {string} key
     * @param {Object<string, string[]>} listedBefore `_crmListedCommands` before it
     * @returns {Object<string, any[][]>} the restored commands other than creations,
     *   by field
     */
    _crmRememberRestoredCommands(key, listedBefore) {
        this._crmChildren = null;
        const queuedValues = this.model.offlinePlugin._ormToSync()[key]?.value.args?.[1];
        if (this.resModel !== "crm.lead" || !this.resId || !isFieldMapping(queuedValues)) {
            return {};
        }
        const commands = {};
        const children = markRaw(new Map());
        for (const fieldName in this._changes) {
            const field = this.fields[fieldName];
            if (field?.type !== "many2many" || !Array.isArray(queuedValues[fieldName])) {
                continue;
            }
            const before = [...(listedBefore[fieldName] || [])];
            const added = this._changes[fieldName]._getCommands().filter((command) => {
                const index = before.indexOf(crmJson(command));
                if (index < 0) {
                    return true;
                }
                before.splice(index, 1);
                return false;
            });
            commands[fieldName] = added.filter((command) => !isCreateCommand(command));
            const aligned = crmAlignRestoredCreates(
                added.filter(isCreateCommand),
                queuedValues[fieldName]
            );
            const registered = new Map();
            for (const [virtualId, target] of aligned) {
                registered.set(virtualId, { key, ...target });
            }
            children.set(fieldName, registered);
        }
        this._crmChildren = children;
        return commands;
    }

    /**
     * Records the creations of the record's x2many lists that the queued save `key`
     * holds, just written by this save, in the registry of the records the lead's
     * queued saves create (`_crmChildren`): those whose virtual id is one of
     * `created` (the creations the lists held for this save, `_crmListedCreations`),
     * with their index in that save and the values written. A record without an id,
     * or a save that is not queued, records nothing.
     *
     * @param {string|undefined} key
     * @param {Map<string, Set<string>>} created virtual ids of the creations, by field
     */
    _crmRegisterQueuedChildren(key, created) {
        const values = key && this.model.offlinePlugin._ormToSync()[key]?.value.args?.[1];
        if (this.resModel !== "crm.lead" || !this.resId || !isFieldMapping(values)) {
            return;
        }
        for (const [fieldName, virtualIds] of created) {
            const commands = values[fieldName];
            if (!Array.isArray(commands)) {
                continue;
            }
            commands.forEach((command, index) => {
                if (!isCreateCommand(command) || !virtualIds.has(command[1])) {
                    return;
                }
                if (!this._crmChildren) {
                    this._crmChildren = markRaw(new Map());
                }
                if (!this._crmChildren.has(fieldName)) {
                    this._crmChildren.set(fieldName, new Map());
                }
                this._crmChildren
                    .get(fieldName)
                    .set(command[1], { key, id: command[1], index, values: command[2] || {} });
            });
        }
    }

    /**
     * Virtual ids of the record creations each x2many list of the record holds, by
     * field: the creations a save writes now.
     *
     * @returns {Map<string, Set<string>>}
     */
    _crmListedCreations() {
        const created = new Map();
        for (const fieldName in this.activeFields) {
            const list = this.data[fieldName];
            if (!X2MANY_TYPES.includes(this.fields[fieldName]?.type) || !list) {
                continue;
            }
            const virtualIds = list
                ._getCommands()
                .filter(isCreateCommand)
                .map((command) => command[1]);
            if (virtualIds.length) {
                created.set(fieldName, new Set(virtualIds));
            }
        }
        return created;
    }

    /**
     * Records of the x2many list `fieldName` that a queued save of the lead creates,
     * by virtual id (`children`): each record of the registry (`_crmChildren`) whose
     * creation the save it names still holds, with that save (`key`), the creation's
     * index there (`index`), the values the record had when the creation was last
     * written or restored (`values`), and whether a replay sent that save as it holds
     * it now (`sent`: in flight, or delivered and about to leave the queue,
     * `isCrmReplaySent`). The registered records whose creation left the queue are
     * the `delivered` ones when the replay delivered a save of that key holding it
     * (`crmDeliveredArgs`): the server created them; the others (discarded) are the
     * `gone` ones, which the server never created.
     *
     * @param {string} fieldName
     * @returns {{children: Map<string, {key: string, index: number, values: Object, sent: boolean}>, delivered: Set<string>, gone: Set<string>}}
     */
    _crmQueuedChildren(fieldName) {
        const children = new Map();
        const delivered = new Set();
        const gone = new Set();
        const registered = this._crmChildren?.get(fieldName);
        if (!registered) {
            return { children, delivered, gone };
        }
        const plugin = this.model.offlinePlugin;
        const queue = plugin._ormToSync();
        const createIndex = (args, target) =>
            crmQueuedCreateIndex(
                isFieldMapping(args?.[1]) ? args[1][fieldName] : undefined,
                target
            );
        for (const [virtualId, target] of registered) {
            const entry = queue[target.key];
            const index = createIndex(entry?.value.args, target);
            if (index >= 0) {
                children.set(virtualId, {
                    key: target.key,
                    index,
                    values: target.values,
                    sent: isCrmReplaySent(plugin, entry),
                });
            } else if (
                crmDeliveredArgs(plugin, target.key).some((args) => createIndex(args, target) >= 0)
            ) {
                delivered.add(virtualId);
            } else {
                gone.add(virtualId);
            }
        }
        return { children, delivered, gone };
    }

    /**
     * x2many fields whose commands a save splits even when its changes leave them out
     * (a list without commands, `_getChanges`): those holding commands restored from
     * the record's queued save, while the form holds them, and those with records a
     * queued save of the lead creates (`_crmChildren`).
     *
     * @returns {string[]}
     */
    _crmTrackedX2ManyFields() {
        const restoration = this._crmRestored;
        const fieldNames = new Set(this._crmChildren?.keys() || []);
        if (restoration && restoration.changes === this._changes) {
            for (const fieldName in restoration.commands || {}) {
                fieldNames.add(fieldName);
            }
        }
        return [...fieldNames].filter((fieldName) => fieldName in this._changes);
    }

    /**
     * @override
     * An offline save made after the record's previous one left the queue
     * (replayed or discarded) queues its own changes only, at its own time. The
     * email and phone forced for a partner the lead no longer has, or superseded by
     * a partner change, are not queued (`_crmDropStaleForcedContacts`).
     *
     * The record's own pending queued save keeps its values, its commands and its
     * time, and this save's edits are queued in a follow-up `web_save` (`crmFollowUp`
     * extra) after every queued call of the lead instead (`_crmQueueFollowUpWrite`),
     * while a replay runs (it may have read that save, and would then lose values
     * merged into it), or when this save or that one holds x2many commands (merged,
     * earlier commands would be dropped, or replayed too early):
     * `_crmKeepsOwnQueuedSave`. The x2many records a queued save of the lead creates
     * keep being created by it, once: their edits and removals rewrite that save
     * instead of reaching the follow-up (`_crmOwnSaveFollowUp`,
     * `_crmRewriteQueuedChildren`).
     *
     * Otherwise the framework queues every offline save of a record under its first
     * queued save's key and time stamp, and replays the queue in time-stamp order.
     * This save would then replay before a call of the lead queued since (through
     * another record of the lead, such as its pipeline card, or "Won") that writes a
     * field of the lead, and lose to it, although the user made it last: to its
     * values, or to the fields the server recomputes from them. Such a save is
     * ordered after every queued call of the lead (`_crmPlanOfflineSave`):
     * - the record's queued save moves to that time when it holds no other value
     *   than this save's and no x2many command (moving it then changes no older
     *   value);
     * - otherwise it keeps its time, so the values and commands it already held stay
     *   before the later calls, and the fields of this save are queued again in a
     *   follow-up `web_save` after every queued call of the lead; its x2many fields
     *   keep the commands they held, with the record creations rewritten as the form
     *   left them, and display values matching them (`_crmKeepQueuedCommands`).
     * A save merged by the framework into the record's queued save holding x2many
     * commands (no later call of the lead) keeps those commands, rewritten the same
     * way, followed by this save's own (`_crmKeepQueuedCommands`). A save whose list
     * commands the framework queues as they are (no queued save holding x2many
     * commands, such as once the record's queued save was replayed) leaves those
     * naming what a queued save of the lead does to that save (`_crmLeftOutX2Many`).
     * Every other save (a creation, another model) is the framework's.
     *
     * The queued create of a new lead carries the lead's delivery key in its context
     * (`CRM_OFFLINE_CREATE_KEY`), through the parent's `_offlineSave`, so the server
     * creates that lead once.
     */
    _offlineSave() {
        this._crmForgetUnqueuedOfflineSave();
        this._crmDropStaleForcedContacts();
        const created = this._crmListedCreations();
        if (untrack(() => this._crmKeepsOwnQueuedSave())) {
            const { followUp, children } = untrack(() => this._crmOwnSaveFollowUp());
            untrack(() => this._crmRewriteQueuedChildren(children));
            if (followUp) {
                const key = this._crmQueueFollowUpWrite(followUp);
                untrack(() => this._crmRegisterQueuedChildren(key, created));
            }
            this._commitSave();
            return true;
        }
        const plan = this._crmPlanOfflineSave();
        if (plan.timeStamp) {
            this._offlineTimeStamp = plan.timeStamp;
        }
        const result = super._offlineSave(...arguments);
        if (plan.queuedX2Many) {
            untrack(() => this._crmKeepQueuedCommands(plan.queuedX2Many, plan.ownChildren));
        }
        untrack(() => this._crmRegisterQueuedChildren(this._offlineId, created));
        if (plan.otherChildren) {
            untrack(() => this._crmRewriteQueuedChildren(plan.otherChildren));
        }
        if (plan.followUp) {
            const key = this._crmQueueFollowUpWrite(plan.followUp);
            untrack(() => this._crmRegisterQueuedChildren(key, created));
        }
        return result;
    }

    /**
     * Whether this offline save of the lead leaves the record's own queued save
     * (`offlineId`, pending: queued, not parked) exactly as it is, and queues its
     * edits in a follow-up write after every queued call of the lead instead
     * (`_offlineSave`). So:
     * - while a replay runs: the replay may have read that save already, and it then
     *   sends the values it read and removes or parks the entry under its key,
     *   whatever the entry holds by then, so values merged into it would be lost;
     * - when this save writes an x2many field: merged, its commands would replay at
     *   the queued save's time, before a later queued write of the lead, and lose to
     *   it, while moving that save to a later time would reorder its older values;
     * - when that save holds x2many commands: the framework's merge rebuilds them
     *   from the lists' current commands, which hold this save's only (the earlier
     *   ones were cleared once queued), so the earlier ones would never be sent.
     * The follow-up holds this save's own commands only, never one of that save's
     * (restored into the form) nor one naming a record a queued save creates
     * (`_crmOwnSaveFollowUp`), so no command is sent twice; the edits and removals of
     * such records rewrite the save creating them while it is not sent
     * (`_crmRewriteQueuedChildren`). A record without an id, or without such a save,
     * is the framework's. It reads the plugin's queue and sync signals.
     *
     * @returns {boolean}
     */
    _crmKeepsOwnQueuedSave() {
        if (this.resModel !== "crm.lead" || !this.resId || !this._offlineId) {
            return false;
        }
        const plugin = this.model.offlinePlugin;
        const own = plugin._ormToSync()[this._offlineId];
        if (!own || own.value.extras?.error) {
            return false;
        }
        const isX2Many = (fieldName) => X2MANY_TYPES.includes(this.fields[fieldName]?.type);
        const queuedValues = own.value.args?.[1];
        return (
            plugin.syncingORM() ||
            Object.keys(this._getChanges()).some(isX2Many) ||
            (isFieldMapping(queuedValues) && Object.keys(queuedValues).some(isX2Many))
        );
    }

    /**
     * @typedef {Object} CrmQueuedChild a record of an x2many list of the form that a
     *  queued save of the lead creates (`_crmSplitCommands`)
     * @property {string} fieldName
     * @property {string} virtualId its virtual id in the list
     * @property {string} key the queued save creating it
     * @property {number} index the creation's index in that save's commands of the field
     * @property {boolean} present whether the list still holds it
     * @property {boolean} sent whether a replay sent that save as it holds it now
     *  (`isCrmReplaySent`)
     * @property {Object} values the values the user changed since the creation was
     *  last written or restored
     * @property {Object|undefined} current its values in the list, when it holds a
     *  command of it
     */

    /**
     * The follow-up write of this save when it leaves the record's own queued save as
     * it is (`_crmKeepsOwnQueuedSave`), or when that save keeps its time before a later
     * write of the lead (`_crmPlanOfflineSave`): every field it writes (`_getChanges`,
     * x2many commands included), except values restored from that save and unmodified
     * since (`crmRestoredUnmodifiedFields`), which that save still sends. The commands
     * of each x2many field are split (`_crmSplitCommands`, for the fields whose
     * list holds no command as well, `_crmTrackedX2ManyFields`): the follow-up holds
     * this save's own commands, and the inverse of each link or unlink restored from
     * that save that the user undid; the commands that save holds, and those naming a
     * record a queued save of the lead creates, are left out, so that no command, a
     * record creation included, is sent twice. Those records are returned (`children`),
     * for the save creating each to be rewritten as the form leaves them
     * (`_crmRewriteQueuedChildren`). The follow-up is `null` when nothing is left to
     * write.
     *
     * @returns {{followUp: {values: Object, changes: Object, originalValues: Object}|null, children: CrmQueuedChild[]}}
     */
    _crmOwnSaveFollowUp() {
        const written = this._getChanges();
        delete written.id;
        const restored = this.crmRestoredUnmodifiedFields();
        const fieldNames = new Set([...Object.keys(written), ...this._crmTrackedX2ManyFields()]);
        const children = [];
        const edits = [...fieldNames].filter((fieldName) => {
            if (restored.includes(fieldName)) {
                return false;
            }
            if (!X2MANY_TYPES.includes(this.fields[fieldName].type)) {
                return true;
            }
            const split = this._crmSplitCommands(fieldName, written[fieldName] || []);
            children.push(...split.children);
            written[fieldName] = split.commands;
            return split.commands.length > 0;
        });
        return {
            followUp: edits.length ? this._crmFollowUpWrite(written, edits) : null,
            children,
        };
    }

    /**
     * Splits the commands `commands` of the x2many field `fieldName` (its list's,
     * `_getChanges`) between this save's own commands and the lead's queued saves:
     * - a command naming a record a queued save of the lead creates
     *   (`_crmQueuedChildren`: its creation, an update or a removal of it) is that
     *   save's, whatever its values: it is left out, and the record is returned in
     *   `children`, still in the list or not, with the values the user changed since
     *   its creation was last written or restored;
     * - a command naming a record whose creation the replay delivered (the server
     *   created it, under an id the form does not know) is left out, its creation
     *   included: the record is created once, by that save;
     * - an update or a removal of a record whose creation left the queue undelivered
     *   names no record the server knows: it is left out; its creation is this
     *   save's own, the server never made it;
     * - while the form holds the changes restored from the record's queued save, and
     *   that save is still queued or was delivered since (`_crmRestoration`), each
     *   command the restoration put in the list (`_crmRestored.commands`, a link, an
     *   unlink, an update...) equal to one of them is that save's, and is left out once;
     *   a restored link whose record the user removed, or a restored unlink whose record
     *   the user added back, gets its inverse ahead of this save's commands, unless
     *   those already name that record or set the whole list. Once that save left the
     *   queue undelivered (discarded), its commands are this save's own;
     * - every other command is this save's own, in its order.
     *
     * Besides `commands` (the inverses, then this save's own commands), the split
     * returns them apart (`inverses`, `own`), the restoration whose commands took part
     * (`restoration`: one was left out, or an inverse added; `null` otherwise), and
     * whether anything of a queued save took part at all (`named`: a command was left
     * out, an inverse added, or the field holds records a queued save creates).
     *
     * @param {string} fieldName
     * @param {any[]} commands
     * @returns {{commands: any[], own: any[], inverses: any[], children: CrmQueuedChild[], restoration: {key: string, sent: boolean}|null, named: boolean}}
     */
    _crmSplitCommands(fieldName, commands) {
        const { CREATE, UPDATE, DELETE, UNLINK, LINK, CLEAR, SET } = x2ManyCommands;
        const currentIds = this.data[fieldName]?.currentIds || [];
        const { children: queuedChildren, delivered, gone } = this._crmQueuedChildren(fieldName);
        const restoration = this._crmRestoration();
        const restored = restoration?.commands[fieldName] || [];
        const pool = restored.map(crmJson);
        const currentValues = new Map();
        const own = [];
        let leftOut = 0;
        let restoredLeftOut = false;
        for (const command of commands) {
            if (RECORD_COMMANDS.includes(command[0]) && queuedChildren.has(command[1])) {
                if (command[0] === CREATE || command[0] === UPDATE) {
                    currentValues.set(command[1], command[2] || {});
                }
                leftOut++;
                continue;
            }
            if (
                RECORD_COMMANDS.includes(command[0]) &&
                (delivered.has(command[1]) || (command[0] !== CREATE && gone.has(command[1])))
            ) {
                leftOut++;
                continue;
            }
            const index = pool.indexOf(crmJson(command));
            if (index >= 0) {
                pool.splice(index, 1);
                leftOut++;
                restoredLeftOut = true;
                continue;
            }
            own.push(command);
        }
        const inverses = [];
        if (!own.some(([type]) => type === SET || type === CLEAR)) {
            const ownNames = (id, types) =>
                own.some((command) => types.includes(command[0]) && command[1] === id);
            for (const [type, id] of restored) {
                if (type === LINK && !currentIds.includes(id) && !ownNames(id, [UNLINK, DELETE])) {
                    inverses.push([UNLINK, id]);
                } else if (type === UNLINK && currentIds.includes(id) && !ownNames(id, [LINK])) {
                    inverses.push([LINK, id]);
                }
            }
        }
        const children = [];
        for (const [virtualId, child] of queuedChildren) {
            const present = currentIds.includes(virtualId);
            const current = present ? currentValues.get(virtualId) : undefined;
            const edited = Object.keys(current || {}).filter(
                (name) => crmJson(current[name]) !== crmJson(child.values[name])
            );
            children.push({
                fieldName,
                virtualId,
                key: child.key,
                index: child.index,
                present,
                sent: child.sent,
                values: pick(current || {}, ...edited),
                current,
            });
        }
        return {
            commands: [...inverses, ...own],
            own,
            inverses,
            children,
            restoration:
                restoredLeftOut || inverses.length
                    ? { key: restoration.key, sent: restoration.sent }
                    : null,
            named: leftOut > 0 || inverses.length > 0 || children.length > 0,
        };
    }

    /**
     * The changes restored from the record's queued save (`_crmRestored`, set by
     * `setOfflineChanges`) while the form holds them and that save still stands: it
     * is queued under its key, or the replay delivered it under that key since it
     * was restored (`crmDeliveredArgs`). With `sent`, whether the server has those
     * changes or receives them (a replay sent the queued save as it holds it now, in
     * flight or delivered: `isCrmReplaySent`; or delivered it since) rather than
     * still waiting for them (pending, or parked). `null` when the form holds no such
     * changes, or once that save left the queue undelivered (discarded): the
     * restored commands are then the form's own. A save holding no x2many command
     * restored none, and its delivery is not recorded: it reads as `null` once
     * delivered.
     *
     * @returns {{key: string, commands: Object<string, any[][]>, sent: boolean}|null}
     */
    _crmRestoration() {
        const restoration = this._crmRestored;
        if (!restoration || restoration.changes !== this._changes || !restoration.key) {
            return null;
        }
        const plugin = this.model.offlinePlugin;
        const entry = plugin._ormToSync()[restoration.key];
        let sent;
        if (entry) {
            sent = isCrmReplaySent(plugin, entry);
        } else if (crmDeliveredArgs(plugin, restoration.key).length > restoration.delivered) {
            sent = true;
        } else {
            return null;
        }
        return { key: restoration.key, commands: restoration.commands || {}, sent };
    }

    /**
     * Rewrites each queued save creating one of `children` (`_crmSplitCommands`) as
     * the form leaves those records: a creation none of whose records is still in the
     * list is dropped, one whose records were edited takes their edited values over
     * its own, at its place and with its own virtual id (`crmRewrittenCreates`), and
     * the display values of the field (`extras.changes`) match the new commands
     * (`_crmQueuedDisplayValue`). The save keeps its other values, its keyword
     * arguments, its key, its time stamp and its other extras, an error included; a
     * running replay that has not reached it yet sends it as rewritten
     * (`rewriteCrmQueuedCall`).
     *
     * A save that a replay is sending, or has delivered (`isCrmReplaySent`), is left
     * as it is: its records are created once, by it, with the values it was sent with,
     * and the later edits and removals of those records are not written.
     *
     * @param {CrmQueuedChild[]} children
     */
    _crmRewriteQueuedChildren(children) {
        const plugin = this.model.offlinePlugin;
        for (const key of new Set(children.map((child) => child.key))) {
            const entry = plugin._ormToSync()[key];
            const values = entry?.value.args?.[1];
            if (!isFieldMapping(values) || isCrmReplaySent(plugin, entry)) {
                continue;
            }
            const ofEntry = children.filter((child) => child.key === key);
            const rewritten = {};
            const changes = { ...entry.value.extras?.changes };
            for (const fieldName of new Set(ofEntry.map((child) => child.fieldName))) {
                const commands = crmRewrittenCreates(
                    Array.isArray(values[fieldName]) ? values[fieldName] : [],
                    ofEntry.filter((child) => child.fieldName === fieldName)
                );
                if (commands) {
                    rewritten[fieldName] = commands;
                    changes[fieldName] = this._crmQueuedDisplayValue(
                        fieldName,
                        commands,
                        changes[fieldName]
                    );
                }
            }
            if (!Object.keys(rewritten).length) {
                continue;
            }
            const args = [entry.value.args[0], { ...values, ...rewritten }];
            if (rewriteCrmQueuedCall(plugin, key, args, { ...entry.value.extras, changes })) {
                this._crmChildrenWritten(ofEntry);
            }
        }
    }

    /**
     * Updates the registry of the records the lead's queued saves create
     * (`_crmChildren`) once the saves creating `children` were rewritten as the form
     * leaves them: a removed record leaves it, an edited one is known by its new
     * values.
     *
     * @param {CrmQueuedChild[]} children
     */
    _crmChildrenWritten(children) {
        for (const child of children) {
            const registered = this._crmChildren?.get(child.fieldName);
            const target = registered?.get(child.virtualId);
            if (!target) {
                continue;
            }
            if (!child.present) {
                registered.delete(child.virtualId);
            } else if (child.current) {
                target.values = { ...child.current };
            }
        }
    }

    /**
     * Display value (`extras.changes`) of a queued save's commands `commands` of the
     * x2many field `fieldName`, as the framework formats a many2many list's
     * (`_formatOfflineValues`): the commands, and the display names, joined, of the
     * records the field holds once they apply to those it held as loaded (`resIds`),
     * a creation shown by its values, another record by its copy in the list (a
     * record the list never loaded is not named). Another x2many field keeps its
     * display value (`previous`).
     *
     * @param {string} fieldName
     * @param {any[]} commands
     * @param {any} previous
     * @returns {any}
     */
    _crmQueuedDisplayValue(fieldName, commands, previous) {
        if (this.fields[fieldName]?.type !== "many2many") {
            return previous;
        }
        const { CREATE, DELETE, UNLINK, LINK, CLEAR, SET } = x2ManyCommands;
        const list = this.data[fieldName];
        let held = (list?.resIds || []).map((id) => ({ id }));
        for (const command of commands) {
            switch (command[0]) {
                case CREATE:
                    held.push({ values: command[2] || {} });
                    break;
                case LINK:
                    if (!held.some(({ id }) => id === command[1])) {
                        held.push({ id: command[1] });
                    }
                    break;
                case DELETE:
                case UNLINK:
                    held = held.filter(({ id }) => id !== command[1]);
                    break;
                case CLEAR:
                    held = [];
                    break;
                case SET:
                    held = (command[2] || []).map((id) => ({ id }));
                    break;
            }
        }
        const names = held.map(({ id, values }) => {
            if (values) {
                return getOfflineDisplayName({ data: values });
            }
            const record = list?._cache[id];
            return record ? getOfflineDisplayName(record) : null;
        });
        return { commands, display_name: names.filter(Boolean).join(", ") };
    }

    /**
     * Writes into the record's own queued save, just written by the framework's
     * offline save (`_offlineSave`), the x2many commands `kept` gives
     * (`_crmPlanOfflineSave`). The framework rebuilds that save's x2many commands from
     * the lists' current commands: once a save is queued they are cleared, so the
     * commands that save held earlier would be dropped, and the restoration of that
     * save gives its record creations new virtual ids and only the values the list
     * shows. So each x2many field `kept` names sends the commands it gives, at that
     * save's time: the commands the save held, with their record creations rewritten
     * as the form leaves them, followed by this save's own ones when they are merged
     * into it. Every other x2many field of that save is dropped from it (this save's
     * commands of it are queued in a follow-up write). Its display values follow
     * (`extras.changes`: the one `kept` gives, else the framework's display names with
     * the kept commands), as do the values it replaces (`extras.originalValues`: the
     * ones that save held before, when `kept` gives them). Its other values and its
     * other extras (time stamp included) stay as the framework wrote them; a field
     * that is neither a many2many field nor given display values by `kept` keeps the
     * framework's. The registry of the records the lead's queued saves create then
     * knows the rewritten ones (`children`, `_crmChildrenWritten`).
     *
     * @param {Object<string, {commands: any[], changes?: Object, originalValue?: any}>} kept
     *  by field
     * @param {CrmQueuedChild[]} [children] the records of that save it rewrites
     */
    _crmKeepQueuedCommands(kept, children = []) {
        const plugin = this.model.offlinePlugin;
        const entry = plugin._ormToSync()[this._offlineId];
        const values = entry?.value.args?.[1];
        if (!isFieldMapping(values)) {
            return;
        }
        const fieldNames = [...new Set([...Object.keys(values), ...Object.keys(kept)])];
        const x2ManyFields = fieldNames.filter((fieldName) =>
            X2MANY_TYPES.includes(this.fields[fieldName]?.type)
        );
        if (!x2ManyFields.length) {
            return;
        }
        const args = { ...values };
        const changes = { ...entry.value.extras?.changes };
        const originalValues = { ...entry.value.extras?.originalValues };
        for (const fieldName of x2ManyFields) {
            if (!(fieldName in kept)) {
                delete args[fieldName];
                delete changes[fieldName];
                delete originalValues[fieldName];
                continue;
            }
            const { commands } = kept[fieldName];
            args[fieldName] = commands;
            if (kept[fieldName].changes !== undefined) {
                changes[fieldName] = kept[fieldName].changes;
            } else if (this.fields[fieldName].type === "many2many") {
                changes[fieldName] = isFieldMapping(changes[fieldName])
                    ? { ...changes[fieldName], commands }
                    : this._crmQueuedDisplayValue(fieldName, commands, undefined);
            }
            if ("originalValue" in kept[fieldName]) {
                originalValues[fieldName] = kept[fieldName].originalValue;
            }
        }
        plugin.scheduleORM(
            entry.value.model,
            entry.value.method,
            [entry.value.args[0], args],
            entry.value.kwargs,
            { id: this._offlineId, extras: { ...entry.value.extras, changes, originalValues } }
        );
        this._crmChildrenWritten(children);
    }

    /**
     * The follow-up write (`_crmQueueFollowUpWrite`) of the fields `fieldNames` of
     * this save: their server values (`written`, x2many commands included), and the
     * display values of the change and of the values it replaces, as the framework
     * queues them, the commands of a many2many change being those it writes.
     *
     * @param {Object} written the save's server values (`_getChanges`)
     * @param {string[]} fieldNames
     * @returns {{values: Object, changes: Object, originalValues: Object}}
     */
    _crmFollowUpWrite(written, fieldNames) {
        const changes = this._formatOfflineValues(pick(this._changes, ...fieldNames));
        for (const fieldName of fieldNames) {
            if (this.fields[fieldName].type === "many2many" && isFieldMapping(changes[fieldName])) {
                changes[fieldName].commands = written[fieldName];
            }
        }
        return {
            values: pick(written, ...fieldNames),
            changes,
            originalValues: this._formatOfflineValues(pick(this._values, ...fieldNames), {
                changes: false,
            }),
        };
    }

    /**
     * Takes the delivery key (`CRM_OFFLINE_CREATE_KEY`) of the queued create this new
     * lead was just restored from (`offlineId`), when it has a valid one: that create
     * is a delivery of the key (`_crmCreateKeyDelivered`), so every later save of the
     * still-new lead, queued or online, is a later save of the lead it names
     * (`CRM_OFFLINE_CREATE_WRITE`). A queued create without one leaves the record as
     * it is.
     */
    _crmAdoptCreateKey() {
        if (this.resModel !== "crm.lead" || this.resId || !this._offlineId) {
            return;
        }
        const entry = this.model.offlinePlugin._ormToSync()[this._offlineId];
        const key = entry?.value.kwargs?.context?.[CRM_OFFLINE_CREATE_KEY];
        if (isCrmOfflineCreateKey(key)) {
            const record = toRaw(this);
            record._crmCreateKey = key;
            record._crmCreateKeyDelivered = true;
        }
    }

    /**
     * @override
     * During a `crmRefresh` load, the loaded values replace the record's values
     * while its unsaved changes are kept, except those the refresh drops. Values an
     * offline save of this record committed stay while that save is still queued
     * (pending or parked), as neither the server nor the cache has them yet. Every
     * other call (the record's creation, other loads, a save's reload) is the
     * parent's, except that an update keeping the changes (the server's read of a
     * root first served from the cache) leaves a record holding changes restored
     * from its queued save (or handed over by the offline systray) dirty, as it was:
     * those changes are still unsaved, and saving or leaving the form writes them.
     * Either way, the lead's email and phone are remembered as loaded, before any
     * queued value is applied over them (`_crmRememberLoadedContacts`).
     * A parent call that resets the changes also ends the state of a partner change
     * whose onchange was lost (`_getOnchangeValues`): the changes it concerned are
     * gone. A call that keeps them, like a `crmRefresh` load, keeps that state.
     */
    _setData(data, options = {}) {
        const refresh = this._crmRefreshState;
        if (!refresh || refresh.saving) {
            const keepsRestoredEdits =
                Boolean(options.keepChanges) && this.dirty && Boolean(this._offlineChanges);
            super._setData(...arguments);
            this._crmRememberLoadedContacts();
            if (!options.keepChanges) {
                this._crmPartnerOnchangeLost = false;
                this._crmRevertedContacts = undefined;
            }
            if (keepsRestoredEdits && Object.keys(this._changes).length) {
                this.dirty = true;
            }
            return;
        }
        for (const fieldName of refresh.dropFields) {
            delete this._changes[fieldName];
        }
        const queuedValues = this._crmQueuedSaveValues();
        super._setData(data, { ...options, keepChanges: true });
        this._crmRememberLoadedContacts();
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
     * would be created again), the connection is still up after the load and the
     * form holds a change to write: a change the framework sees (`_getChanges`), or
     * the inverse of a command restored from the record's replayed save that the user
     * undid, in a list then left without commands (`_crmSentChanges`). The CRM save
     * leaves out what the replayed save did (`_crmSaveLeavingQueuedCommands`): when
     * nothing else is left, it sends nothing and the form shows the refreshed values.
     * A save that does not happen (invalid record) leaves the changes in the form.
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
        const sent = this._crmSentChanges({ ...toWrite });
        if (!Object.keys(toWrite).length && !Object.keys(sent).length) {
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
     * Remembers the lead's email and phone (`FORCED_CONTACT_FLAGS`) as the record
     * values just loaded from the server (or the cache offline), for
     * `_crmDropStaleForcedContacts`. Only the fields the record loads are kept, and
     * a record without an id (a new lead) remembers nothing.
     */
    _crmRememberLoadedContacts() {
        if (this.resModel !== "crm.lead" || !this.resId) {
            this._crmLoadedContacts = undefined;
            return;
        }
        const contacts = {};
        for (const fieldName in FORCED_CONTACT_FLAGS) {
            if (fieldName in this._values) {
                contacts[fieldName] = this._values[fieldName];
            }
        }
        this._crmLoadedContacts = markRaw(contacts);
    }

    /**
     * Drops the email and phone forced for a partner the lead no longer has, and
     * those a partner change superseded, before an offline save, and before any
     * save once a partner change lost its onchange (`_crmPartnerOnchangeLost`).
     *
     * Offline, the saves of a lead are merged into one queued write: the changes of
     * its still-queued save, which reopening the lead also restores into the form,
     * plus its new ones. While the lead keeps its partner, the CRM save forces its
     * unchanged email and phone into those changes, so that the server synchronizes
     * them with the partner. Once another partner is chosen offline, the flags of
     * that synchronization are unset, and the forced values would be written against
     * the new partner and overwrite its email and phone, by the replay or by a save
     * made once the connection is back. The server derives the lead's email and
     * phone from the new partner instead, as the online onchange does.
     *
     * So, for each contact field whose flag is unset (read as the CRM save reads
     * it), with a loaded value (`_crmLoadedContacts`):
     * - a change equal to the loaded value, or to the value a partner change gave
     *   back (`_crmRevertedContacts`), is removed from the record's changes and from
     *   its queued changes: the latest intent for the field is its stored value, and
     *   it supersedes the queued one, so the record holds the loaded value again;
     * - without a change, a queued value equal to the loaded one is removed;
     * - any other value, an edit of the user or an onchange value, is kept, as a
     *   value queued by an earlier save after the partner change is.
     * Every value is kept while its flag is set. A record that loaded nothing is
     * left as it is.
     *
     * @returns {boolean} whether a value was removed from the queued changes
     */
    _crmDropStaleForcedContacts() {
        const loaded = this._crmLoadedContacts;
        let queuedDropped = false;
        if (this.resModel !== "crm.lead" || !loaded) {
            return queuedDropped;
        }
        const reverted = this._crmRevertedContacts || {};
        for (const [fieldName, flagName] of Object.entries(FORCED_CONTACT_FLAGS)) {
            const needsSynchronization =
                this._changes[flagName] === undefined
                    ? this._values[flagName]
                    : this._changes[flagName];
            if (needsSynchronization || !(fieldName in loaded)) {
                continue;
            }
            const value = loaded[fieldName];
            const queued = this._offlineChanges;
            if (fieldName in this._changes) {
                const change = this._changes[fieldName];
                if (
                    change !== value &&
                    !(fieldName in reverted && change === reverted[fieldName])
                ) {
                    continue;
                }
                delete this._changes[fieldName];
            } else if (!queued || !(fieldName in queued) || queued[fieldName] !== value) {
                continue;
            }
            if (queued && fieldName in queued) {
                delete queued[fieldName];
                queuedDropped = true;
                if (this._crmIsOwnSaveQueued()) {
                    // The value the queued save committed is no longer queued.
                    this._values[fieldName] = value;
                }
            }
        }
        return queuedDropped;
    }

    /**
     * Writes the record's queued changes (`_offlineChanges`) into its own offline
     * save while that save is still queued, at its key and with its other extras:
     * its time stamp, and the error of a parked save, which stays parked. A save
     * sent while that save is still queued (parked, or pending while the connection
     * is up) is written before the queue replays it, so the replay must not send the
     * values this save superseded. While the connection is reported lost, a save of
     * the lead with a pending write is queued instead (`_crmQueuesSave`).
     */
    _crmRescheduleOwnSave() {
        if (!this._crmIsOwnSaveQueued()) {
            return;
        }
        const { value } = this.model.offlinePlugin._ormToSync()[this._offlineId];
        const changes = this._getChanges(this._offlineChanges);
        delete changes.id;
        this.model.offlinePlugin.scheduleORM(
            value.model,
            value.method,
            [value.args[0], changes],
            value.kwargs,
            {
                id: this._offlineId,
                extras: {
                    ...value.extras,
                    changes: this._formatOfflineValues(this._offlineChanges),
                },
            }
        );
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

    /**
     * Shows on the form the values of the lead's queued saves made through other
     * records of it (its pipeline card, another form, a follow-up write), pending
     * or parked, as its pipeline card shows them: a field shows the value of the
     * last queued save writing it, in replay order. The record's own queued save
     * (`offlineId`) takes part at its time stamp: a field it writes shows another
     * save's value only when that save replays after it. Nothing is saved or
     * queued:
     * - a field holding the value restored from the record's queued save, and
     *   unmodified since (`crmRestoredUnmodifiedFields`), loses that change and
     *   shows the later value; the queued save keeps writing it at its own time.
     *   With `keepRestored` (the queued save is handed over to the form as its
     *   unsaved edits), it keeps the change, as an edit;
     * - a field the user edited keeps the edit;
     * - any other field shows the value as a loaded one, with no change.
     * Fields the form does not load, and fields whose display values are not
     * loaded values (`UNPROJECTED_TYPES`), are left as they are. Showing the same
     * entries again changes nothing.
     *
     * The display values (`extras.changes`) of scalar fields are server values
     * (the framework formats them with `_formatServerValue`, a many2one as
     * `{id, display_name}`), which `_applyValues` parses: they are given to it as
     * they are queued, copied.
     *
     * @param {{key: string, value: Object}[]} entries queued `web_save` entries of
     *   the lead, in replay order
     * @param {{keepRestored?: boolean}} [options]
     */
    crmShowQueuedWrites(entries, { keepRestored = false } = {}) {
        const ownEntry = this._crmIsOwnSaveQueued()
            ? this.model.offlinePlugin._ormToSync()[this._offlineId]
            : null;
        const ownTimeStamp = ownEntry?.value.extras?.timeStamp || 0;
        const ownFields = ownEntry ? Object.keys(this._offlineChanges || {}) : [];
        const restored = keepRestored ? [] : this.crmRestoredUnmodifiedFields();
        const values = {};
        for (const { key, value } of entries) {
            const changes = value.extras?.changes;
            if (
                key === this._offlineId ||
                value.method !== "web_save" ||
                !isFieldMapping(changes)
            ) {
                continue;
            }
            const replaysLater = (value.extras?.timeStamp || 0) > ownTimeStamp;
            for (const [fieldName, fieldValue] of Object.entries(changes)) {
                const field = this.fields[fieldName];
                if (
                    fieldName === "id" ||
                    !field ||
                    !(fieldName in this.activeFields) ||
                    UNPROJECTED_TYPES.includes(field.type) ||
                    (fieldName in this._changes && !restored.includes(fieldName)) ||
                    (ownFields.includes(fieldName) && !replaysLater)
                ) {
                    continue;
                }
                values[fieldName] = isFieldMapping(fieldValue) ? { ...fieldValue } : fieldValue;
            }
        }
        const fieldNames = Object.keys(values);
        if (!fieldNames.length) {
            return;
        }
        let droppedChange = false;
        for (const fieldName of fieldNames) {
            if (fieldName in this._changes) {
                delete this._changes[fieldName];
                droppedChange = true;
            }
        }
        if (droppedChange) {
            this.dirty = Object.keys(this._changes).length > 0;
        }
        this._applyValues(values);
    }

    /** Queued `crm.lead` calls (pending and parked) targeting the lead's id. */
    _crmLeadQueuedCalls() {
        const resId = this.resId;
        return Object.values(this.model.offlinePlugin._ormToSync()).filter(
            ({ value }) =>
                value.model === "crm.lead" &&
                Array.isArray(value.args?.[0]) &&
                value.args[0].includes(resId)
        );
    }

    /**
     * Key of the lead's queued save the framework restores into a form opened
     * without a queue key (`Record.setOfflineChanges`: a `web_save` of this record
     * queued by a form of the same action), follow-up writes excluded. `undefined`
     * when there is none (the framework's own search then applies), for another
     * model and for a new record.
     *
     * @returns {string|undefined}
     */
    _crmOwnQueuedSaveKey() {
        if (this.resModel !== "crm.lead" || !this.resId) {
            return undefined;
        }
        const actionId = this.model.env.config.actionId;
        return Object.values(this.model.offlinePlugin._ormToSync()).find(
            ({ value }) =>
                value.model === this.resModel &&
                value.extras?.actionId === actionId &&
                value.method === "web_save" &&
                value.extras.viewType === "form" &&
                value.args?.[0]?.[0] === this.resId &&
                !value.extras.crmFollowUp
        )?.key;
    }

    /**
     * Orders the lead's offline save about to be queued (`_offlineSave`), from the
     * record's state before the framework commits it, when it does not leave the
     * record's own queued save as it is (`_crmKeepsOwnQueuedSave`: then there is no
     * pending own queued save holding x2many commands, and none of its edits is an
     * x2many field while there is one):
     * - its edits: the fields it writes (`_getChanges`, x2many fields included),
     *   except values restored from the record's queued save and unmodified since;
     * - the later calls: the lead's other queued calls replaying with or after the
     *   record's queued save, all of them when it has none. One writing any field of
     *   the lead (`crmWrittenLeadFields`) overrides every edit: the fields a call
     *   names are not all the fields its replay changes, as the server recomputes
     *   fields it does not name (a team change recomputes the stage).
     * No later call: the framework's save applies (`{}`), merging the save into the
     * record's queued save; when that save holds x2many commands, it keeps them, with
     * their record creations rewritten as the form leaves them, followed by this
     * save's own commands (`queuedX2Many`, `_crmMergedQueuedX2Many`). Otherwise, when
     * the record's queued save holds no other field than the edits and no x2many
     * command (or there is none), that save gets a time stamp after every queued call
     * of the lead (`timeStamp`): moving it changes no older value or command. Else it
     * keeps its time, so the values and commands it already held stay before the
     * later calls, and the edits are queued again in a follow-up write after them
     * (`followUp`, `_crmOwnSaveFollowUp`: their server values, this save's own x2many
     * commands, and the display values of the change and of the values it replaces,
     * as the framework queues them; `null` when nothing is left to write). That save
     * then gets back the x2many commands it held, with their record creations
     * rewritten as the form leaves them, and the display values and replaced values
     * matching them (`queuedX2Many`, `_crmKeptQueuedX2Many`), so that every command is
     * sent once, at its own place. The records of the form those x2many commands
     * create are returned too: those of the record's queued save (`ownChildren`), for
     * the registry once it is rewritten, and those other queued saves of the lead
     * create (`otherChildren`), for these saves to be rewritten
     * (`_crmRewriteQueuedChildren`). When the record's queued save holds no x2many
     * command, or there is none (such as once it was replayed), the framework queues
     * the lists' commands: those naming what a queued save of the lead does, sent or
     * delivered ones included, are then left to it (`queuedX2Many`, `otherChildren`:
     * `_crmLeftOutX2Many`), so that no record is created twice.
     *
     * @returns {{timeStamp?: number, followUp?: {values: Object, changes: Object, originalValues: Object}|null, queuedX2Many?: Object, ownChildren?: CrmQueuedChild[], otherChildren?: CrmQueuedChild[]}}
     */
    _crmPlanOfflineSave() {
        if (this.resModel !== "crm.lead" || !this.resId) {
            return {};
        }
        const written = this._getChanges();
        delete written.id;
        const restored = this.crmRestoredUnmodifiedFields();
        const edits = Object.keys(written).filter((fieldName) => !restored.includes(fieldName));
        const ownEntry = this._crmIsOwnSaveQueued()
            ? this.model.offlinePlugin._ormToSync()[this._offlineId]
            : null;
        const queuedValues = ownEntry?.value.args?.[1];
        const queuedX2ManyFields = isFieldMapping(queuedValues)
            ? Object.keys(queuedValues).filter((fieldName) =>
                  X2MANY_TYPES.includes(this.fields[fieldName]?.type)
              )
            : [];
        // The framework queues the lists' commands as they are when the record's queued
        // save holds no x2many command: those naming what a queued save of the lead does
        // are left to it first.
        const leftOut = queuedX2ManyFields.length ? {} : this._crmLeftOutX2Many(written);
        if (!edits.length && !queuedX2ManyFields.length) {
            return leftOut;
        }
        const ownTimeStamp = ownEntry?.value.extras?.timeStamp || 0;
        const others = this._crmLeadQueuedCalls().filter(({ key }) => key !== this._offlineId);
        const overridden =
            edits.length > 0 &&
            others.some(
                ({ value }) =>
                    (!ownEntry || (value.extras?.timeStamp || 0) >= ownTimeStamp) &&
                    crmWrittenLeadFields(value).length > 0
            );
        if (!overridden) {
            return queuedX2ManyFields.length ? this._crmMergedQueuedX2Many(ownEntry) : leftOut;
        }
        const holdsOtherFields =
            Boolean(ownEntry) &&
            (queuedX2ManyFields.length > 0 ||
                Object.keys(this._offlineChanges || {}).some(
                    (fieldName) => fieldName !== "id" && !edits.includes(fieldName)
                ));
        if (!holdsOtherFields) {
            let timeStamp = Date.now();
            for (const { value } of others) {
                timeStamp = Math.max(timeStamp, (value.extras?.timeStamp || 0) + 1);
            }
            return { timeStamp, ...leftOut };
        }
        const { followUp, children } = this._crmOwnSaveFollowUp();
        return { followUp, ...this._crmKeptQueuedX2Many(ownEntry, queuedX2ManyFields, children) };
    }

    /**
     * The x2many commands of this save, which the framework queues as the lists hold
     * them when the record's queued save holds no x2many command or there is none
     * (`_crmPlanOfflineSave`), once those naming what a queued save of the lead does
     * are left to that save (`_crmSplitCommands`), for `_crmKeepQueuedCommands`: each
     * x2many field with this save's own commands, the inverses of undone restored
     * commands first, and display values matching them (`_crmQueuedDisplayValue`), a
     * field left without commands being dropped from the queued save. The records of
     * the form a queued save creates are returned as well (`otherChildren`), for that
     * save to be rewritten as the form leaves them (`_crmRewriteQueuedChildren`). So a
     * record a delivered save created (the record's own queued save, replayed before
     * this save's request was lost) is not created again. `{}` when the save names
     * nothing of a queued save: the framework's commands are queued as they are.
     *
     * @param {Object} written the save's server values (`_getChanges`)
     * @returns {{queuedX2Many?: Object, otherChildren?: CrmQueuedChild[]}}
     */
    _crmLeftOutX2Many(written) {
        const isX2Many = (fieldName) => X2MANY_TYPES.includes(this.fields[fieldName]?.type);
        const fieldNames = new Set([
            ...Object.keys(written).filter(isX2Many),
            ...this._crmTrackedX2ManyFields(),
        ]);
        const queuedX2Many = {};
        const otherChildren = [];
        let named = false;
        for (const fieldName of fieldNames) {
            const split = this._crmSplitCommands(fieldName, written[fieldName] || []);
            named ||= split.named;
            otherChildren.push(...split.children);
            if (split.commands.length) {
                queuedX2Many[fieldName] = {
                    commands: split.commands,
                    changes: this._crmQueuedDisplayValue(fieldName, split.commands, undefined),
                };
            }
        }
        return named ? { queuedX2Many, otherChildren } : {};
    }

    /**
     * The x2many commands the record's queued save `ownEntry` keeps when the
     * framework merges this save into it (no later call of the lead,
     * `_crmPlanOfflineSave`), for `_crmKeepQueuedCommands`: for each x2many field that
     * save or this save writes, the commands that save held, with their record
     * creations rewritten as the form leaves them (`crmRewrittenCreates`), followed by
     * this save's own commands (`_crmOwnSaveFollowUp`, merged at that save's time, as
     * every value of this save is), and, for a field that save held, the values it
     * replaces as that save recorded them.
     *
     * @param {{key: string, value: Object}} ownEntry
     * @returns {{queuedX2Many: Object, ownChildren: CrmQueuedChild[], otherChildren: CrmQueuedChild[]}}
     */
    _crmMergedQueuedX2Many(ownEntry) {
        const { followUp, children } = this._crmOwnSaveFollowUp();
        const queuedValues = ownEntry.value.args[1];
        const originalValues = ownEntry.value.extras?.originalValues || {};
        const ownChildren = children.filter((child) => child.key === ownEntry.key);
        const ownCommands = followUp?.values || {};
        const queuedX2Many = {};
        const fieldNames = new Set([...Object.keys(queuedValues), ...Object.keys(ownCommands)]);
        for (const fieldName of fieldNames) {
            if (!X2MANY_TYPES.includes(this.fields[fieldName]?.type)) {
                continue;
            }
            const queued = Array.isArray(queuedValues[fieldName]) ? queuedValues[fieldName] : [];
            const ofField = ownChildren.filter((child) => child.fieldName === fieldName);
            const kept = crmRewrittenCreates(queued, ofField) || queued;
            queuedX2Many[fieldName] = { commands: [...kept, ...(ownCommands[fieldName] || [])] };
            if (fieldName in queuedValues && fieldName in originalValues) {
                queuedX2Many[fieldName].originalValue = originalValues[fieldName];
            }
        }
        return {
            queuedX2Many,
            ownChildren,
            otherChildren: children.filter((child) => child.key !== ownEntry.key),
        };
    }

    /**
     * The x2many commands the record's queued save `ownEntry` keeps when this save's
     * edits are queued in a follow-up write after the later calls of the lead
     * (`_crmPlanOfflineSave`), for `_crmKeepQueuedCommands`: for each of its x2many
     * fields `fieldNames`, the commands it held, with their record creations
     * rewritten as the form leaves them (`crmRewrittenCreates`), the display values
     * matching them (those it recorded when they are unchanged and match them,
     * `_crmQueuedDisplayValue` otherwise), and the values they replace as it recorded
     * them.
     *
     * @param {{key: string, value: Object}} ownEntry
     * @param {string[]} fieldNames
     * @param {CrmQueuedChild[]} children `_crmOwnSaveFollowUp`
     * @returns {{queuedX2Many: Object, ownChildren: CrmQueuedChild[], otherChildren: CrmQueuedChild[]}}
     */
    _crmKeptQueuedX2Many(ownEntry, fieldNames, children) {
        const extras = ownEntry.value.extras || {};
        const ownChildren = children.filter((child) => child.key === ownEntry.key);
        const queuedX2Many = {};
        for (const fieldName of fieldNames) {
            const queued = ownEntry.value.args[1][fieldName];
            const rewritten = crmRewrittenCreates(
                Array.isArray(queued) ? queued : [],
                ownChildren.filter((child) => child.fieldName === fieldName)
            );
            const commands = rewritten || queued;
            const previous = extras.changes?.[fieldName];
            const unchanged =
                !rewritten &&
                isFieldMapping(previous) &&
                crmJson(previous.commands) === crmJson(queued);
            const changes = unchanged
                ? previous
                : this._crmQueuedDisplayValue(fieldName, commands, previous);
            queuedX2Many[fieldName] = { commands, changes };
            if (extras.originalValues && fieldName in extras.originalValues) {
                queuedX2Many[fieldName].originalValue = extras.originalValues[fieldName];
            }
        }
        return {
            queuedX2Many,
            ownChildren,
            otherChildren: children.filter((child) => child.key !== ownEntry.key),
        };
    }

    /**
     * Queues the follow-up write `_crmPlanOfflineSave` returned, once the framework
     * queued the record's save: a `web_save` of those fields only, with the extras
     * the framework gives a save of the record, replayed after every queued call of
     * the lead (that save included). Its `crmFollowUp` extra keeps the form from
     * restoring it as the record's own save (`setOfflineChanges`).
     *
     * @param {{values: Object, changes: Object, originalValues: Object}} followUp
     * @returns {string} its queue key
     */
    _crmQueueFollowUpWrite({ values, changes, originalValues }) {
        const extras = getScheduleORMExtras(this.model, [this]);
        for (const { value } of this._crmLeadQueuedCalls()) {
            extras.timeStamp = Math.max(extras.timeStamp, (value.extras?.timeStamp || 0) + 1);
        }
        return this.model.offlinePlugin.scheduleORM(
            this.resModel,
            "web_save",
            [[this.resId], values],
            { context: this.context, specification: {} },
            { extras: { ...extras, changes, originalValues, crmFollowUp: true } }
        );
    }
}

/**
 * `crm.lead` calls whose replay writes the leads of `args[0]`. A replayed `unlink`
 * leaves no lead to read, and a create (no id) was never read.
 */
const CRM_LEAD_WRITE_METHODS = Object.freeze([
    "web_save",
    "action_set_won",
    "action_archive",
    "action_unarchive",
]);

/** `CrmLeadReadRefresher` of each offline plugin (`getCrmLeadReadRefresher`). */
const crmLeadReadRefreshers = new WeakMap();

/**
 * Keeps the cached form reads of the leads whose queued writes were replayed in
 * line with the server.
 *
 * A lead form's root load is a `web_read` cached under its full request, which no
 * other request writes: after the replay of an offline edit, archive or "Won", the
 * lead reopened offline would show its values from before it, and an offline save
 * made there would send them again (the email and phone kept in sync with the
 * partner). So:
 * - each cached root read of a lead by a CRM lead form is recorded with the keyword
 *   arguments the framework passed (`startRead`, `recordRead`), online or offline;
 * - a lead write leaving the queue while a sync runs makes the lead's recorded reads
 *   stale (a removal outside a sync is a discard: the cache holds the server values);
 * - once a sync ends online, each stale read is requested again, so the RAM and disk
 *   cache entries of its request hold the server values. A sync ending offline (the
 *   connection lost during the replay) leaves them to the next one ending online.
 *
 * A read stops being stale once a request of it, issued after the replay, returned
 * from the server. The read a live CRM lead form displays is left to that form: its
 * reconciliation after the replay reloads the lead through the same request. It is
 * requested once the form displays another read or is destroyed, when it is still
 * stale then (the form did not reload it, e.g. a call of the lead was parked).
 *
 * It keeps request arguments in memory only, persists nothing and serves no read:
 * the framework's RPC cache stores the reads, and is written by its own requests.
 *
 * Not gated on the screen size: it keeps offline data correct after a replay on every
 * form factor, and only the replay of queued lead writes leads to a request, so a
 * session that stays online issues none.
 */
class CrmLeadReadRefresher {
    /**
     * @param {OfflinePlugin} plugin
     */
    constructor(plugin) {
        this.plugin = plugin;
        /** @type {Map<number, Map<string, Object>>} lead id → request signature → kwargs */
        this.reads = new Map();
        /**
         * @type {Map<number, Map<string, number>>} lead id → signature of a stale read →
         * mark of the replay its cache entry predates
         */
        this.stale = new Map();
        this.lastMark = 0;
        /** @type {Set<string>} reads being requested again (`${resId}:${signature}`) */
        this.refreshing = new Set();
        /**
         * @type {Map<Object, {resId: number, signature: string}|null>} live CRM lead form
         * models (raw) → last read each recorded
         */
        this.models = new Map();
        /** @type {Map<string, any[]>|null} queue key → leads of the lead writes last seen */
        this.queuedWrites = null;
        this.wasSyncing = false;
        // Created outside any computation and component, so that it follows the queue
        // as long as the plugin lives, whichever form is open.
        untrack(() => effect(() => this.onQueueChange()));
    }

    /**
     * Effect on the queue and the sync state. Removals seen while a sync runs, or in
     * the batch where it ends (owl batches effects: the last replayed entry and the end
     * of the sync land in the same run), are replays.
     */
    onQueueChange() {
        const syncing = this.plugin.syncingORM();
        const offline = this.plugin.isOffline();
        const queuedWrites = new Map();
        for (const { key, value } of Object.values(this.plugin._ormToSync())) {
            const resIds = value?.args?.[0];
            if (
                value?.model === "crm.lead" &&
                CRM_LEAD_WRITE_METHODS.includes(value.method) &&
                Array.isArray(resIds) &&
                resIds.length
            ) {
                queuedWrites.set(key, resIds);
            }
        }
        const previousWrites = this.queuedWrites;
        const replaying = syncing || this.wasSyncing;
        const finished = this.wasSyncing && !syncing;
        this.queuedWrites = queuedWrites;
        this.wasSyncing = syncing;
        untrack(() => {
            if (previousWrites && replaying) {
                for (const [key, resIds] of previousWrites) {
                    if (!queuedWrites.has(key)) {
                        resIds.forEach((resId) => this.markStale(resId));
                    }
                }
            }
            if (finished && !offline) {
                for (const [resId, marks] of this.stale) {
                    for (const signature of marks.keys()) {
                        this.refresh(resId, signature);
                    }
                }
            }
        });
    }

    /**
     * Makes the recorded reads of the lead `resId` stale.
     *
     * @param {number} resId
     */
    markStale(resId) {
        const signatures = this.reads.get(resId);
        if (!signatures) {
            return;
        }
        let marks = this.stale.get(resId);
        if (!marks) {
            marks = new Map();
            this.stale.set(resId, marks);
        }
        const mark = ++this.lastMark;
        for (const signature of signatures.keys()) {
            marks.set(signature, mark);
        }
    }

    /**
     * Ends the staleness of a read whose request issued after the replay `mark`
     * returned from the server (or failed for good). A later replay keeps it stale.
     *
     * @param {number} resId
     * @param {string} signature
     * @param {number} [mark]
     */
    clearStale(resId, signature, mark) {
        const marks = this.stale.get(resId);
        if (mark && marks?.get(signature) === mark) {
            marks.delete(signature);
            if (!marks.size) {
                this.stale.delete(resId);
            }
        }
    }

    /**
     * A cached root read of the lead `resId` the framework is about to request with
     * `kwargs`: its signature (the cache key of its request derives from it), a copy
     * of `kwargs`, and the replay mark it is then stale against (none when it is not).
     *
     * @param {number} resId
     * @param {Object} kwargs
     * @returns {{resId: number, signature: string, kwargs: Object, mark?: number}}
     */
    startRead(resId, kwargs) {
        const signature = JSON.stringify(kwargs);
        const mark = this.stale.get(resId)?.get(signature);
        return { resId, signature, kwargs: JSON.parse(signature), mark };
    }

    /**
     * Records the read `model` loaded (`startRead`). A live model now displays it: the
     * read it displayed before is requested again when it is stale.
     *
     * @param {Object} model raw CRM lead form model
     * @param {{resId: number, signature: string, kwargs: Object}} read
     */
    recordRead(model, { resId, signature, kwargs }) {
        let signatures = this.reads.get(resId);
        if (!signatures) {
            signatures = new Map();
            this.reads.set(resId, signatures);
        }
        signatures.set(signature, kwargs);
        if (!this.models.has(model)) {
            return;
        }
        const previous = this.models.get(model);
        this.models.set(model, { resId, signature });
        if (previous && (previous.resId !== resId || previous.signature !== signature)) {
            this.refresh(previous.resId, previous.signature, model);
        }
    }

    /**
     * Registers a live CRM lead form model.
     *
     * @param {Object} model raw model
     */
    attach(model) {
        this.models.set(model, null);
    }

    /**
     * Unregisters a destroyed model: the read it displayed is requested again when it
     * is stale.
     *
     * @param {Object} model raw model
     */
    detach(model) {
        const read = this.models.get(model);
        this.models.delete(model);
        if (read) {
            this.refresh(read.resId, read.signature);
        }
    }

    /**
     * Whether a live model other than `ignoredModel` displays the read: its root is
     * the lead, loaded through that request.
     *
     * @param {number} resId
     * @param {string} signature
     * @param {Object|null} ignoredModel
     */
    isDisplayed(resId, signature, ignoredModel) {
        for (const [model, read] of this.models) {
            if (
                model !== ignoredModel &&
                read?.resId === resId &&
                read.signature === signature &&
                model.root?.resId === resId
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Requests a stale read again, online, unless it is being requested or displayed
     * by a live model other than `ignoredModel`.
     *
     * The request goes through the queue's own ORM, which lives as long as the plugin
     * (a form's ORM rejects its calls once the form is destroyed), silent as the
     * replay. `noCache` sends it at once without serving the cached value first, so
     * it resolves with the server's result, which the RAM and disk cache entries of
     * the request then hold. A lost connection leaves the read stale for the next sync
     * ending online; any other error (such as a lead deleted or no longer readable)
     * ends it. Failures show nothing.
     *
     * A lead write replayed while the request runs makes the read stale again, with a
     * newer mark: the request may have read the server before that write, and a sync
     * ending meanwhile does not request the read again (it is being requested). So,
     * once the request settled (answered, lost or refused), a read still stale with a
     * newer mark is requested again at once when no sync runs; a sync still running
     * requests it when it ends online, after its last replayed write. A read still
     * stale with the request's own mark (a lost connection) is not requested again
     * before the next sync ending online, as above.
     *
     * @param {number} resId
     * @param {string} signature
     * @param {Object|null} [ignoredModel]
     */
    refresh(resId, signature, ignoredModel = null) {
        const mark = this.stale.get(resId)?.get(signature);
        const key = `${resId}:${signature}`;
        if (
            !mark ||
            this.plugin.isOffline() ||
            this.refreshing.has(key) ||
            this.isDisplayed(resId, signature, ignoredModel)
        ) {
            return;
        }
        this.refreshing.add(key);
        this.plugin.orm.silent
            .cache({ type: "disk", update: "always", noCache: true })
            .webRead("crm.lead", [resId], this.reads.get(resId).get(signature))
            .then(
                () => this.clearStale(resId, signature, mark),
                (error) => {
                    if (!(error instanceof ConnectionLostError)) {
                        this.clearStale(resId, signature, mark);
                    }
                }
            )
            .finally(() => {
                this.refreshing.delete(key);
                if (this.stale.get(resId)?.get(signature) > mark && !this.plugin.syncingORM()) {
                    this.refresh(resId, signature);
                }
            });
    }
}

/**
 * The `CrmLeadReadRefresher` of `plugin`, created by the first CRM lead form and kept
 * as long as the plugin.
 *
 * @param {OfflinePlugin} plugin
 * @returns {CrmLeadReadRefresher}
 */
function getCrmLeadReadRefresher(plugin) {
    let refresher = crmLeadReadRefreshers.get(plugin);
    if (!refresher) {
        refresher = new CrmLeadReadRefresher(plugin);
        crmLeadReadRefreshers.set(plugin, refresher);
    }
    return refresher;
}

class CrmFormModel extends formView.Model {
    static Record = CrmFormRecord;
    static services = [...formView.Model.services, "effect"];

    setup(params, services) {
        super.setup(...arguments);
        this.effect = services.effect;
        // The parent's `offlinePlugin` field is set after `setup`: same plugin.
        const refresher = getCrmLeadReadRefresher(usePlugin(OfflinePlugin));
        this.crmLeadReadRefresher = refresher;
        refresher.attach(this);
        /** Set once the form owning the model is destroyed (`_crmAwaitLeadReplay`). */
        this.crmDestroyed = signal(false);
        onWillDestroy(() => {
            refresher.detach(this);
            this.crmDestroyed.set(true);
        });
    }

    /**
     * @override
     * A cached root read of a lead (online or offline) is recorded with the keyword
     * arguments the framework passes to `webRead`, once it resolved, so that the
     * replay of the lead's queued writes refreshes its cache entry
     * (`CrmLeadReadRefresher`). The request is captured from the ORM the parent uses
     * for it, which it calls before its first `await`; a server result of a request
     * issued after the replay ends the read's staleness.
     *
     * @param {Object} config
     * @param {Object} [evalContext]
     * @param {Object} [cache]
     */
    async _loadRecords(config, evalContext, cache) {
        if (
            !cache ||
            typeof cache !== "object" ||
            config.resModel !== "crm.lead" ||
            !config.isMonoRecord ||
            !config.resId
        ) {
            return super._loadRecords(...arguments);
        }
        const refresher = this.crmLeadReadRefresher;
        const model = toRaw(this);
        const orm = model.orm;
        let read = null;
        const callback = cache.callback;
        const readCache = {
            ...cache,
            callback: (...args) => {
                if (read) {
                    refresher.clearStale(read.resId, read.signature, read.mark);
                }
                return callback?.(...args);
            },
        };
        model.orm = Object.assign(Object.create(orm), {
            cache(settings) {
                const cachedOrm = orm.cache(settings);
                return Object.assign(Object.create(cachedOrm), {
                    webRead(resModel, resIds, kwargs) {
                        read = refresher.startRead(resIds[0], kwargs);
                        return cachedOrm.webRead(...arguments);
                    },
                });
            },
        });
        let promise;
        try {
            promise = super._loadRecords(config, evalContext, readCache);
        } finally {
            model.orm = orm;
        }
        const records = await promise;
        if (read) {
            refresher.recordRead(model, read);
        }
        return records;
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
 * Controller of the standard lead form (template `crm.CrmFormView`, which adds the
 * phone "Activities" button to the control panel).
 *
 * Offline it is the execution boundary of the lead form's buttons: "Won" is queued
 * as `action_set_won` and every other `object`/`action` button is inert. The local
 * state of the displayed lead's queued calls is shown while they wait, and the lead
 * is reconciled when they leave the queue; parked entries stay queued and keep
 * their local state.
 *
 * On a phone the root load also requests the lead's activity rows (mobile variant);
 * otherwise it requests what the arch declares (desktop variant). Offline, when the
 * mobile variant was never cached, the load falls back to the desktop variant.
 */
export class CrmFormController extends formView.Controller {
    static template = "crm.CrmFormView";

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.crmActivitiesSheet = usePopover(CrmMobileLeadActivities, {
            useBottomSheet: true,
            // Without an env, the overlay's env provider is attached to the web
            // client's root and never released: every closed sheet (components, DOM
            // and listeners) would stay in memory. This one is released on close.
            env: this.env,
            onClose: () => this.crmOnActivitiesClosed(),
        });
        /** @type {HTMLElement|null} control that opened the activity sheet */
        this.crmActivitiesOpener = null;

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

        // On a phone, the displayed lead's calls the replay sends (`crmOwnKeys`) stay
        // shown as pending (the rows of its activity sheet) until the form shows the
        // lead reloaded from the server after their replay (`crmReleaseReplayHold`).
        this.crmReplayHold = this.crmOffline.holdReplayed(
            (entry) => this.crmOffline.isSmall && this.crmCurrentOwnKeys().has(entry.key)
        );

        // Replayed keys leave the set, parked ones stay. After a replay that removed
        // some of the lead's calls and left none of them queued, the server values
        // replace the local presentation (won, archived): edits made since the form
        // restored the lead's queued save are saved, while the replayed values it
        // restored are not sent again. A lead created offline (no id), whose create
        // was replayed, is left instead (`crmLeaveCreatedLead`), unless a save of the
        // user during the replay gave it the created lead's id. A parked call keeps
        // the local presentation. Replayed calls the form still holds, with none of
        // its calls left, mean that the reconciliation after their replay was lost
        // (with the connection, or refused by the server): any later sync end, even
        // an empty one, runs it again.
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
            if ((replayed || this.crmReplayHold.holding()) && !ownKeys.size) {
                const root = this.model.root;
                if (root && !root.resId) {
                    return this.crmOwn(this.crmLeaveCreatedLead(root));
                }
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

        // Back online, the desktop-variant fallback ends. A phone reloads the mobile
        // variant, keeping the form's changes; a wide screen already shows the
        // desktop variant and requests nothing.
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const isSmall = this.crmOffline.isSmall;
            if (!isOffline && this.crmDesktopFallback) {
                this.crmDesktopFallback = false;
                if (isSmall) {
                    untrack(() => this.crmOwn(this.crmReconcile()));
                }
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
     * Owns a promise this controller starts without a caller awaiting it. A lost
     * connection ends there (the cache or the next reconnection takes over); any
     * other error is reported once to the framework error handling, even when merged
     * reconciliations share it (`crmReportError`).
     *
     * @param {any} promise
     * @returns {Promise<void>} resolved once `promise` settled
     */
    crmOwn(promise) {
        return Promise.resolve(promise).then(() => {}, crmReportError);
    }

    /**
     * Refreshes the displayed lead through `CrmFormRecord.crmRefresh`, which defines
     * the replay and discard options, then shows its name and the state of its
     * still-queued calls. Asked for before the model is ready, it runs after the first
     * root load, which may have read the lead before the replay, discard or
     * reconnection; a destroyed controller is skipped.
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
     * Leaves the form of a lead created offline once the replay created it. The
     * replay returns no id, so the form cannot show the created lead: it is left for
     * the containing action, which loads it from the server (a dialog is closed),
     * the exit the framework takes when a form has no record left. Unsaved edits are
     * discarded first: the user did not save them, and leaving would. Nothing happens
     * once the controller is destroyed or the model shows another record, nor once
     * the record has an id: the user saved it during the replay, and that save
     * (`Record._crmSaveSendingCreateKey`, flagged as a later save of the lead) wrote
     * on the created lead, which the form now shows.
     *
     * @param {Object} root the new record whose create was replayed
     * @returns {Promise<void>}
     */
    async crmLeaveCreatedLead(root) {
        const isStale = () =>
            status(this) === "destroyed" ||
            toRaw(this.model.root) !== toRaw(root) ||
            Boolean(root.resId);
        if ((await root.isDirty()) && !isStale()) {
            await root.discard();
        }
        if (isStale()) {
            return;
        }
        if (this.env.inDialog) {
            await this.env.dialogData.close();
        } else {
            this.env.config.historyBack();
        }
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
     * A lead has one queued won: while its won call is pending, a repeated click (such
     * as the second click of a double-click, landing before the render that hides the
     * button) queues nothing more. A parked won is not pending, so a new click queues.
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
        const pendingWon = this.crmFindPending(root.resId, ["action_set_won"]);
        if (pendingWon) {
            this.crmCurrentOwnKeys().add(pendingWon.key);
            root.applyOfflineWon();
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
     *
     * Either way, the loaded values are in the record before this hook runs, so the
     * replayed calls the form holds are released first (`crmReleaseReplayHold`),
     * before any render shows the loaded lead.
     */
    async onRootLoaded() {
        const root = this.model.root;
        this.crmReleaseReplayHold(root);
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
     * @override
     * A root first shown from the cache is updated with the server's read when that
     * read differs: the read replaces the loaded values while keeping the changes,
     * which drops the local state `onRootLoaded` applied for the lead's queued calls
     * (won, archived, the values of its other queued saves). That state is applied
     * again (`crmApplyQueuedState`), so it survives reopening the lead while the
     * calls wait, parked ones included. Nothing is applied once the controller is
     * destroyed.
     */
    onRootUpdated() {
        super.onRootUpdated(...arguments);
        if (status(this) !== "destroyed") {
            this.crmApplyQueuedState();
        }
    }

    /**
     * Releases the replayed calls the form holds once it shows what the server now
     * has: those replayed before the start of the root load just ended, when that
     * load read the server (`markRootLoad`); all of them when the form shows another
     * lead than the one they were held for, as they no longer concern it.
     *
     * @param {Object|null} root the root the load has just set
     */
    crmReleaseReplayHold(root) {
        const lead = root ? root.resId || toRaw(root) : null;
        if (lead !== this.crmOwnLead) {
            this.crmReplayHold.releaseAll();
        } else {
            this.crmReplayHold.releaseLoaded(root?.config);
        }
    }

    /**
     * Applies the local state of the displayed lead's queued calls:
     * - the queued saves of the lead made through its other records (its pipeline
     *   card, another form), pending or parked, show their values in replay order
     *   (`CrmFormRecord.crmShowQueuedWrites`), so a reopened form shows a later
     *   stage move instead of the stale stage of its own queued save;
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
        // Opened online from the offline systray, the form takes over the queued save
        // it restored (the systray then removes it from the queue): its values are the
        // form's unsaved edits, which the other queued saves do not replace.
        const handingOver =
            Boolean(this.crmHandOverKey) &&
            root.offlineId === this.crmHandOverKey &&
            !this.crmOffline.isOffline();
        root.crmShowQueuedWrites(
            entries.filter(({ value }) => value.method === "web_save").sort(byTimeStamp),
            { keepRestored: handingOver }
        );
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
     * Configures incoming root loads before their cache key is computed. Phone loads
     * add the activity rows; desktop loads use the arch specification. A post-save
     * reload keeps its existing specification, so its response matches the fields it
     * requested. A replaced `activeFields` is a fresh object; `config.fields` is not
     * changed.
     *
     * @param {Object} config root configuration about to be loaded
     */
    onWillLoadRoot(config) {
        super.onWillLoadRoot(...arguments);
        this.crmOffline.markRootLoad(this.model, config);
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
        if (!mobile && !("activity_ids" in currentActiveFields)) {
            return;
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
            // Each lead's page size is read from the session, not this controller:
            // its form opened again in this session requests the page "Show more"
            // reached, which its cache holds. A new record has none.
            activeFields.activity_ids = {
                ...activeFields.activity_ids,
                related: crmActivityRelated(),
                limit: config.resId
                    ? this.crmOffline.getActivityLimit(this.crmActivityScope(config.resId))
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
     * `CrmFormRecord._getOnchangeValues`). On a wide screen, it removes the mobile-only
     * `activity_ids` a phone root load added: `config.activeFields` is replaced by a
     * fresh object without it and the root forgets its loaded value, so the request
     * and the parsing of its result use the desktop fields. Unsaved changes are kept.
     *
     * Nothing changes on a small screen, for another configuration than the root's,
     * for an arch declaring `activity_ids`, or when the root holds a change of
     * `activity_ids`.
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
        if (!("activity_ids" in currentActiveFields)) {
            return;
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
     * Scope of the session's activity page size for the phone root load of the
     * lead `resId`: the lead and the form's action, whose context is part of that
     * load's request and cache key.
     *
     * @param {number} resId
     * @returns {string}
     */
    crmActivityScope(resId) {
        return `lead:${this.env.config?.actionId ?? ""}:${resId}`;
    }

    /**
     * `crmLoadMoreActivities` model hook, the activity sheet's "Show more": online
     * on a phone, with the phone variant applied to the displayed lead `resId`, it
     * raises the lead's activity page by `CRM_MOBILE_ACTIVITY_LIMIT` and refreshes
     * the lead in place (`CrmFormRecord.crmRefresh`), keeping unsaved changes, so the
     * larger page comes from the form's own (cached) root request.
     *
     * The lead's session page size is raised before the refresh, which reads it, and
     * restored when the refresh fails (a lost connection resolves, any other error
     * propagates) or the displayed lead did not load that page.
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
        const previousLimit = this.crmOffline.getActivityLimit(scope);
        const limit = previousLimit + CRM_MOBILE_ACTIVITY_LIMIT;
        this.crmOffline.setActivityLimit(scope, limit);
        try {
            await root.crmRefresh();
        } catch (error) {
            this.crmOffline.setActivityLimit(scope, previousLimit);
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
            this.crmOffline.setActivityLimit(scope, previousLimit);
        }
    }

    /**
     * Accessible name of the phone "Activities" button: its visible label followed
     * by the name of the displayed lead, as the pipeline cards name theirs; the
     * label alone for a lead without a name.
     *
     * @returns {string}
     */
    get crmActivitiesAriaLabel() {
        const name = this.model.root?.data.name;
        const lead = typeof name === "string" ? name.trim() : "";
        return lead ? _t("Activities: %(lead)s", { lead }) : _t("Activities");
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
        // Once opened: opening closes a sheet still open, which forgets its opener.
        this.crmActivitiesOpener = ev.currentTarget;
    }

    /**
     * Every close of the activity sheet (Escape, backdrop, swipe, or the form gone
     * to another record) gives the focus back to its opener, else to the form's
     * current "Activities" button.
     */
    crmOnActivitiesClosed() {
        const opener = this.crmActivitiesOpener;
        this.crmActivitiesOpener = null;
        crmReturnFocusFromSheet([
            opener,
            this.rootRef()?.querySelector(".o_crm_mobile_activities_button"),
        ]);
    }
}

/**
 * Tells whether a compiled header element is a view button whose arch tags it
 * `data-available-offline` ("Won" in the lead form): the compiler serializes the
 * button's non-click attributes as the JSON of its `attrs` prop
 * (`ViewCompiler.compileButton`). The attribute's presence, whatever its value
 * (even empty), marks the button available offline, as it does for the framework's
 * offline selector (`OfflinePlugin.SELECTORS_TO_DISABLE`).
 *
 * @param {Element} compiled
 * @returns {boolean}
 */
function isAvailableOfflineViewButton(compiled) {
    if (compiled?.tagName !== "ViewButton") {
        return false;
    }
    try {
        const attrs = JSON.parse(compiled.getAttribute("attrs") || "{}");
        return Object.hasOwn(attrs, "data-available-offline");
    } catch {
        return false;
    }
}

/**
 * Form compiler of the lead form (`crm_form`). It compiles as the framework does,
 * and also gives each header button slot of `StatusBarButtons` whose button the arch
 * tags `data-available-offline` the slot param `crmAvailableOffline`.
 *
 * On a small screen `StatusBarButtons` shows only its first visible button and puts
 * the others under a "More" dropdown, whose toggle the framework disables offline.
 * An addon adding a header button before "Won" (`sale_crm`'s "New Quotation") so
 * pushes "Won" under that toggle, and the offline mark-won (queued by
 * `CrmFormController`) can no longer be reached on a phone. The slot param lets the
 * `StatusBarButtons` patch below keep that toggle available offline while it holds
 * such a button. It renders nothing itself: the wide layout and every other form are
 * unchanged.
 */
export class CrmFormCompiler extends FormCompiler {
    compileHeader(el, params) {
        const statusBar = super.compileHeader(...arguments);
        const statusBarButtons = [...statusBar.children].find(
            (child) => child.tagName === "StatusBarButtons"
        );
        for (const slot of statusBarButtons?.children || []) {
            if (isAvailableOfflineViewButton(slot.firstElementChild)) {
                slot.setAttribute("crmAvailableOffline", "true");
            }
        }
        return statusBar;
    }
}

patch(StatusBarButtons.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /**
     * Whether the small-screen "More" toggle carries `data-available-offline`
     * (`web.StatusBarButtons` extension): when one of the visible buttons it holds
     * is tagged available offline by the lead form's arch (`CrmFormCompiler`), as
     * "Won" is under `sale_crm`'s "New Quotation". Offline the framework then leaves
     * the toggle enabled: the dropdown opens on that button, which stays enabled,
     * while every other button in it keeps the framework's disabled offline state.
     * Like the lead card-menu toggle, the toggle is framework-disabled where the
     * framework queue cannot hold the queued call of those buttons
     * (`isCrmOfflineQueueBlocked`), as "Won" then is. Slots without that param, the
     * buttons of every other form, are tested first, so their toggle is unchanged.
     *
     * @returns {boolean}
     */
    get crmMoreAvailableOffline() {
        const slots = this.props.slots || {};
        return (
            this.visibleSlotNames.slice(1).some((name) => slots[name].crmAvailableOffline) &&
            !isCrmOfflineQueueBlocked(this.crmOfflinePlugin)
        );
    },
});

registry.category("views").add("crm_form", {
    ...formView,
    Model: CrmFormModel,
    Controller: CrmFormController,
    Compiler: CrmFormCompiler,
});

/**
 * Stage statusbar of the lead form (`crm_form.rotting_statusbar_duration`, resolved
 * before `rotting_statusbar_duration` for this `js_class` only). Its template adds
 * `data-available-offline` to every statusbar button and dropdown stage item, so a
 * stage can be chosen offline (the change is queued by the record's offline save).
 * The attribute has no effect online. Offline where the framework queue cannot hold
 * that save (`isCrmOfflineQueueBlocked`), the attribute is dropped, the buttons get
 * the framework's disabled offline state, and no stage can be chosen.
 */
export class CrmStatusBarField extends RottingStatusBarDurationField {
    static template = "crm.RottingStatusBarDurationField";

    setup() {
        super.setup();
        this.offlinePlugin = usePlugin(OfflinePlugin);
    }

    /** Whether the statusbar controls carry `data-available-offline`, read on every render. */
    get crmAvailableOffline() {
        return !isCrmOfflineQueueBlocked(this.offlinePlugin);
    }

    /**
     * The framework's offline class of a statusbar button its template disables while
     * the stage save cannot be queued, given only to a button not disabled otherwise,
     * as the framework gives it.
     *
     * @param {boolean} [disabled] whether the button is disabled otherwise
     * @returns {string}
     */
    crmOfflineDisabledClass(disabled) {
        return disabled || this.crmAvailableOffline ? "" : "o_disabled_offline";
    }

    /**
     * Stage items of a menu opened before such a disconnection are spans, which the
     * framework does not disable: they get its disabled style instead.
     */
    getDropdownItemClassNames(item) {
        const classNames = super.getDropdownItemClassNames(item);
        return this.crmAvailableOffline ? classNames : `${classNames} o_disabled_offline`.trim();
    }

    /**
     * Inert where the stage save cannot be queued (a stage item of a menu opened
     * before the disconnection, a command-palette shortcut), so no unsaved stage is
     * left on the lead.
     */
    async selectItem(item) {
        if (!this.crmAvailableOffline) {
            return;
        }
        return super.selectItem(...arguments);
    }
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

/**
 * Whether a queue entry is a CRM one: a call on a `crm.*` model, or a CRM call of
 * another model (the lead activity sheet's `mail.activity` calls).
 *
 * @param {{model: string, method: string}} value
 */
function isCrmQueueEntry(value) {
    return (
        Boolean(value.model?.startsWith("crm.")) ||
        Boolean(CRM_QUEUED_CALL_STATUS[value.model]?.[value.method])
    );
}

/**
 * The Python exception class the framework writes before the server message of a
 * rejected replay (`<module>.<Class> - <message>`, e.g. `odoo.exceptions.MissingError - `).
 */
const PARKED_ERROR_CLASS = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+ - /;

/**
 * Lines of a server message that only carry internal ids. Their labels are
 * translated and their values are not, so they are told by the values:
 * - a recordset, e.g. `(Record: crm.lead(53,), User: 7)` or `Records: crm.lead(53,), User: 7`;
 * - `<label>: <id or [ids]>, <label>: <id>`, e.g. `(Record: 53, User: 7)` or
 *   `Records: [12, 13], User: 7`.
 */
const PARKED_ERROR_ID_LINES = [
    /\b[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+\(\s*\d[\d,\s]*\)/,
    /^\s*\(?[^:：,，()[\]\n]+[:：]\s*(?:\d+|\[[\d,\s]*\])\s*[,，]\s*[^:：,，()[\]\n]+[:：]\s*\d+\s*\)?\s*$/,
];

/**
 * Untranslated id annotations inside the lines of an access error: the user's
 * ` (id=7)` and, in debug mode, a record's ` (crm.lead: 53)` or
 * ` (crm.lead: 53, company=…)` at the end of its line.
 */
const PARKED_ERROR_ID_ANNOTATIONS = [
    / \(id=\d+\)/g,
    / \([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+: \d+(?:, company=.*)?\)$/gm,
];

/**
 * The message of a parked CRM replay error as the user reads it: the server message
 * without the exception class or the internal ids, or a generic message when
 * nothing else remains.
 *
 * @param {string} error `extras.error` of the parked entry
 * @returns {string}
 */
function crmParkedErrorMessage(error) {
    let message = String(error).replace(PARKED_ERROR_CLASS, "");
    for (const annotation of PARKED_ERROR_ID_ANNOTATIONS) {
        message = message.replace(annotation, "");
    }
    message = message
        .split("\n")
        .filter((line) => !PARKED_ERROR_ID_LINES.some((idLine) => idLine.test(line)))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return message || _t("The server could not apply this change.");
}

/**
 * CRM rows of the offline systray: the status of the CRM calls above, and the
 * message of a parked CRM replay (its row tooltip) told by `crmParkedErrorMessage`.
 * Only the displayed text changes: the queue keeps the framework's `extras.error`,
 * which marks the entry parked, and every other entry is left as the framework
 * shows it.
 */
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
                        // Built from the queue's error rather than `item.error`, so the
                        // text stays the same when the framework's sections are reused.
                        if (value?.extras?.error && isCrmQueueEntry(value)) {
                            item.error = crmParkedErrorMessage(value.extras.error);
                        }
                    }
                }
                return sections;
            });
        },
    });
}

/**
 * Lead chatters by their root ref, on which their attachment dropzones (the
 * chatter's own and its composer's) are placed.
 *
 * @type {WeakMap<Function, Chatter>}
 */
const LEAD_CHATTERS_BY_DROPZONE_REF = new WeakMap();

/**
 * Lead chatter read-only offline. Scoped to `crm.lead` threads, checked before the
 * offline signal is read, so other chatters neither subscribe to it nor change.
 * Its Send, Log note, Activities, attachment and follow controls are buttons, which
 * the framework already disables offline; activity scheduling, the followers menu,
 * the attachments and the dropzone are also guarded where they run (below and in
 * the follower and dropzone patches).
 *
 * What a lead chatter skips offline, or loses to a dropped connection, is remembered
 * for the displayed thread and loaded once when the connection returns, so a lead
 * opened or reloaded offline, including one opened as the connection drops (before
 * the framework notices it), gets its messages, followers and access rights back
 * without being reopened, and shows no endless loading spinner.
 */
patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
        /**
         * Upload handlers of lead threads, guarded offline, by mail's handler.
         *
         * @type {WeakMap<Function, Function>}
         */
        this.crmUploadHandlers = new WeakMap();
        if (this.threadModel() === "crm.lead") {
            // The dropzone and the file input upload through this chatter's own
            // uploader, which the attachment list also deletes through; the search
            // input and its filters search through its own message search.
            this.crmGuardOffline(this.attachmentUploader, ["uploadFile", "unlink"]);
            this.crmGuardOffline(this.messageSearch, ["run", "fetch", "fetchMessages"]);
            LEAD_CHATTERS_BY_DROPZONE_REF.set(this.rootRef, this);
        }
        /**
         * Thread requests skipped offline, for one thread only.
         *
         * @type {{ thread: import("models").Thread, requestList: Set<string> } | null}
         */
        this.crmPendingLoad = null;
        useEffect(() => {
            if (this.threadModel() !== "crm.lead") {
                return;
            }
            if (this.crmOfflinePlugin.isOffline()) {
                if (this.state.composerType) {
                    this.state.composerType = false;
                }
                // The followers menu items are not buttons, which the framework would
                // disable: a menu opened online closes, and so does one forced open
                // offline, as this branch follows the menu state.
                if (this.followerListDropdown.isOpen) {
                    untrack(() => this.followerListDropdown.close());
                }
                // So are the pinned messages' jump links, which load the messages
                // around one not shown, and the search input, which searches as it is
                // typed in: their panel closes in the same way.
                const activePanel = this.state.activePanel;
                if (activePanel === this.CHATTER_PANEL.PINNED_MESSAGES) {
                    untrack(() => (this.state.activePanel = this.CHATTER_PANEL.NONE));
                } else if (activePanel === this.CHATTER_PANEL.SEARCH) {
                    untrack(() => this.closeSearch());
                }
                return;
            }
            // The load reads and writes thread state: this effect follows only the
            // thread model and the offline signal.
            untrack(() => this.crmLoadPending());
        });
        // Mail's MAIL:RELOAD-THREAD listeners, this chatter's and its Thread's (which
        // calls `thread.fetchNewMessages()` without going through `load`), are added
        // when they mount. The bus is a plain EventTarget, which calls its listeners
        // in the order they were added (a capture listener gets no precedence), so
        // this one is added at setup: before the Thread child, and this chatter, mount.
        useListener(this.env.bus, "MAIL:RELOAD-THREAD", (ev) => this.crmOnReloadThread(ev));
    },

    /** Scope first (lead thread), then the offline signal. */
    get crmOfflineReadOnly() {
        const threadModel = this.state.thread?.model ?? this.threadModel();
        return threadModel === "crm.lead" && this.crmOfflinePlugin.isOffline();
    },

    /**
     * Offline, makes the given methods of one of this lead chatter's helpers resolve
     * without running, so without a request, even when called directly. Online, and
     * once the chatter shows another model, they run unchanged (same `this`,
     * arguments and result).
     *
     * @param {Object} helper
     * @param {string[]} methodNames
     */
    crmGuardOffline(helper, methodNames) {
        const chatter = this;
        for (const methodName of methodNames) {
            const method = helper[methodName];
            helper[methodName] = function () {
                if (chatter.crmOfflineReadOnly) {
                    return Promise.resolve();
                }
                return method.apply(this, arguments);
            };
        }
    },

    /**
     * Offline, a lead thread whose follower count was never loaded has nothing to
     * wait for: its followers button shows neither the loading spinner nor a count
     * (template extension in `crm_mobile_pipeline.xml`).
     */
    get crmFollowersCountUnknown() {
        const thread = this.state.thread;
        return Boolean(
            thread?.model === "crm.lead" &&
                thread.id &&
                thread.followersCount === undefined &&
                this.crmOfflinePlugin.isOffline()
        );
    },

    /**
     * @override
     * Offline, a lead thread fetches nothing: it shows the messages already in the
     * store, and resolves (no rejection, no error). The skipped requests are loaded
     * once the connection returns.
     *
     * Online, a lead thread load whose connection is lost resolves the same way and
     * keeps its requests for the reconnection. This is a lead opened while the
     * connection is down but before the framework has noticed (it learns it from
     * this load's failure, `RPC:RESPONSE`, and goes offline before the rejection
     * reaches here), or a reconnection load during which the connection drops again.
     * Mail leaves such a thread loading: its follower count and attachments are
     * never fetched, and nothing fetches them later. Any other error is mail's, and
     * other models' loads are untouched.
     */
    async load(thread, requestList) {
        // This Chatter has no `props` object: its `threadModel` prop is read through
        // the `propComputed` accessor `this.threadModel()`.
        const threadModel = thread?.model ?? this.threadModel();
        if (threadModel !== "crm.lead") {
            return super.load(...arguments);
        }
        if (this.crmOfflinePlugin.isOffline()) {
            this.crmRememberLoad(thread, requestList);
            return;
        }
        try {
            return await super.load(...arguments);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            // Mail marks the attachments loading as it requests them and clears the
            // flag only when they arrive, so the lost request would leave the
            // attachment spinner on: nothing is loading until the reconnection load.
            if (thread && requestList?.includes("attachments")) {
                thread.isLoadingAttachments = false;
            }
            this.crmRememberLoad(thread, requestList);
        }
    },

    /**
     * @override
     * Offline, a lead chatter schedules no activity, even when called directly: it
     * opens no activity dialog (whose views are a server request) and saves no new
     * lead to get a thread, and it resolves (no rejection, no error).
     */
    async scheduleActivity() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.scheduleActivity(...arguments);
    },

    /**
     * @override
     * Offline, a lead chatter removes no attachment, even when called directly or
     * from a removal confirmed offline: the attachment stays, and the call resolves.
     */
    async unlinkAttachment(attachment) {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.unlinkAttachment(...arguments);
    },

    /**
     * @override
     * The file input keeps the handler it got when its chooser was opened online:
     * for a lead thread it uploads nothing, and opens no attachment panel, when the
     * files are chosen, or the handler called, offline.
     */
    onUploaded({ thread } = {}) {
        const handleUpload = super.onUploaded(...arguments);
        if (thread?.model !== "crm.lead") {
            return handleUpload;
        }
        if (!this.crmUploadHandlers.has(handleUpload)) {
            this.crmUploadHandlers.set(handleUpload, (data) =>
                this.crmOfflinePlugin.isOffline() ? Promise.resolve() : handleUpload(data)
            );
        }
        return this.crmUploadHandlers.get(handleUpload);
    },

    /**
     * @override
     * Offline, a lead chatter's pinned messages do not open, so they are not
     * fetched, even when called directly; a closing call still closes them.
     */
    onClickPinnedMessages() {
        if (
            this.crmOfflineReadOnly &&
            this.state.activePanel !== this.CHATTER_PANEL.PINNED_MESSAGES
        ) {
            return;
        }
        return super.onClickPinnedMessages(...arguments);
    },

    /**
     * @override
     * Offline, a lead chatter's file chooser does not open (`false` stops the file
     * uploader), and a new lead is not saved to get a thread.
     */
    async onClickAttachFile() {
        if (this.crmOfflineReadOnly) {
            return false;
        }
        return super.onClickAttachFile(...arguments);
    },

    /**
     * @override
     * Offline, a lead chatter opens no composer, even when called directly: it saves
     * no new lead to get a thread and looks up no recipients. A closing call still
     * closes it; on a new lead, where no composer is open, such a call would only
     * save the lead, so it does nothing.
     */
    toggleComposer(mode = false) {
        if (this.crmOfflineReadOnly && (mode || !this.state.thread?.id)) {
            return;
        }
        return super.toggleComposer(...arguments);
    },

    /**
     * Remembers requests skipped offline, or lost to a dropped connection. Only those
     * of the displayed thread are kept, as `load` ignores any other thread; a newly
     * displayed thread (pager) replaces the requests of the previous one.
     *
     * @param {import("models").Thread} thread
     * @param {string[]} [requestList]
     */
    crmRememberLoad(thread, requestList) {
        if (!thread?.id || !this.state.thread?.eq(thread)) {
            return;
        }
        if (!this.crmPendingLoad?.thread.eq(thread)) {
            this.crmPendingLoad = { thread, requestList: new Set() };
        }
        for (const request of requestList ?? []) {
            this.crmPendingLoad.requestList.add(request);
        }
    },

    /**
     * Back online: loads, once, the requests skipped or lost offline when their
     * thread is still displayed. A connection lost again during that load keeps them
     * for the next reconnection (`load`); the framework already treats that loss as
     * going offline.
     */
    crmLoadPending() {
        const pending = this.crmPendingLoad;
        this.crmPendingLoad = null;
        if (!pending || !this.state.thread?.eq(pending.thread)) {
            return;
        }
        this.load(pending.thread, [...pending.requestList]);
    },

    /**
     * Offline, the same-record reload of the displayed lead thread fetches nothing:
     * its thread data and message refetch wait for the connection, and the
     * listeners added after this one (mail's) do not run. The thread record is
     * shared by the store, so one chatter loading it on reconnection updates every
     * view of it.
     *
     * @param {CustomEvent<{ model: string, id: number|false }>} ev
     */
    crmOnReloadThread(ev) {
        const thread = this.state.thread;
        if (
            thread?.model !== "crm.lead" ||
            !thread.id ||
            ev.detail?.model !== thread.model ||
            ev.detail?.id !== thread.id ||
            !this.crmOfflinePlugin.isOffline()
        ) {
            return;
        }
        this.crmRememberLoad(thread, ["messages", ...this.requestList]);
        ev.stopImmediatePropagation();
    },
});

/**
 * A lead chatter's attachment dropzones render nothing offline (template extension
 * in `crm_mobile_pipeline.xml`), also when one is shown as the connection drops: a
 * file dropped on the chatter saves no new lead and uploads nothing. Scoped to lead
 * chatters by the root the dropzone is placed on, checked before the offline signal
 * is read; every other dropzone is mail's.
 */
patch(MailAttachmentDropzone.prototype, {
    get crmOfflineInert() {
        return Boolean(LEAD_CHATTERS_BY_DROPZONE_REF.get(this.props.ref)?.crmOfflineReadOnly);
    },
});

/**
 * A lead chatter's message list loads its older (or newer) messages when their
 * "Load More" control comes into view, without a click the framework could
 * disable. Offline it loads none, so the messages already shown stay without a
 * loading error, and the control loads them once online. Its handlers that fetch
 * messages (load older, retry, and a jump to the present that reloads the newest
 * page) fetch nothing offline either, even when called directly. Scoped to lead
 * chatters, checked before the offline signal is read; other threads, and every
 * online call, go to the original code.
 */
patch(Thread.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** Scope first (lead chatter thread), then the offline signal. */
    get crmOfflineReadOnly() {
        return Boolean(
            this.env.inChatter &&
                this.props.thread.model === "crm.lead" &&
                this.crmOfflinePlugin.isOffline()
        );
    },

    /** @override */
    get shouldTriggerLoadOnVisible() {
        if (this.crmOfflineReadOnly) {
            return false;
        }
        return super.shouldTriggerLoadOnVisible;
    },

    /** @override */
    onClickLoadOlder() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickLoadOlder(...arguments);
    },

    /** @override */
    onClickRetry() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickRetry(...arguments);
    },

    /**
     * @override
     * Offline, a jump that would reload the newest messages does nothing (the
     * messages shown, the highlight and the scroll position stay); an immediate
     * jump with no newer messages to load only scrolls, as online.
     */
    async jumpToPresent({ immediate = false } = {}) {
        if (this.crmOfflineReadOnly && (!immediate || this.props.thread.loadNewer)) {
            return;
        }
        return super.jumpToPresent(...arguments);
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

/**
 * Offline, a lead's followers can be neither changed nor looked up. The followers
 * menu items are not buttons, so the framework leaves them active: the chatter
 * closes the menu when the connection drops, and these handlers, reached from its
 * items, from a subtype dialog opened online or by a direct call, return before
 * any follow, unfollow, subscription or partner request, wizard or dialog. Scoped
 * to lead threads, checked before the offline signal is read; other threads, and
 * every online call, go to the original code.
 */
patch(FollowerList.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** Scope first (lead thread), then the offline signal. */
    get crmOfflineReadOnly() {
        return this.props.thread?.model === "crm.lead" && this.crmOfflinePlugin.isOffline();
    },

    /** @override */
    onClickAddFollowers() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickAddFollowers(...arguments);
    },

    /** @override */
    async onClickFollow() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickFollow(...arguments);
    },

    /** @override */
    async onClickUnfollow() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickUnfollow(...arguments);
    },

    /** @override */
    async onClickEdit() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickEdit(...arguments);
    },
});

patch(Follower.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** Scope first (lead thread), then the offline signal. */
    get crmOfflineReadOnly() {
        return (
            this.props.follower.thread?.model === "crm.lead" && this.crmOfflinePlugin.isOffline()
        );
    },

    /** @override */
    onClickDetails(ev) {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickDetails(...arguments);
    },

    /** @override */
    async onClickEdit() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickEdit(...arguments);
    },

    /** @override */
    async onClickRemove() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickRemove(...arguments);
    },
});

patch(FollowerSubtypeDialog.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOfflinePlugin = usePlugin(OfflinePlugin);
    },

    /** Scope first (lead thread), then the offline signal. */
    get crmOfflineReadOnly() {
        return (
            this.props.follower.thread?.model === "crm.lead" && this.crmOfflinePlugin.isOffline()
        );
    },

    /**
     * @override
     * Offline the dialog stays open, so its choices can still be applied online.
     */
    async onClickApply() {
        if (this.crmOfflineReadOnly) {
            return;
        }
        return super.onClickApply(...arguments);
    },
});
